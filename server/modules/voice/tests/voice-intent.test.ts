import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeechKitService } from '../speechkit.service.js';
import { parseIntentWithRules, parseSpokenTime } from '../voice-intent-rules.js';
import { createVoiceIntentService, isKnownTimeZone } from '../voice-intent.service.js';

// Tuesday 2026-10-27 10:00 local time.
const NOW = new Date(2026, 9, 27, 10, 0, 0);
const projects = [
  { projectId: 'p1', projectName: 'Мираж панель' },
  { projectId: 'p2', projectName: 'Карта участков' },
];

test('parseSpokenTime understands tomorrow with a clock time', () => {
  const result = parseSpokenTime('созвон завтра в 15:30', NOW);
  assert.ok(result.start?.startsWith('2026-10-28T15:30:00'));
});

test('parseSpokenTime understands weekdays, "в 3 часа дня" and relative offsets', () => {
  assert.ok(parseSpokenTime('в пятницу в 3 часа дня', NOW).start?.startsWith('2026-10-30T15:00'));
  assert.ok(parseSpokenTime('через 2 часа', NOW).start?.startsWith('2026-10-27T12:00'));
  assert.ok(parseSpokenTime('27 ноября в 9 утра', NOW).start?.startsWith('2026-11-27T09:00'));
  assert.equal(parseSpokenTime('просто текст', NOW).start, null);
});

test('rules: meeting with a person becomes a calendar event', () => {
  const [action] = parseIntentWithRules('Встреча с Иваном Петровым завтра в 15:00', projects, NOW);
  assert.equal(action.kind, 'calendar_event');
  if (action.kind !== 'calendar_event') return;
  assert.equal(action.eventType, 'meeting');
  assert.deepEqual(action.who, ['Иван Петров']);
  assert.ok(action.start?.startsWith('2026-10-28T15:00'));
});

test('rules: names after «с» go to the nominative case', () => {
  const who = (text: string) => {
    const [action] = parseIntentWithRules(text, projects, NOW);
    return action.kind === 'calendar_event' ? action.who : null;
  };
  assert.deepEqual(who('Встреча с Марией завтра в 15:00'), ['Мария']);
  assert.deepEqual(who('Созвон с Ольгой завтра в 15:00'), ['Ольга']);
  assert.deepEqual(who('Встреча с Андреем завтра в 15:00'), ['Андрей']);
  assert.deepEqual(who('Встреча с Иваном завтра в 15:00'), ['Иван']);
});

test('rules: the addressee after «позвонить / написать / напомнить» goes to the nominative case', () => {
  const who = (text: string) => {
    const [action] = parseIntentWithRules(text, projects, NOW);
    return action.kind === 'calendar_event' ? action.who : null;
  };
  assert.deepEqual(who('Позвонить Ивану завтра в 11'), ['Иван']);
  assert.deepEqual(who('Завтра в 10 позвонить Петру'), ['Пётр']);
  assert.deepEqual(who('Напомни написать Марии завтра в 15'), ['Мария']);
  assert.deepEqual(who('Напомнить Ольге про встречу завтра в 12'), ['Ольга']);
  assert.deepEqual(who('Позвони Андрею завтра в 9'), ['Андрей']);
});

test('rules: task for a project picks the project by its name', () => {
  const [action] = parseIntentWithRules('поставь задачу в проект карта участков починить брони', projects, NOW);
  assert.equal(action.kind, 'project_task');
  if (action.kind !== 'project_task') return;
  assert.equal(action.recipient?.projectId, 'p2');
});

test('rules: everything else is a plain message', () => {
  const [action] = parseIntentWithRules('а что с тестами?', projects, NOW);
  assert.equal(action.kind, 'message');
});

test('intent service uses the model answer when valid and drops unknown projects', async () => {
  const service = createVoiceIntentService({
    listRecipients: () => projects,
    askModel: async () => ({
      actions: [
        { kind: 'project_task', summary: 'Задача', text: 'починить', projectId: 'p1' },
        { kind: 'project_task', summary: 'Задача', text: 'ещё', projectId: 'нет-такого' },
        { kind: 'bogus' },
      ],
    }),
    now: () => NOW,
  });
  const response = await service.parse('что-то');
  assert.equal(response.source, 'claude');
  assert.equal(response.actions.length, 2);
  const [first, second] = response.actions;
  assert.equal(first.kind === 'project_task' && first.recipient?.projectId, 'p1');
  assert.equal(second.kind === 'project_task' && second.recipient, null);
  assert.equal(response.recipients.length, 2);
});

