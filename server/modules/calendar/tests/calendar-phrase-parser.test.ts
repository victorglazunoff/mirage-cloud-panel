import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCalendarPhrase } from '@/modules/calendar/services/calendar-phrase-parser.service.js';

// Monday 26 October 2026, 10:00 in Yekaterinburg (UTC+5).
const NOW = Date.parse('2026-10-26T05:00:00Z');
const TZ = 'Asia/Yekaterinburg';
const projects = [
  { projectId: 'villa', displayName: 'DemoVilla', names: ['DemoVilla', 'demo-villa'] },
  { projectId: 'z96', displayName: 'Сайт клиента', names: ['Сайт клиента', 'demo-site'] },
];

function parse(text: string, nowMs = NOW) {
  return parseCalendarPhrase({ text, nowMs, timeZone: TZ, projects });
}

test('«завтра в 11 позвонить [имя] про сайт» — call tomorrow 11:00 with defaults', () => {
  const result = parse('завтра в 11 позвонить [имя] про сайт');
  assert.equal(result.ok, true);
  assert.equal(result.draft?.type, 'call');
  assert.equal(result.draft?.startsAt, '2026-10-27T06:00:00.000Z');
  assert.equal(result.draft?.durationMin, 30);
  assert.equal(result.draft?.remindBeforeMin, 15);
  assert.equal(result.draft?.contact?.name, '[имя]');
  assert.equal(result.draft?.title, 'Позвонить [имя] про сайт');
  assert.equal(result.summary, 'Звонок · вт 27.10 11:00 · [имя]');
  assert.ok(result.missing.includes('телефон не указан'));
});

test('«в четверг в 16 встреча с Иваном по DemoVilla» — meeting, weekday, project', () => {
  const result = parse('в четверг в 16 встреча с Иваном по DemoVilla');
  assert.equal(result.draft?.type, 'meeting');
  assert.equal(result.draft?.startsAt, '2026-10-29T11:00:00.000Z');
  assert.equal(result.draft?.durationMin, 60);
  assert.equal(result.draft?.remindBeforeMin, 30);
  assert.equal(result.draft?.contact?.name, 'Иван');
  assert.equal(result.draft?.projectId, 'villa');
  assert.equal(result.recognized.project, true);
});

test('minutes, relative time and telegram handles', () => {
  const exact = parse('послезавтра в 15:30 написать @ivan_petrov насчёт счёта');
  assert.equal(exact.draft?.type, 'message');
  assert.equal(exact.draft?.startsAt, '2026-10-28T10:30:00.000Z');
  assert.equal(exact.draft?.contact?.telegram, '@ivan_petrov');

  const relative = parse('через 2 часа перезвонить Маше');
  assert.equal(relative.draft?.startsAt, '2026-10-26T07:00:00.000Z');
  assert.equal(relative.draft?.contact?.name, 'Маша');

  const halfHour = parse('через полчаса созвон');
  assert.equal(halfHour.draft?.startsAt, '2026-10-26T05:30:00.000Z');
});

test('a bare time already past today moves to tomorrow; «в 3» means 15:00', () => {
  const past = parse('в 9 позвонить в банк');
  assert.equal(past.draft?.startsAt, '2026-10-27T04:00:00.000Z');

  const afternoon = parse('в 3 встреча');
  assert.equal(afternoon.draft?.startsAt, '2026-10-26T10:00:00.000Z');

  const morning = parse('завтра в 7 утра позвонить');
  assert.equal(morning.draft?.startsAt, '2026-10-27T02:00:00.000Z');
});

test('explicit dates, duration and reminder', () => {
  const result = parse('30 октября в 10 встреча на 90 минут напомни за 1 час');
  assert.equal(result.draft?.startsAt, '2026-10-30T05:00:00.000Z');
  assert.equal(result.draft?.durationMin, 90);
  assert.equal(result.draft?.remindBeforeMin, 60);

  const numeric = parse('02.11 в 12:00 позвонить Олегу');
  assert.equal(numeric.draft?.startsAt, '2026-11-02T07:00:00.000Z');
});

test('recurring tasks for Claude', () => {
  const daily = parse('каждый день в 9 Claude: сводка по Сайт клиента');
  assert.equal(daily.draft?.type, 'agent_task');
  assert.equal(daily.draft?.recurrence, 'FREQ=DAILY');
  // 9:00 has passed on Monday 10:00, so the series starts tomorrow.
  assert.equal(daily.draft?.startsAt, '2026-10-27T04:00:00.000Z');
  assert.equal(daily.draft?.contact, null);
  assert.equal(daily.draft?.projectId, 'z96');
  assert.equal(daily.draft?.title, 'Сводка по Сайт клиента');

  const weekly = parse('по пятницам в 18 написать отчёт клиенту');
  assert.equal(weekly.draft?.recurrence, 'FREQ=WEEKLY;BYDAY=FR');
  assert.equal(weekly.draft?.startsAt, '2026-10-30T13:00:00.000Z');

  const weekdays = parse('по будням в 10:30 созвон');
  assert.equal(weekdays.draft?.recurrence, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
});

test('contact name is brought to the nominative case', () => {
  const name = (text: string) => parse(text).draft?.contact?.name;
  assert.equal(name('завтра в 11 позвонить Ивану про сайт'), 'Иван');
  assert.equal(name('в четверг в 16 встреча с Ольгой'), 'Ольга');
  assert.equal(name('написать Марии в 15'), 'Мария');
  assert.equal(name('позвонить Петру завтра в 10'), 'Пётр');
  assert.equal(name('завтра в 10 позвонить Андрею'), 'Андрей');
  assert.equal(name('завтра в 10 встреча с Иваном Петровым'), 'Иван Петров');
  assert.equal(name('завтра в 10 позвонить Ивану Петрову'), 'Иван Петров');
  assert.equal(name('завтра в 10 позвонить Иван'), 'Иван');
  assert.equal(name('завтра в 10 позвонить [Ивану]'), '[Ивану]');
});

test('a phrase with neither date nor time is not ok', () => {
  const result = parse('позвонить Ивану про сайт');
  assert.equal(result.ok, false);
  assert.equal(result.draft, null);
});

test('a phrase without a verb is never a call: meeting by default, a task for Claude in a named project', () => {
  const plain = parse('завтра в 11 обсудить сайт');
  assert.equal(plain.draft?.type, 'meeting');
  assert.equal(plain.recognized.type, false, 'the preview offers to switch the guessed type');

  const withPerson = parse('завтра в 11 с [имя] про сайт');
  assert.equal(withPerson.draft?.type, 'meeting');
  assert.equal(withPerson.draft?.contact?.name, '[имя]');

  const projectOnly = parse('завтра в 11 сводка по Сайт клиента');
  assert.equal(projectOnly.draft?.type, 'agent_task');
  assert.equal(projectOnly.draft?.projectId, 'z96');
  assert.equal(projectOnly.draft?.remindBeforeMin, null);
});

test('an absurd «через N дней» is left unrecognized instead of throwing', () => {
  const result = parse('через 99999999999 дней встреча');
  if (result.draft) assert.ok(Number.isFinite(Date.parse(result.draft.startsAt)));
  assert.equal(parse('через 3 дня встреча').draft?.startsAt.slice(0, 10), '2026-10-29');
});
