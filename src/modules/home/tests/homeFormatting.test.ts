import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { getPanelTimeZone, setPanelTimeZone } from '@/modules/kabina';
import { buildActivityRows } from '@/modules/home/utils/homeActivityRows';
import {
  buildWeek,
  eventOnLocalDay,
  formatClock,
  formatCountdown,
  formatEventWhen,
  formatCredits,
  greetingName,
  formatElapsed,
  formatLastActivity,
  formatReset,
  formatShortLongDate,
  greetingFor,
  plural,
  weeklyElapsedShare,
} from '@/modules/home/utils/homeFormatting';
import type { HomeActivityItem } from '@/shared/types';

const NOW = new Date(2026, 9, 26, 14, 32); // Mon 26 Oct 2026, 14:32 local

// The fixtures below are built from local fields, so the panel zone is the process zone here.
beforeAll(() => setPanelTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));

test('plural picks the Russian form', () => {
  const forms: [string, string, string] = ['агент', 'агента', 'агентов'];
  assert.equal(plural(1, forms), 'агент');
  assert.equal(plural(2, forms), 'агента');
  assert.equal(plural(5, forms), 'агентов');
  assert.equal(plural(11, forms), 'агентов');
  assert.equal(plural(21, forms), 'агент');
  assert.equal(plural(24, forms), 'агента');
});

test('greeting follows the time of day', () => {
  assert.equal(greetingFor(new Date(2026, 9, 26, 8)), 'Доброе утро');
  assert.equal(greetingFor(NOW), 'Добрый день');
  assert.equal(greetingFor(new Date(2026, 9, 26, 20)), 'Добрый вечер');
  assert.equal(greetingFor(new Date(2026, 9, 26, 2)), 'Доброй ночи');
});

test('elapsed and countdown read like the mock-up', () => {
  const now = NOW.getTime();
  assert.equal(formatElapsed(now - 20_000, now), 'сейчас');
  assert.equal(formatElapsed(now - 12 * 60_000, now), '12 мин');
  assert.equal(formatElapsed(now - 80 * 60_000, now), '1 ч 20 мин');
  assert.equal(formatCountdown(now + 28 * 60_000, now), 'через 28 мин');
  assert.equal(formatCountdown(now + (4 * 60 + 48) * 60_000, now), 'через 4 ч 48 мин');
});

test('last activity: minutes, today, yesterday, date', () => {
  assert.equal(formatLastActivity(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW), '5 мин назад');
  assert.equal(formatLastActivity(new Date(2026, 9, 26, 9, 5).toISOString(), NOW), 'сегодня 09:05');
  assert.equal(formatLastActivity(new Date(2026, 9, 25, 19, 40).toISOString(), NOW), 'вчера 19:40');
  assert.equal(formatLastActivity(new Date(2026, 9, 24, 12, 0).toISOString(), NOW), '24 окт');
  assert.equal(formatLastActivity(null, NOW), 'нет диалогов');
});

test('reset wording: countdown within a day, weekday later', () => {
  assert.equal(formatReset(new Date(NOW.getTime() + (4 * 60 + 48) * 60_000).toISOString(), NOW), 'сброс через 4\u00a0ч 48\u00a0мин', 'numbers keep their units');
  assert.equal(formatReset(new Date(2026, 9, 29, 5, 0).toISOString(), NOW), 'сброс чт 5:00');
  assert.equal(formatCredits(48.94, 250), 'осталось $48 из $250');
});

test('weekly pace share comes from the reset time', () => {
  const resetsAt = new Date(NOW.getTime() + 3.5 * 86_400_000).toISOString();
  assert.equal(weeklyElapsedShare(resetsAt, NOW.getTime()), 0.5);
  assert.equal(weeklyElapsedShare(null, NOW.getTime()), null);
});

test('week strip starts today and counts events per day', () => {
  const week = buildWeek(NOW, [
    new Date(2026, 9, 26, 17, 30).toISOString(),
    new Date(2026, 9, 26, 19, 0).toISOString(),
    new Date(2026, 9, 29, 10, 0).toISOString(),
  ]);
  assert.equal(week.length, 7);
  assert.equal(week[0].weekday, 'ПН');
  assert.equal(week[0].isToday, true);
  assert.equal(week[0].count, 2);
  assert.equal(week[3].count, 1);
  assert.equal(week[5].isWeekend, true);
});

