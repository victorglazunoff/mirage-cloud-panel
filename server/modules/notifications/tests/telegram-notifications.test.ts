import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, telegramLinkDb } from '@/modules/database/index.js';
import type { TelegramLinkRow } from '@/modules/database/index.js';
import type { CalendarItem, MirageSettings, ProviderPermissionDecision, ProviderRuntimeEvent, ProviderRuntimeEventListener, TelegramUpdate } from '@/shared/types.js';

import { TELEGRAM_REPLY } from '../services/telegram-link.service.js';
import { isWithinQuietHours } from '../services/telegram-notifier.service.js';
import { createTelegramNotificationsService } from '../services/telegram-notifications.service.js';

const FAKE_TOKEN = 'test-token-not-real';
const OWNER_CHAT = { id: 1001, type: 'private', username: 'owner', first_name: 'Иван' };
const STRANGER_CHAT = { id: 2002, type: 'private', username: 'stranger' };

type BotCall = { method: string; body: Record<string, any>; url: string };

function createMemoryLinkStore() {
  let link: TelegramLinkRow | null = null;
  const codes = new Map<string, { expiresAt: number; usedAt: number | null }>();
  return {
    getLink: () => link,
    saveLink: (row: TelegramLinkRow) => { link = row; },
    clearLink: () => { const had = Boolean(link); link = null; return had; },
    createCode: (hash: string, _createdAt: number, expiresAt: number) => { codes.set(hash, { expiresAt, usedAt: null }); },
    consumeCode: (hash: string, now: number) => {
      const code = codes.get(hash);
      if (!code || code.usedAt !== null || code.expiresAt <= now) return false;
      code.usedAt = now;
      return true;
    },
    clearCodes: () => codes.clear(),
  };
}

function defaultSettings(): MirageSettings['notifications'] {
  return {
    channels: { telegram: true, max: false, browser: true },
    events: { turnComplete: false, backgroundDone: false, approvalNeeded: true, limit80: false },
    quietHours: { enabled: false, from: '23:00', to: '08:00' },
  };
}