test('intent service falls back to rules when the model throws or answers garbage', async () => {
  for (const askModel of [async () => { throw new Error('offline'); }, async () => ({ nope: 1 }), async () => null]) {
    const service = createVoiceIntentService({ listRecipients: () => projects, askModel, now: () => NOW });
    const response = await service.parse('созвон завтра в 11');
    assert.equal(response.source, 'rules');
    assert.equal(response.actions[0].kind, 'calendar_event');
  }
});

test('the user zone reaches the model and the rule fallback: «завтра в 11» is 11:00 in Yekaterinburg', async () => {
  // 2026-10-26 09:32 UTC = 14:32 in Yekaterinburg (+05:00).
  const instant = new Date(Date.UTC(2026, 9, 26, 9, 32, 0));
  const seen: Array<{ nowIso: string; timeZone: string; offsetMinutes: number }> = [];
  const service = createVoiceIntentService({
    listRecipients: () => projects,
    askModel: async ({ nowIso, timeZone, offsetMinutes }) => {
      seen.push({ nowIso, timeZone, offsetMinutes });
      return null;
    },
    now: () => instant,
    defaultTimeZone: 'Asia/Yekaterinburg',
  });
  const response = await service.parse('созвон завтра в 11');
  assert.deepEqual(seen, [{ nowIso: '2026-10-26T14:32:00+05:00', timeZone: 'Asia/Yekaterinburg', offsetMinutes: 300 }]);
  const [action] = response.actions;
  assert.equal(action.kind, 'calendar_event');
  if (action.kind !== 'calendar_event') return;
  assert.equal(action.start, '2026-10-27T11:00:00+05:00');
  assert.equal(Date.parse(action.start ?? ''), Date.UTC(2026, 9, 27, 6, 0, 0));
});

test('a zone named by the request wins over the default; unknown zones are refused', async () => {
  assert.equal(isKnownTimeZone('Europe/Moscow'), true);
  assert.equal(isKnownTimeZone('Mars/Olympus'), false);
  assert.equal(isKnownTimeZone(42), false);
  const offsets: number[] = [];
  const service = createVoiceIntentService({
    listRecipients: () => projects,
    askModel: async ({ offsetMinutes }) => {
      offsets.push(offsetMinutes);
      return null;
    },
    now: () => new Date(Date.UTC(2026, 9, 26, 9, 0, 0)),
    defaultTimeZone: 'Asia/Yekaterinburg',
  });
  await service.parse('созвон завтра в 11', 'Europe/Moscow');
  assert.deepEqual(offsets, [180]);
});

test('speechkit: no key gives VOICE_NOT_CONFIGURED without touching the network', async () => {
  const service = createSpeechKitService({
    loadApiKey: async () => null,
    convertToPcm: async () => { throw new Error('should not run'); },
    fetchBackend: async () => { throw new Error('should not run'); },
  });
  const result = await service.transcribe({ bytes: Buffer.alloc(1), mimeType: 'audio/webm', fileName: 'a.webm' });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, 'VOICE_NOT_CONFIGURED');
  assert.equal(await service.isConfigured(), false);
});

test('speechkit: long audio is chunked and texts are joined; key goes in Authorization only', async () => {
  const calls: Array<{ url: string; auth: string; size: number }> = [];
  const service = createSpeechKitService({
    loadApiKey: async () => 'test-key',
    convertToPcm: async () => Buffer.alloc(16_000 * 2 * 40), // 40 s
    fetchBackend: async (url, options) => {
      calls.push({
        url,
        auth: (options.headers as Record<string, string>).Authorization,
        size: (options.body as Uint8Array).length,
      });
      return new Response(JSON.stringify({ result: `часть ${calls.length}` }), { status: 200 });
    },
  });
  const result = await service.transcribe({ bytes: Buffer.alloc(1), mimeType: 'audio/webm', fileName: 'a.webm' });
  assert.deepEqual(result, { ok: true, value: { text: 'часть 1 часть 2' } });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('lang=ru-RU') && calls[0].url.includes('format=lpcm'));
  assert.equal(calls[0].auth, 'Api-Key test-key');
  assert.equal(calls[0].size, 25 * 16_000 * 2);
});

test('speechkit: rejected key is reported without leaking it', async () => {
  const service = createSpeechKitService({
    loadApiKey: async () => 'secret-value',
    convertToPcm: async () => Buffer.alloc(16_000 * 2),
    fetchBackend: async () => new Response('denied', { status: 403 }),
  });
  const result = await service.transcribe({ bytes: Buffer.alloc(1), mimeType: 'audio/webm', fileName: 'a.webm' });
  assert.equal(!result.ok && result.code, 'VOICE_KEY_REJECTED');
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});
