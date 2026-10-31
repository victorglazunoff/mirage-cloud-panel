import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'vitest';

import { browserTimeZone, setPanelTimeZone } from '@/modules/kabina';
import {
  bandOf,
  dayPieces,
  describeTimerZone,
  formatCountdown,
  formatSpan,
  fromWall,
  isoWeek,
  phoneUrl,
  pieceBand,
  pieceTimeText,
  placeDayEvents,
  placeDayPieces,
  telegramUrl,
  toWall,
  viewHeading,
  viewRange,
} from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarItem } from '@/shared/types';

// The fixtures are Yekaterinburg wall clock (UTC+5): pin the panel zone whatever the machine's is.
beforeAll(() => setPanelTimeZone('Asia/Yekaterinburg'));
afterAll(() => setPanelTimeZone(browserTimeZone()));

function item(id: string, startsAt: string, endsAt: string, extra: Partial<CalendarItem> = {}): CalendarItem {
  return {
    id, source: 'panel', type: 'call', title: id, startsAt, endsAt, projectId: null, projectName: null, contact: null,
    location: null, note: null, remindBeforeMin: null, status: 'planned', sessionId: null, recurrence: null,
    occurrenceOf: null, readOnly: false, preparedAt: null, allDay: false, google: null, agent: null, server: null, ...extra,
  };
}

test('wall dates show Yekaterinburg time whatever the browser zone, and convert back', () => {
  const wall = toWall('2026-10-26T09:32:00Z');
  assert.equal(wall.getHours(), 14);
  assert.equal(wall.getMinutes(), 32);
  assert.equal(fromWall(wall).toISOString(), '2026-10-26T09:32:00.000Z');
  assert.equal(fromWall(new Date(2026, 9, 26)).toISOString(), '2026-10-25T19:00:00.000Z');
});

test('views: the week runs Monday to Monday, the month covers whole weeks', () => {
  const anchor = new Date(2026, 9, 28);
  const week = viewRange('week', anchor);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].getDate(), 26);
  assert.equal(viewHeading('week', anchor).title, '26.10 — 01.11');
  assert.equal(isoWeek(anchor), 44);
  const month = viewRange('month', anchor);
  assert.equal(month.days.length % 7, 0);
  assert.equal(month.days[0].getDate(), 28); // Monday 28.09
  assert.equal(viewRange('day', anchor).days.length, 1);
});

test('events go to the 08–21 grid or the strips, overlapping ones share the column', () => {
  assert.equal(bandOf(item('a', '2026-10-26T00:00:00Z', '2026-10-26T00:20:00Z')), 'early'); // 05:00 ЕКБ
  assert.equal(bandOf(item('b', '2026-10-26T05:00:00Z', '2026-10-26T05:30:00Z')), 'grid'); // 10:00
  assert.equal(bandOf(item('c', '2026-10-26T17:00:00Z', '2026-10-26T17:30:00Z')), 'late'); // 22:00
  const placed = placeDayEvents([
    item('x', '2026-10-26T05:00:00Z', '2026-10-26T06:00:00Z'),
    item('y', '2026-10-26T05:30:00Z', '2026-10-26T06:00:00Z'),
    item('z', '2026-10-26T08:00:00Z', '2026-10-26T08:30:00Z'),
  ]);
  const byId = Object.fromEntries(placed.map((placement) => [placement.item.id, placement]));
  assert.equal(byId.x.top, 2 * 44 + 1);
  assert.equal(byId.x.height, 42);
  assert.deepEqual([byId.x.lane, byId.y.lane, byId.x.lanes, byId.y.lanes], [0, 1, 2, 2]);
  assert.deepEqual([byId.z.lane, byId.z.lanes], [0, 1]);
});

