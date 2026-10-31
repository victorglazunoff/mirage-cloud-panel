import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'vitest';

import { browserTimeZone, setPanelTimeZone } from '@/modules/kabina';
import {
  buildCardView,
  calendarTypeFor,
  defaultDestination,
  destinationLabel,
  formatTimer,
  markedWordIndexes,
  planDelivery,
  recognizedEntities,
} from '@/modules/kabina-voice/utils/voiceActionPlan';
import type { KabinaProjectRef, VoiceIntentAction } from '@/shared/types';

const PROJECTS: KabinaProjectRef[] = [
  { projectId: 'p-zag', displayName: 'Сайт клиента', path: '/home/user/demo-site', isStarred: true },
  { projectId: 'p-mir', displayName: 'Панель Мираж', path: '/home/user/mirage-panel', isStarred: false },
];

// Local wall time, so the formatting checks hold in any test zone: the panel zone (which
// the cards are written in) is set to the machine's own zone for these tests.
const START = new Date(2026, 9, 27, 11, 0, 0);
beforeAll(() => setPanelTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
afterAll(() => setPanelTimeZone(browserTimeZone()));

const CALL: VoiceIntentAction = {
  id: 'a1', kind: 'calendar_event', summary: 'Звонок', confidence: 0.9, title: 'Звонок — Андрей',
  eventType: 'call', start: START.toISOString(), end: null, whenText: 'завтра в 11', who: ['Андрей'],
};
const TASK: VoiceIntentAction = {
  id: 'a2', kind: 'project_task', summary: 'Подготовить план звонка', confidence: 0.7,
  text: 'Подготовь план звонка', recipient: { projectId: 'p-mir', projectName: 'Панель Мираж' }, candidates: [],
};
const MESSAGE: VoiceIntentAction = { id: 'a3', kind: 'message', summary: 'Проверь цены', confidence: 0.6, text: 'Проверь цены на сайте' };

const HOME = { sessionId: null, projectId: null };
const CHAT = { sessionId: 's-1', projectId: 'p-zag' };

test('the default addressee follows the rule: open chat → there, otherwise the main assistant', () => {
  assert.equal(defaultDestination(HOME), 'main');
  assert.equal(defaultDestination(CHAT), 'chat');
  assert.equal(destinationLabel('chat', CHAT, null, PROJECTS), 'Текущий диалог · Сайт клиента');
  assert.equal(destinationLabel('new', HOME, null, PROJECTS), 'Новый диалог в проекте…');
  assert.equal(destinationLabel('new', HOME, 'p-mir', PROJECTS), 'Новый диалог · Панель Мираж');
  assert.equal(destinationLabel('main', CHAT, null, PROJECTS), 'Главный ассистент');
});

test('calendar events always go to the calendar, and only with a time', () => {
  assert.deepEqual(planDelivery(CALL, 'chat', CHAT, null), { kind: 'calendar' });
  const noTime = planDelivery({ ...CALL, start: null }, 'main', HOME, null);
  assert.equal(noTime.kind, 'none');
});

test('tasks and messages follow the addressee', () => {
  assert.deepEqual(planDelivery(TASK, 'chat', CHAT, null), { kind: 'session', sessionId: 's-1', projectId: 'p-zag' });
  assert.equal(planDelivery(TASK, 'chat', HOME, null).kind, 'none', 'no open chat — nothing to fold into');
  assert.deepEqual(planDelivery(MESSAGE, 'new', HOME, 'p-zag'), { kind: 'new-session', projectId: 'p-zag' });
  assert.equal(planDelivery(MESSAGE, 'new', HOME, null).kind, 'none', 'a new dialog needs its project');
  // Main assistant: a task goes to its own project, a message to the open chat.
  assert.deepEqual(planDelivery(TASK, 'main', HOME, null), { kind: 'new-session', projectId: 'p-mir' });
  assert.deepEqual(planDelivery({ ...TASK, recipient: null }, 'main', CHAT, null), { kind: 'new-session', projectId: 'p-zag' });
  assert.equal(planDelivery({ ...TASK, recipient: null }, 'main', HOME, null).kind, 'none');
  assert.equal(planDelivery(MESSAGE, 'main', HOME, null).kind, 'none');
});

test('cards read like the mock-ups', () => {
  const call = buildCardView(CALL, 'main', HOME, null, PROJECTS);
  assert.equal(call.kicker, 'СОБЫТИЕ В КАЛЕНДАРЕ');
  assert.equal(call.whenBig, '11:00');
  assert.equal(call.whenSmall, 'вт 27 окт');
  assert.equal(call.meta, 'Андрей · напомню за 15 минут, в 10:45');
  assert.equal(call.whenChip, 'вт 27 окт · 11:00');
  assert.equal(call.runnable, true);

  const task = buildCardView(TASK, 'main', HOME, null, PROJECTS);
  assert.equal(task.kicker, 'ЗАДАЧА В ПРОЕКТ · ПАНЕЛЬ МИРАЖ');
  assert.equal(task.whenSmall, 'новый диалог · Панель Мираж');

  const stuck = buildCardView(MESSAGE, 'main', HOME, null, PROJECTS);
  assert.equal(stuck.runnable, false);
  assert.match(stuck.meta, /некуда отправить/);
});

test('recognised words are underlined and «уже распознал» lists what the parse found', () => {
  const phrase = 'Напомни завтра в 11 позвонить Андрей по поводу сайта';
  assert.deepEqual([...markedWordIndexes(phrase, [CALL])].sort((a, b) => a - b), [1, 3, 5]);
  const entities = recognizedEntities([CALL, TASK]).map((entity) => `${entity.label}:${entity.value}`);
  assert.deepEqual(entities, ['КОГДА:вт 27.10', 'ВРЕМЯ:11:00', 'ДЕЛО:звонок · Андрей', 'ЗАДАЧА:Подготовить план звонка']);
});

test('small helpers: timer and calendar type', () => {
  assert.equal(formatTimer(7_400), '0:07');
  assert.equal(formatTimer(60_000), '1:00');
  assert.equal(calendarTypeFor('call'), 'call');
  assert.equal(calendarTypeFor('reminder'), 'message');
  assert.equal(calendarTypeFor('task'), 'agent_task');
});