test('an event running past midnight is on every day it touches (home «сегодня» and the week strip)', () => {
  // NOW is Monday 26.10; a trip from Sunday 20:00 to Tuesday 10:00 (panel time).
  const trip = { scheduledFor: new Date(2026, 9, 25, 20, 0).toISOString(), endsAt: new Date(2026, 9, 27, 10, 0).toISOString() };
  assert.deepEqual(eventOnLocalDay(trip, new Date(2026, 9, 26)), { fromPrevDay: true, toNextDay: true });
  assert.deepEqual(eventOnLocalDay(trip, new Date(2026, 9, 27)), { fromPrevDay: true, toNextDay: false });
  assert.equal(eventOnLocalDay(trip, new Date(2026, 9, 28)), null);
  // Ending exactly at midnight stays on its own day.
  const evening = { scheduledFor: new Date(2026, 9, 26, 22, 0).toISOString(), endsAt: new Date(2026, 9, 27, 0, 0).toISOString() };
  assert.equal(eventOnLocalDay(evening, new Date(2026, 9, 27)), null);
  const week = buildWeek(NOW, [{ startsAt: trip.scheduledFor, endsAt: trip.endsAt }]);
  assert.deepEqual(week.slice(0, 3).map((day) => day.count), [1, 1, 0]);
});

test('phone eyebrow date reads like the mock-up', () => {
  assert.equal(formatShortLongDate(NOW), 'ПН 26 ОКТЯБРЯ');
});

test('activity rows: one per turn and one per background task', () => {
  const base = { provider: 'claude', projectId: 'p', external: false, permission: null, tasks: [] } as const;
  const activity: HomeActivityItem[] = [
    { ...base, sessionId: 'a', projectName: 'Сайт клиента', sessionTitle: 'Выкладка', state: 'waiting', startedAt: 1,
      permission: { toolName: 'Bash', summary: 'deploy.sh', receivedAt: new Date(5).toISOString() }, tasks: [] },
    { ...base, sessionId: 'b', projectName: 'Карта', sessionTitle: 'SEO', state: 'running', startedAt: 2,
      tasks: [{ taskId: 't', description: '14 страниц', taskType: 'agent', startedAt: 3 }] },
    { ...base, sessionId: 'c', projectName: 'Мираж', sessionTitle: 'Фон', state: 'background', startedAt: 4, tasks: [] },
  ];
  const rows = buildActivityRows(activity);
  assert.deepEqual(rows.map((row) => row.kind), ['wait', 'run', 'bg', 'bg']);
  assert.equal(rows[0].command, 'deploy.sh');
  assert.equal(rows[0].since, 5);
  assert.equal(rows[2].what, 'Фоновый агент · 14 страниц');
});

test('clock, greeting and dates follow the panel zone, not the process zone', () => {
  const previous = getPanelTimeZone();
  setPanelTimeZone('Asia/Yekaterinburg');
  try {
    const instant = new Date('2026-10-26T20:30:00Z'); // 01:30 on the 27th in Yekaterinburg
    assert.equal(formatClock(instant), '01:30');
    assert.equal(greetingFor(instant), 'Доброй ночи');
    assert.equal(formatShortLongDate(instant), 'ВТ 27 ОКТЯБРЯ');
    assert.equal(formatLastActivity('2026-10-26T19:10:00Z', instant), 'сегодня 00:10');
  } finally {
    setPanelTimeZone(previous);
  }
});

test('greetingName: the settings name first, then a Russian login, never a Latin handle', () => {
  assert.equal(greetingName('Иван', 'alicework'), 'Иван');
  assert.equal(greetingName('  ', 'иван'), 'Иван');
  assert.equal(greetingName('', 'alicework'), null);
  assert.equal(greetingName(undefined, undefined), null);
});

test('formatEventWhen: today, tomorrow, this week, later — short for the board cell', () => {
  const now = new Date('2026-10-26T09:00:00Z');
  assert.equal(formatEventWhen(new Date('2026-10-26T10:00:00Z'), now), `в ${formatClock(new Date('2026-10-26T10:00:00Z'))}`);
  assert.match(formatEventWhen(new Date('2026-10-27T06:00:00Z'), now), /^завтра \d\d:\d\d$/);
  assert.match(formatEventWhen(new Date('2026-10-30T06:00:00Z'), now), /^(пн|вт|ср|чт|пт|сб|вс) \d\d:\d\d$/);
  assert.match(formatEventWhen(new Date('2026-11-09T06:00:00Z'), now), /^\d\d\.11 \d\d:\d\d$/);
});