test('an event over several days is a piece on each day it touches, drawn as a bar through the grid', () => {
  // Sun 25.10 20:00 → Tue 27.10 10:00 ЕКБ.
  const trip = item('trip', '2026-10-25T15:00:00Z', '2026-10-27T05:00:00Z', { type: 'meeting' });
  const day = (date: number) => new Date(2026, 9, date);
  const [sunday] = dayPieces([trip], day(25));
  const [monday] = dayPieces([trip], day(26));
  const [tuesday] = dayPieces([trip], day(27));
  assert.deepEqual(dayPieces([trip], day(28)), []);
  assert.deepEqual([sunday.startMin, sunday.endMin, sunday.fromPrevDay, sunday.toNextDay], [20 * 60, 24 * 60, false, true]);
  assert.deepEqual([monday.startMin, monday.endMin, monday.fromPrevDay, monday.toNextDay], [0, 24 * 60, true, true]);
  assert.deepEqual([tuesday.startMin, tuesday.endMin, tuesday.fromPrevDay, tuesday.toNextDay], [0, 10 * 60, true, false]);
  assert.deepEqual([sunday, monday, tuesday].map(pieceBand), ['grid', 'grid', 'grid']);
  assert.deepEqual([sunday, monday, tuesday].map(pieceTimeText), ['20:00', 'весь день', 'до 10:00']);
  // Monday: the whole 08–21 grid, flush with both edges; Tuesday: 08:00–10:00 from the top edge.
  const [mondayBar] = placeDayPieces([monday]);
  assert.deepEqual([mondayBar.top, mondayBar.height], [0, 13 * 44]);
  // Tuesday: a rail from the top edge to 10:00; the 09:00 call keeps the rest of the column to itself.
  const call = item('call', '2026-10-27T04:00:00Z', '2026-10-27T04:30:00Z');
  const [tuesdayBar, callBox] = placeDayPieces([tuesday, ...dayPieces([call], day(27))]);
  assert.deepEqual([tuesdayBar.top, tuesdayBar.height, tuesdayBar.fromPrevDay, tuesdayBar.rail], [0, 2 * 44 - 1, true, true]);
  assert.deepEqual([callBox.rail, callBox.lane, callBox.lanes, callBox.inset], [false, 0, 1, 22]);
  // Ending at 05:00 the next morning: «до 05:00» in the «до 08» strip.
  const night = item('night', '2026-10-26T16:00:00Z', '2026-10-27T00:00:00Z');
  assert.equal(pieceBand(dayPieces([night], day(27))[0]), 'early');
  // Ending exactly at midnight does not spill into the next day.
  assert.deepEqual(dayPieces([item('eve', '2026-10-26T17:00:00Z', '2026-10-26T19:00:00Z')], day(27)), []);
  assert.equal(formatSpan(trip), 'вс 20:00 → вт 10:00');
});

test('contact links and countdown', () => {
  assert.equal(phoneUrl('+7 (900) 000-00-02'), 'tel:+79000000002');
  assert.equal(phoneUrl('нет'), null);
  assert.equal(telegramUrl('@example_lead'), 'https://t.me/example_lead');
  assert.equal(telegramUrl('https://t.me/someone'), 'https://t.me/someone');
  assert.equal(telegramUrl('почта [адрес]'), null);
  assert.equal(formatCountdown(28 * 60_000, 0), 'через 28 мин');
  assert.equal(formatCountdown(5 * 3_600_000, 0), '');
});

test('server timers: the zone row explains a firing moved by the server summer time', () => {
  const base = { unit: 'ig-token-refresh.timer', activates: 'ig-token-refresh.service', description: null, calendarSpec: 'Mon *-*-* 05:17:00', lastTriggerAt: null, lastResult: null };
  // 19.10: Helsinki still on summer time (UTC+3), today UTC+2 — the firing was an hour earlier in ЕКБ.
  const summer = describeTimerZone({ ...base, timeZone: 'Europe/Helsinki', utcOffsetMin: 180, currentUtcOffsetMin: 120 }, 'ЕКБ');
  assert.equal(summer?.value, 'Europe/Helsinki · UTC+2');
  assert.equal(summer?.note, 'в этот день на сервере UTC+3 (сезонный перевод часов) — по ЕКБ запуск на 1 ч раньше, чем сейчас');
  assert.equal(describeTimerZone({ ...base, timeZone: 'Europe/Helsinki', utcOffsetMin: 120, currentUtcOffsetMin: 120 }, 'ЕКБ')?.note, null);
  assert.equal(describeTimerZone({ ...base, timeZone: 'Europe/Helsinki', utcOffsetMin: 180, currentUtcOffsetMin: 120 }, 'ЕКБ') !== null, true);
  assert.equal(describeTimerZone({ ...base, timeZone: null, utcOffsetMin: null, currentUtcOffsetMin: null }, 'ЕКБ'), null);
});