/** Builds the service over fakes: Bot API via a substituted fetch, manual timers and clock. */
function createHarness(options: { env?: Record<string, string>; settings?: MirageSettings['notifications'] } = {}) {
  const calls: BotCall[] = [];
  const pendingUpdates: TelegramUpdate[][] = [];
  let nextMessageId = 500;
  const fetchImpl = async (url: string, init: RequestInit) => {
    const method = url.split('/').pop() ?? '';
    const body = JSON.parse(String(init.body ?? '{}'));
    calls.push({ method, body, url });
    let result: unknown = true;
    if (method === 'getMe') result = { username: 'example_bot' };
    if (method === 'sendMessage') result = { message_id: nextMessageId++ };
    if (method === 'getUpdates') {
      const batch = pendingUpdates.shift();
      if (!batch) {
        // Park until aborted, like a long poll with nothing to say.
        await new Promise<void>((resolve) => init.signal?.addEventListener('abort', () => resolve(), { once: true }));
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      result = batch;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };

  const state = {
    now: Date.parse('2026-10-26T10:00:00Z'),
    settings: options.settings ?? defaultSettings(),
    timers: [] as Array<{ callback: () => void; delayMs: number; cancelled: boolean }>,
    resolved: [] as Array<{ requestId: string; decision: ProviderPermissionDecision }>,
    runtimeListeners: new Set<ProviderRuntimeEventListener>(),
    eventTaps: new Set<(payload: { userId: number | null; event: Record<string, any> }) => void>(),
    config: new Map<string, string>(),
    reminders: [] as CalendarItem[],
    reminderQueries: [] as Array<{ fromMs: number; toMs: number; timeZone: string }>,
    limits: { status: 'ok', session: null as { percent: number; resetsAt: string | null } | null, weekly: null as { percent: number; resetsAt: string | null } | null },
  };
  const linkStore = createMemoryLinkStore();

  const service = createTelegramNotificationsService({
    env: { MIRAGE_TELEGRAM_BOT_TOKEN: FAKE_TOKEN, MIRAGE_TIMEZONE: 'Asia/Yekaterinburg', MIRAGE_TIMEZONE_LABEL: 'ЕКБ', ...(options.env ?? {}) },
    fetchImpl,
    linkStore,
    readConfig: (key) => state.config.get(key) ?? null,
    writeConfig: (key, value) => { state.config.set(key, value); },
    getSettings: async () => state.settings,
    getLimits: async () => state.limits,
    listCalendarReminders: (fromMs, toMs, timeZone) => {
      state.reminderQueries.push({ fromMs, toMs, timeZone });
      return state.reminders.filter((item) => Date.parse(item.startsAt) >= fromMs && Date.parse(item.startsAt) < toMs);
    },
    resolveToolApproval: (requestId, decision) => {
      state.resolved.push({ requestId, decision });
      // The runtime publishes the settlement synchronously, like the real one.
      for (const listener of state.runtimeListeners) {
        listener({ type: 'permission_settled', provider: 'claude', sessionId: 's1', runId: 'r1', requestId, outcome: decision.allow ? 'allowed' : 'denied', at: state.now });
      }
    },
    subscribeRuntimeEvents: (listener) => { state.runtimeListeners.add(listener); return () => state.runtimeListeners.delete(listener); },
    addEventTap: (listener) => { state.eventTaps.add(listener); return () => state.eventTaps.delete(listener); },
    describeSession: () => ({ projectName: 'Сайт клиента', sessionName: 'Выкладка цен', panelPath: '/p/p1/s/s1' }),
    now: () => state.now,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      state.timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    sleep: async () => {},
    longPollSec: 1,
  });

  const emitRuntime = (event: ProviderRuntimeEvent) => {
    for (const listener of state.runtimeListeners) listener(event);
  };
  const emitNotification = (event: Record<string, any>) => {
    for (const tap of state.eventTaps) tap({ userId: 1, event });
  };
  const runTimers = async () => {
    const due = state.timers.splice(0).filter((timer) => !timer.cancelled);
    for (const timer of due) timer.callback();
    await flush();
  };
  const sent = (method = 'sendMessage') => calls.filter((call) => call.method === method);
  const linkOwner = async () => {
    const issued = await service.issueLinkCode();
    await service.handleUpdate({ update_id: 1, message: { message_id: 1, chat: OWNER_CHAT, text: `/start ${issued.code}` } });
    calls.length = 0;
  };

  return { service, state, calls, pendingUpdates, linkStore, emitRuntime, emitNotification, runTimers, sent, linkOwner };
}

/** Lets fire-and-forget promises (event handlers) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function permissionRequested(requestId: string): ProviderRuntimeEvent {
  return {
    type: 'permission_requested', provider: 'claude', sessionId: 's1', runId: 'r1', requestId,
    toolName: 'Bash', input: { command: 'deploy.sh --prod demo-site.example' }, toolUseId: null, agentId: null, at: 0,
  };
}

test('without a token the bot is off: status says not configured and no link code is issued', async () => {
  const harness = createHarness({ env: { MIRAGE_TELEGRAM_BOT_TOKEN: '' } });
  const status = await harness.service.getStatus();
  assert.deepEqual(
    { configured: status.configured, polling: status.polling, linked: status.linked, botUsername: status.botUsername },
    { configured: false, polling: false, linked: false, botUsername: null },
  );
  await assert.rejects(harness.service.issueLinkCode(), { code: 'TELEGRAM_NOT_CONFIGURED' });
  harness.service.start();
  assert.equal(harness.state.runtimeListeners.size, 0);
  assert.equal(harness.calls.length, 0);
});

test('polling starts only with MIRAGE_TELEGRAM_POLLING=1 and stops cleanly', async () => {
  const quiet = createHarness();
  quiet.service.start();
  await flush();
  assert.equal((await quiet.service.getStatus()).polling, false);
  assert.equal(quiet.sent('getUpdates').length, 0);
  await quiet.service.stop();

  const polling = createHarness({ env: { MIRAGE_TELEGRAM_POLLING: '1' } });
  polling.pendingUpdates.push([{ update_id: 41, message: { message_id: 1, chat: STRANGER_CHAT, text: 'привет' } }]);
  polling.service.start();
  await flush();
  assert.equal((await polling.service.getStatus()).polling, true);
  // The update was handled and the offset stored past it.
  assert.equal(polling.state.config.get('mirage_telegram_update_offset'), '42');
  assert.equal(polling.sent().at(-1)?.body.text, TELEGRAM_REPLY.needCode);
  await polling.service.stop();
  assert.equal((await polling.service.getStatus()).polling, false);
});

test('the token never leaves the Bot API URL', async () => {
  const harness = createHarness();
  const status = await harness.service.getStatus();
  const issued = await harness.service.issueLinkCode();
  assert.equal(JSON.stringify(status).includes(FAKE_TOKEN), false);
  assert.equal(JSON.stringify(issued).includes(FAKE_TOKEN), false);
  assert.ok(harness.calls.every((call) => !JSON.stringify(call.body).includes(FAKE_TOKEN)));
});

test('linking: a one-time code from the panel links the chat that sends /start <code>', async () => {
  const harness = createHarness();
  const issued = await harness.service.issueLinkCode();
  assert.match(issued.code, /^[A-Za-z0-9_-]{22,}$/);
  assert.equal(issued.url, `https://t.me/example_bot?start=${issued.code}`);
  assert.equal(issued.botUsername, 'example_bot');

  await harness.service.handleUpdate({ update_id: 1, message: { message_id: 1, chat: OWNER_CHAT, text: `/start ${issued.code}` } });
  assert.equal(harness.sent().at(-1)?.body.chat_id, String(OWNER_CHAT.id));
  assert.equal(harness.sent().at(-1)?.body.text, TELEGRAM_REPLY.linked);

  const status = await harness.service.getStatus();
  assert.equal(status.linked, true);
  assert.equal(status.linkSource, 'bot');
  assert.deepEqual(status.chat, { username: 'owner', title: 'Иван' });

  // While linked no new code is issued (re-link goes through «Отвязать»).
  await assert.rejects(harness.service.issueLinkCode(), { code: 'TELEGRAM_ALREADY_LINKED' });
  assert.equal(harness.service.unlink(), true);
  assert.equal((await harness.service.getStatus()).linked, false);
});

test('linking: a code works once and expires after 15 minutes; /start without a code asks for one', async () => {
  const harness = createHarness();
  const first = await harness.service.issueLinkCode();

  await harness.service.handleUpdate({ update_id: 1, message: { message_id: 1, chat: STRANGER_CHAT, text: '/start' } });
  assert.equal(harness.sent().at(-1)?.body.text, TELEGRAM_REPLY.needCode);
  await harness.service.handleUpdate({ update_id: 2, message: { message_id: 2, chat: STRANGER_CHAT, text: '/start wrong-code' } });
  assert.equal(harness.sent().at(-1)?.body.text, TELEGRAM_REPLY.codeRejected);

  harness.state.now += 15 * 60_000 + 1;
  await harness.service.handleUpdate({ update_id: 3, message: { message_id: 3, chat: OWNER_CHAT, text: `/start ${first.code}` } });
  assert.equal(harness.sent().at(-1)?.body.text, TELEGRAM_REPLY.codeRejected);
  assert.equal((await harness.service.getStatus()).linked, false);

  const second = await harness.service.issueLinkCode();
  await harness.service.handleUpdate({ update_id: 4, message: { message_id: 4, chat: OWNER_CHAT, text: `/start ${second.code}` } });
  assert.equal(harness.sent().at(-1)?.body.text, TELEGRAM_REPLY.linked);
  harness.service.unlink();
  // Used once: replaying it after an unlink does not link again.
  await harness.service.handleUpdate({ update_id: 5, message: { message_id: 5, chat: STRANGER_CHAT, text: `/start ${second.code}` } });
  assert.equal(harness.sent().at(-1)?.body.text, TELEGRAM_REPLY.codeRejected);
});

test('once linked, every other chat hears «нет доступа» and its button presses are refused', async () => {
  const harness = createHarness();
  harness.service.start();
  await harness.linkOwner();
  await harness.service.handleUpdate({ update_id: 2, message: { message_id: 2, chat: STRANGER_CHAT, text: '/start anything' } });
  assert.equal(harness.sent().at(-1)?.body.chat_id, String(STRANGER_CHAT.id));
  assert.equal(harness.sent().at(-1)?.body.text, TELEGRAM_REPLY.noAccess);

  harness.emitRuntime(permissionRequested('req-1'));
  await harness.runTimers();
  const keyboard = harness.sent().at(-1)?.body.reply_markup.inline_keyboard;
  const allowData = keyboard[0][0].callback_data as string;
  await harness.service.handleUpdate({
    update_id: 3,
    callback_query: { id: 'cb-1', data: allowData, from: { id: STRANGER_CHAT.id }, message: { message_id: 9, chat: STRANGER_CHAT } },
  });
  assert.equal(harness.state.resolved.length, 0);
  assert.equal(harness.sent('answerCallbackQuery').at(-1)?.body.text, 'Нет доступа');
  await harness.service.stop();
});

test('approval: sent after 2 minutes unanswered, «Разрешить один раз» resolves it and edits the message', async () => {
  const harness = createHarness({ env: { MIRAGE_PANEL_PUBLIC_URL: 'https://panel.example' } });
  harness.service.start();
  await harness.linkOwner();

  harness.emitRuntime(permissionRequested('req-1'));
  assert.equal(harness.state.timers[0]?.delayMs, 2 * 60_000);
  assert.equal(harness.sent().length, 0);
  harness.state.now += 2 * 60_000;
  await harness.runTimers();

  const message = harness.sent().at(-1)!;
  assert.match(message.body.text, /^◆ Сайт клиента ждёт тебя\nBash: deploy\.sh --prod demo-site\.example\nВыкладка цен · ждёт 2 мин$/);
  const keyboard = message.body.reply_markup.inline_keyboard;
  assert.equal(keyboard[0][0].text, 'Разрешить один раз');
  assert.equal(keyboard[0][1].text, 'Отклонить');
  assert.deepEqual(keyboard[1][0], { text: 'Открыть в панели', url: 'https://panel.example/p/p1/s/s1' });
  assert.ok(Buffer.byteLength(keyboard[0][0].callback_data) <= 64);

  await harness.service.handleUpdate({
    update_id: 2,
    callback_query: { id: 'cb-1', data: keyboard[0][0].callback_data, from: { id: OWNER_CHAT.id }, message: { message_id: 500, chat: OWNER_CHAT } },
  });
  assert.deepEqual(harness.state.resolved, [{ requestId: 'req-1', decision: { allow: true } }]);
  assert.equal(harness.sent('answerCallbackQuery').at(-1)?.body.text, 'Разрешено');
  const edits = harness.sent('editMessageText');
  assert.equal(edits.length, 1, 'the synchronous settlement must not add a second «не актуально» edit');
  assert.match(edits[0].body.text, /✓ разрешено из Telegram · \d{2}:\d{2}$/);
  assert.deepEqual(edits[0].body.reply_markup.inline_keyboard, []);

  // A second press on the same (now answered) message.
  await harness.service.handleUpdate({
    update_id: 3,
    callback_query: { id: 'cb-2', data: keyboard[0][1].callback_data, from: { id: OWNER_CHAT.id }, message: { message_id: 500, chat: OWNER_CHAT } },
  });
  assert.equal(harness.state.resolved.length, 1);
  assert.equal(harness.sent('answerCallbackQuery').at(-1)?.body.text, 'Уже не актуально');
  await harness.service.stop();
});

test('approval: a failure while preparing the delayed message is logged, not left unhandled', async () => {
  const harness = createHarness();
  harness.service.start();
  await harness.linkOwner();
  harness.emitRuntime(permissionRequested('req-broken'));

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    Object.defineProperty(harness.state, 'settings', { get: () => { throw new Error('settings unreadable'); } });
    harness.state.now += 2 * 60_000;
    await harness.runTimers();
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    console.warn = originalWarn;
  }
  assert.deepEqual(unhandled, []);
  assert.equal(harness.sent().length, 0);
  await harness.service.stop();
});

test('approval: «Отклонить» denies; an answer in the panel cancels the message or marks it stale', async () => {
  const harness = createHarness();
  harness.service.start();
  await harness.linkOwner();

  harness.emitRuntime(permissionRequested('req-deny'));
  await harness.runTimers();
  const denyData = harness.sent().at(-1)!.body.reply_markup.inline_keyboard[0][1].callback_data;
  await harness.service.handleUpdate({
    update_id: 2,
    callback_query: { id: 'cb', data: denyData, from: { id: OWNER_CHAT.id }, message: { message_id: 500, chat: OWNER_CHAT } },
  });
  assert.deepEqual(harness.state.resolved.at(-1), { requestId: 'req-deny', decision: { allow: false, message: 'Отклонено из Telegram' } });
  assert.match(harness.sent('editMessageText').at(-1)!.body.text, /✕ отклонено из Telegram/);

  // Answered in the panel before 2 minutes: nothing is sent.
  const before = harness.sent().length;
  harness.emitRuntime(permissionRequested('req-panel'));
  harness.emitRuntime({ type: 'permission_settled', provider: 'claude', sessionId: 's1', runId: 'r1', requestId: 'req-panel', outcome: 'allowed', at: 0 });
  await harness.runTimers();
  assert.equal(harness.sent().length, before);

  // Answered in the panel after the message went out: the message says so.
  harness.emitRuntime(permissionRequested('req-late'));
  await harness.runTimers();
  harness.emitRuntime({ type: 'permission_settled', provider: 'claude', sessionId: 's1', runId: 'r1', requestId: 'req-late', outcome: 'cancelled', at: 0 });
  await flush();
  assert.match(harness.sent('editMessageText').at(-1)!.body.text, /— уже не актуально$/);

  // A button from before a restart (unknown id).
  await harness.service.handleUpdate({
    update_id: 3,
    callback_query: { id: 'cb-old', data: 'ok:unknown', from: { id: OWNER_CHAT.id }, message: { message_id: 77, chat: OWNER_CHAT } },
  });
  assert.equal(harness.sent('answerCallbackQuery').at(-1)?.body.text, 'Уже не актуально');
  await harness.service.stop();
});

test('quiet hours mute everything except approvals', async () => {
  const settings = defaultSettings();
  settings.events = { turnComplete: true, backgroundDone: true, approvalNeeded: true, limit80: true };
  settings.quietHours = { enabled: true, from: '23:00', to: '08:00' };
  const harness = createHarness({ settings });
  harness.service.start();
  await harness.linkOwner();
  // 02:00 in Yekaterinburg (UTC+5).
  harness.state.now = Date.parse('2026-10-25T21:00:00Z');

  harness.emitNotification({ provider: 'claude', sessionId: 's1', code: 'run.background_completed', meta: {} });
  harness.state.limits = { status: 'ok', session: null, weekly: { percent: 85, resetsAt: '2026-10-29T00:00:00Z' } };
  await harness.service.checkLimits();
  await flush();
  assert.equal(harness.sent().length, 0);

  harness.emitRuntime(permissionRequested('req-night'));
  await harness.runTimers();
  assert.equal(harness.sent().length, 1);
  assert.match(harness.sent()[0].body.text, /ждёт тебя/);

  // After quiet hours the still-crossed limit is reported (it was not remembered while muted).
  harness.state.now = Date.parse('2026-10-26T05:00:00Z');
  await harness.service.checkLimits();
  assert.match(harness.sent().at(-1)!.body.text, /^▲ Неделя: 85 % лимита\nсброс /);
  await harness.service.stop();
});

test('a switched-off limits counter never sends a limit message', async () => {
  const settings = defaultSettings();
  settings.events = { turnComplete: true, backgroundDone: true, approvalNeeded: true, limit80: true };
  const harness = createHarness({ settings });
  await harness.linkOwner();
  const before = harness.sent().length;
  harness.state.limits = { status: 'disabled', session: null, weekly: { percent: 95, resetsAt: '2026-10-29T00:00:00Z' } };
  await harness.service.checkLimits();
  assert.equal(harness.sent().length, before);
});

test('quiet hours window math', () => {
  const quiet = { enabled: true, from: '23:00', to: '08:00' };
  const zone = 'Asia/Yekaterinburg';
  assert.equal(isWithinQuietHours(quiet, Date.parse('2026-10-26T18:30:00Z'), zone), true); // 23:30
  assert.equal(isWithinQuietHours(quiet, Date.parse('2026-10-26T02:59:00Z'), zone), true); // 07:59
  assert.equal(isWithinQuietHours(quiet, Date.parse('2026-10-26T03:00:00Z'), zone), false); // 08:00
  assert.equal(isWithinQuietHours({ ...quiet, enabled: false }, Date.parse('2026-10-26T18:30:00Z'), zone), false);
  assert.equal(isWithinQuietHours({ enabled: true, from: '13:00', to: '14:00' }, Date.parse('2026-10-26T08:30:00Z'), zone), true);
});

test('event switches: turn and background messages follow notifications.events and the channel', async () => {
  const harness = createHarness();
  harness.service.start();
  await harness.linkOwner();

  // Defaults: turnComplete and backgroundDone are off.
  harness.emitNotification({ provider: 'claude', sessionId: 's1', code: 'run.stopped', meta: { stopReason: 'completed' } });
  harness.emitNotification({ provider: 'claude', sessionId: 's2', code: 'run.background_completed', meta: {} });
  await flush();
  assert.equal(harness.sent().length, 0);

  harness.state.settings.events.turnComplete = true;
  harness.state.settings.events.backgroundDone = true;
  // A short turn (2 min) is not reported; a long one (7 min) is.
  harness.emitRuntime({ type: 'sdk_message', provider: 'claude', sessionId: 's3', runId: 'r', providerSessionId: null, message: { type: 'result', duration_ms: 120_000 }, normalized: [], at: 0 });
  harness.emitNotification({ provider: 'claude', sessionId: 's3', code: 'run.stopped', meta: { stopReason: 'completed' } });
  harness.emitRuntime({ type: 'sdk_message', provider: 'claude', sessionId: 's4', runId: 'r', providerSessionId: null, message: { type: 'result', duration_ms: 420_000 }, normalized: [], at: 0 });
  harness.emitNotification({ provider: 'claude', sessionId: 's4', code: 'run.stopped', meta: { stopReason: 'completed' } });
  harness.emitNotification({ provider: 'claude', sessionId: 's4', code: 'run.stopped', meta: { stopReason: 'aborted' } });
  harness.emitNotification({ provider: 'claude', sessionId: 's5', code: 'run.background_completed', meta: {} });
  await flush();
  const texts = harness.sent().map((call) => call.body.text);
  assert.deepEqual(texts, [
    '✓ Сайт клиента — ход закончен\nВыкладка цен · 7 мин',
    '✓ Сайт клиента — готово\nФоновая работа завершена · Выкладка цен',
  ]);

  // Channel off: nothing at all, approvals included.
  harness.state.settings.channels.telegram = false;
  harness.emitNotification({ provider: 'claude', sessionId: 's6', code: 'run.background_completed', meta: {} });
  harness.emitRuntime(permissionRequested('req-off'));
  await harness.runTimers();
  assert.equal(harness.sent().length, 2);

  // Approval switch off.
  harness.state.settings.channels.telegram = true;
  harness.state.settings.events.approvalNeeded = false;
  harness.emitRuntime(permissionRequested('req-off-2'));
  await harness.runTimers();
  assert.equal(harness.sent().length, 2);
  await harness.service.stop();
});

test('a turn length is used once: the next turn of the session does not reuse it', async () => {
  const harness = createHarness();
  harness.service.start();
  await harness.linkOwner();
  harness.state.settings.events.turnComplete = true;

  harness.emitRuntime({ type: 'sdk_message', provider: 'claude', sessionId: 's1', runId: 'r', providerSessionId: null, message: { type: 'result', duration_ms: 600_000 }, normalized: [], at: 0 });
  harness.emitNotification({ provider: 'claude', sessionId: 's1', code: 'run.stopped', meta: { stopReason: 'completed' } });
  await flush();
  // The next turn ends without a result of its own (length unknown).
  harness.state.now += 60_000;
  harness.emitNotification({ provider: 'claude', sessionId: 's1', code: 'run.stopped', meta: { stopReason: 'completed' } });
  await flush();
  assert.deepEqual(harness.sent().map((call) => call.body.text), [
    '✓ Сайт клиента — ход закончен\nВыкладка цен · 10 мин',
    '✓ Сайт клиента — ход закончен\nВыкладка цен',
  ]);
  await harness.service.stop();
});

test('approval: a request never settled is forgotten after a day, its buttons say «не актуально»', async () => {
  const harness = createHarness();
  harness.service.start();
  await harness.linkOwner();

  harness.emitRuntime(permissionRequested('req-old'));
  harness.state.now += 2 * 60_000;
  await harness.runTimers();
  const keyboard = harness.sent().at(-1)!.body.reply_markup.inline_keyboard;

  // A day later (the run died without a settlement), any permission event sweeps it.
  harness.state.now += 24 * 60 * 60_000 + 1;
  harness.emitRuntime({ type: 'permission_settled', provider: 'claude', sessionId: 's2', runId: 'r2', requestId: 'req-other', outcome: 'allowed', at: 0 });
  await harness.service.handleUpdate({
    update_id: 2,
    callback_query: { id: 'cb-old', data: keyboard[0][0].callback_data, from: { id: OWNER_CHAT.id }, message: { message_id: 500, chat: OWNER_CHAT } },
  });
  assert.deepEqual(harness.state.resolved, []);
  assert.equal(harness.sent('answerCallbackQuery').at(-1)?.body.text, 'Уже не актуально');
  await harness.service.stop();
});

test('limits: one message per window and threshold, only when the switch is on', async () => {
  const harness = createHarness();
  await harness.linkOwner();
  harness.state.limits = { status: 'ok', session: null, weekly: { percent: 82, resetsAt: '2026-10-26T12:00:00Z' } };

  await harness.service.checkLimits();
  assert.equal(harness.sent().length, 0, 'limit80 is off by default');

  harness.state.settings.events.limit80 = true;
  await harness.service.checkLimits();
  await harness.service.checkLimits();
  assert.equal(harness.sent().length, 1);
  assert.match(harness.sent()[0].body.text, /^▲ Неделя: 82 % лимита\nсброс .+ 17:00$/);

  harness.state.limits.weekly = { percent: 100, resetsAt: '2026-10-26T12:00:00Z' };
  await harness.service.checkLimits();
  assert.equal(harness.sent().at(-1)!.body.text.split('\n')[0], '▲ Неделя: лимит исчерпан');

  // A new window (new reset time) is reported again.
  harness.state.limits.weekly = { percent: 81, resetsAt: '2026-11-02T12:00:00Z' };
  await harness.service.checkLimits();
  assert.equal(harness.sent().length, 3);
});

test('limits: the 5-hour window is never reported, even when the upstream sends it full', async () => {
  const harness = createHarness();
  await harness.linkOwner();
  harness.state.settings.events.limit80 = true;
  harness.state.limits = { status: 'ok', session: { percent: 100, resetsAt: '2026-10-26T12:00:00Z' }, weekly: { percent: 40, resetsAt: null } };
  await harness.service.checkLimits();
  assert.equal(harness.sent().length, 0);
});

test('limits: the same window with a drifting reset moment is not re-sent', async () => {
  const harness = createHarness();
  await harness.linkOwner();
  harness.state.settings.events.limit80 = true;
  // The usage API returns the same reset with different fractions of a second on every poll.
  for (const resetsAt of ['2026-10-29T00:00:00.248197+00:00', '2026-10-29T00:00:00.459055+00:00', '2026-10-28T23:59:59.9+00:00']) {
    harness.state.limits = { status: 'ok', session: null, weekly: { percent: 80, resetsAt } };
    await harness.service.checkLimits();
  }
  assert.equal(harness.sent().length, 1);
});

test('test message goes to the linked chat and fails clearly when nothing is linked', async () => {
  const harness = createHarness();
  await assert.rejects(harness.service.sendTest(), { code: 'TELEGRAM_NOT_LINKED' });
  await harness.linkOwner();
  await harness.service.sendTest();
  assert.equal(harness.sent().at(-1)?.body.chat_id, String(OWNER_CHAT.id));
});

test('MIRAGE_TELEGRAM_CHAT_ID is only a fallback while no chat is linked through the bot', async () => {
  const harness = createHarness({ env: { MIRAGE_TELEGRAM_CHAT_ID: '777' } });
  let status = await harness.service.getStatus();
  assert.equal(status.linked, true);
  assert.equal(status.linkSource, 'env');
  await harness.service.sendTest();
  assert.equal(harness.sent().at(-1)?.body.chat_id, '777');

  const issued = await harness.service.issueLinkCode();
  await harness.service.handleUpdate({ update_id: 1, message: { message_id: 1, chat: OWNER_CHAT, text: `/start ${issued.code}` } });
  status = await harness.service.getStatus();
  assert.equal(status.linkSource, 'bot');
  await harness.service.sendTest();
  assert.equal(harness.sent().at(-1)?.body.chat_id, String(OWNER_CHAT.id));
});

function calendarItem(overrides: Partial<CalendarItem> = {}): CalendarItem {
  return {
    id: 'ev-call',
    source: 'panel',
    type: 'call',
    title: 'Иван — про сайт',
    startsAt: '2026-10-26T10:15:00.000Z',
    endsAt: '2026-10-26T10:45:00.000Z',
    projectId: 'p1',
    projectName: 'DemoVilla',
    contact: { name: 'Иван', phone: '+7 900 000-00-00', telegram: null },
    location: null,
    note: null,
    remindBeforeMin: 15,
    status: 'planned',
    sessionId: null,
    recurrence: null,
    occurrenceOf: null,
    readOnly: false,
    preparedAt: null,
    allDay: false,
    google: null,
    agent: null,
    server: null,
    ...overrides,
  };
}

test('calendar reminders: sent once when due, in the panel zone, with a link to the calendar', async () => {
  const harness = createHarness({ env: { MIRAGE_PANEL_PUBLIC_URL: 'https://panel.example' } });
  await harness.linkOwner();
  // 10:00 UTC = 15:00 ЕКБ; the call is at 15:15 ЕКБ with a 15-minute reminder — due right now.
  harness.state.reminders = [
    calendarItem(),
    calendarItem({ id: 'ev-later', startsAt: '2026-10-26T11:00:00.000Z', remindBeforeMin: 30 }),
    calendarItem({ id: 'ev-done', status: 'done' }),
  ];

  assert.equal(await harness.service.checkCalendarReminders(), 1);
  const [message] = harness.sent();
  assert.equal(message.body.chat_id, String(OWNER_CHAT.id));
  assert.equal(message.body.text, '⏰ Через 15 мин · 15:15 ЕКБ\nЗвонок: Иван — про сайт\nИван · +7 900 000-00-00\nпроект DemoVilla');
  assert.equal(message.body.reply_markup.inline_keyboard[0][0].url, 'https://panel.example/calendar?event=ev-call&date=2026-10-26');
  assert.equal(harness.state.reminderQueries[0].timeZone, 'Asia/Yekaterinburg');

  // The next minute: no duplicate, even after a restart (the sent keys live in the config store).
  harness.state.now += 60_000;
  assert.equal(await harness.service.checkCalendarReminders(), 0);
  assert.equal(harness.sent().length, 1);

  // 10:30 UTC: the 11:00 event's 30-minute reminder is due.
  harness.state.now = Date.parse('2026-10-26T10:30:00Z');
  assert.equal(await harness.service.checkCalendarReminders(), 1);
  assert.match(harness.sent().at(-1)?.body.text ?? '', /^⏰ Через 30 мин · 16:00 ЕКБ/);
});

test('calendar reminders: without MIRAGE_TIMEZONE_LABEL the time is captioned with the UTC offset', async () => {
  const harness = createHarness({ env: { MIRAGE_TIMEZONE_LABEL: '' } });
  await harness.linkOwner();
  harness.state.reminders = [calendarItem()];

  assert.equal(await harness.service.checkCalendarReminders(), 1);
  assert.match(harness.sent()[0].body.text, /^⏰ Через 15 мин · 15:15 UTC\+5\nЗвонок:/);
});

test('calendar reminders: a moved event is reminded again; long-overdue and past ones are skipped', async () => {
  const harness = createHarness();
  await harness.linkOwner();
  harness.state.reminders = [calendarItem()];
  assert.equal(await harness.service.checkCalendarReminders(), 1);

  // Moved by five minutes: a new occurrence time is a new reminder.
  harness.state.reminders = [calendarItem({ startsAt: '2026-10-26T10:20:00.000Z' })];
  harness.state.now += 5 * 60_000;
  assert.equal(await harness.service.checkCalendarReminders(), 1);

  // Due 20 minutes ago (beyond the catch-up window): not sent.
  harness.state.reminders = [calendarItem({ id: 'ev-old', startsAt: new Date(harness.state.now + 10 * 60_000).toISOString(), remindBeforeMin: 30 })];
  assert.equal(await harness.service.checkCalendarReminders(), 0);
});

test('calendar reminders: silent without a linked chat or with the Telegram channel off; quiet hours do not mute them', async () => {
  const harness = createHarness();
  harness.state.reminders = [calendarItem()];
  assert.equal(await harness.service.checkCalendarReminders(), 0, 'no chat linked');

  await harness.linkOwner();
  harness.state.settings = { ...defaultSettings(), channels: { telegram: false, max: false, browser: true } };
  assert.equal(await harness.service.checkCalendarReminders(), 0, 'channel off');

  // 15:00 ЕКБ inside quiet hours 14:00–16:00: a reminder is an alarm and still goes out.
  harness.state.settings = { ...defaultSettings(), quietHours: { enabled: true, from: '14:00', to: '16:00' } };
  assert.equal(await harness.service.checkCalendarReminders(), 1);
});

test('telegramLinkDb: codes are single-use and expire; the link is one row', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'telegram-link-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    telegramLinkDb.createCode('hash-a', 1_000, 2_000);
    assert.equal(telegramLinkDb.consumeCode('hash-a', 2_000), false, 'expired at expires_at');
    telegramLinkDb.createCode('hash-b', 1_000, 5_000);
    assert.equal(telegramLinkDb.consumeCode('hash-b', 1_500), true);
    assert.equal(telegramLinkDb.consumeCode('hash-b', 1_600), false, 'single use');

    telegramLinkDb.saveLink({ chat_id: '1', chat_username: 'a', chat_title: null, linked_at: '2026-10-26T00:00:00Z' });
    telegramLinkDb.saveLink({ chat_id: '2', chat_username: 'b', chat_title: 'B', linked_at: '2026-10-26T00:01:00Z' });
    assert.equal(telegramLinkDb.getLink()?.chat_id, '2');
    assert.equal(telegramLinkDb.clearLink(), true);
    assert.equal(telegramLinkDb.getLink(), null);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
