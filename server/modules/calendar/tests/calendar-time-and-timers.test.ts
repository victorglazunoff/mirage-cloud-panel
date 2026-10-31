import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expandRecurrence,
  parseRecurrenceRule,
  resolveTimeZone,
  zonedTimeToUtc,
  zoneOffsetMinutes,
} from '@/modules/calendar/services/calendar-time.service.js';
import { createSystemdTimersService, parseCalendarElapses, specTimeZone } from '@/modules/calendar/services/systemd-timers.service.js';

test('wall-clock times convert through the zone, DST included', () => {
  assert.equal(new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 27, hour: 11, minute: 0 }, 'Asia/Yekaterinburg')).toISOString(), '2026-10-27T06:00:00.000Z');
  // Berlin switches to winter time on 25 Oct 2026.
  assert.equal(new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 24, hour: 9, minute: 0 }, 'Europe/Berlin')).toISOString(), '2026-10-24T07:00:00.000Z');
  assert.equal(new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 26, hour: 9, minute: 0 }, 'Europe/Berlin')).toISOString(), '2026-10-26T08:00:00.000Z');
  assert.equal(resolveTimeZone(' Europe/Berlin '), 'Europe/Berlin');
});

test('an unknown zone falls back to the panel zone: MIRAGE_TIMEZONE, else the server zone', () => {
  const previous = process.env.MIRAGE_TIMEZONE;
  try {
    process.env.MIRAGE_TIMEZONE = 'Asia/Yekaterinburg';
    assert.equal(resolveTimeZone('Not/AZone'), 'Asia/Yekaterinburg');
    delete process.env.MIRAGE_TIMEZONE;
    assert.equal(resolveTimeZone(null), new Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally {
    if (previous === undefined) delete process.env.MIRAGE_TIMEZONE;
    else process.env.MIRAGE_TIMEZONE = previous;
  }
});

test('recurrence rules parse only the supported subset', () => {
  assert.deepEqual(parseRecurrenceRule('FREQ=WEEKLY;BYDAY=MO,FR;INTERVAL=2'), {
    freq: 'WEEKLY', interval: 2, byDay: [0, 4], untilMs: null, count: null,
  });
  assert.equal(parseRecurrenceRule('FREQ=HOURLY'), null);
  assert.equal(parseRecurrenceRule('FREQ=DAILY;BYHOUR=3'), null);
  assert.equal(parseRecurrenceRule(''), null);
});

test('daily and weekly series expand in the user zone and honour COUNT/UNTIL', () => {
  const tz = 'Asia/Yekaterinburg';
  const start = Date.parse('2026-10-20T04:00:00Z'); // Tue 09:00 local
  const week = [Date.parse('2026-10-26T00:00:00Z'), Date.parse('2026-11-02T00:00:00Z')] as const;

  const daily = expandRecurrence(start, parseRecurrenceRule('FREQ=DAILY')!, week[0], week[1], tz);
  assert.equal(daily.length, 7);
  assert.equal(new Date(daily[0]).toISOString(), '2026-10-26T04:00:00.000Z');

  const weekdays = expandRecurrence(start, parseRecurrenceRule('FREQ=WEEKLY;BYDAY=MO,WE,FR')!, week[0], week[1], tz);
  assert.deepEqual(weekdays.map((instant) => new Date(instant).toISOString().slice(0, 10)), ['2026-10-26', '2026-10-28', '2026-10-30']);

  const counted = expandRecurrence(start, parseRecurrenceRule('FREQ=DAILY;COUNT=8')!, week[0], week[1], tz);
  assert.equal(counted.length, 2); // 20–25 Oct used six of the eight.

  const until = expandRecurrence(start, parseRecurrenceRule('FREQ=DAILY;UNTIL=20261027')!, week[0], week[1], tz);
  assert.equal(until.length, 2);
});

test('a date-only UNTIL ends the series on that day in the user zone, not in UTC', () => {
  const tz = 'Asia/Yekaterinburg';
  // 03:00 local = 22:00 UTC of the day before: a UTC end of day would let 4 Nov 03:00 local through.
  const start = Date.parse('2026-11-01T22:00:00Z'); // Mon 2 Nov 03:00 local
  const range = [Date.parse('2026-11-01T19:00:00Z'), Date.parse('2026-11-08T19:00:00Z')] as const;
  const days = expandRecurrence(start, parseRecurrenceRule('FREQ=DAILY;UNTIL=20261103')!, range[0], range[1], tz)
    .map((instant) => new Date(instant).toISOString());
  assert.deepEqual(days, ['2026-11-01T22:00:00.000Z', '2026-11-02T22:00:00.000Z']);

  // An UNTIL with a UTC time stays an exact instant.
  const exact = expandRecurrence(start, parseRecurrenceRule('FREQ=DAILY;UNTIL=20261102T220000Z')!, range[0], range[1], tz);
  assert.equal(exact.length, 2);
});

test('systemd-analyze output is read as UTC instants', () => {
  const output = [
    '  Original form: *-*-* 03:00:00',
    'Normalized form: *-*-* 03:00:00',
    '    Next elapse: Mon 2026-10-26 03:00:00 EET',
    '       (in UTC): Mon 2026-10-26 01:00:00 UTC',
    '   Iteration #2: Tue 2026-10-27 03:00:00 EET',
    '       (in UTC): Tue 2026-10-27 01:00:00 UTC',
  ].join('\n');
  assert.deepEqual(parseCalendarElapses(output).map((instant) => new Date(instant).toISOString()), [
    '2026-10-26T01:00:00.000Z',
    '2026-10-27T01:00:00.000Z',
  ]);
});

test('timer listing runs only read-only commands and hides packaged timers by default', async () => {
  const calls: string[] = [];
  const service = createSystemdTimersService(async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'systemctl' && args[0] === 'list-timers') {
      return JSON.stringify([
        { unit: 'mirage-build.timer', activates: 'mirage-build.service', next: 1793070000000000, last: 1792983600000000 },
        { unit: 'apt-daily.timer', activates: 'apt-daily.service', next: null, last: null },
      ]);
    }
    if (command === 'systemctl' && args.includes('TimersCalendar')) {
      return [
        'Id=mirage-build.timer', 'Description=Ночная сборка', 'Unit=mirage-build.service',
        'TimersCalendar={ OnCalendar=Mon..Sat *-*-* 03:00:00 ; next_elapse=@1793070000 }',
        'FragmentPath=/etc/systemd/system/mirage-build.timer', '',
        'Id=apt-daily.timer', 'Description=Daily apt', 'Unit=apt-daily.service',
        'TimersCalendar={ OnCalendar=*-*-* 06,18:00:00 ; next_elapse=@1793070000 }',
        'FragmentPath=/usr/lib/systemd/system/apt-daily.timer',
      ].join('\n');
    }
    if (command === 'systemctl') {
      return 'Id=mirage-build.service\nResult=success\n';
    }
    return '    Next elapse: Tue 2026-10-27 03:00:00 UTC\n   Iteration #2: Wed 2026-10-28 03:00:00 UTC\n';
  });

  const occurrences = await service.listOccurrences({
    fromMs: Date.parse('2026-10-26T00:00:00Z'),
    toMs: Date.parse('2026-11-02T00:00:00Z'),
    nowMs: Date.parse('2026-10-26T12:00:00Z'),
    includePackaged: false,
  });
  assert.deepEqual(occurrences.map((entry) => [entry.timer.unit, new Date(entry.startsAtMs).toISOString()]), [
    ['mirage-build.timer', '2026-10-27T03:00:00.000Z'],
    ['mirage-build.timer', '2026-10-28T03:00:00.000Z'],
  ]);
  assert.equal(occurrences[0].timer.lastResult, 'success');
  assert.equal(occurrences[0].timer.description, 'Ночная сборка');
  for (const call of calls) {
    assert.match(call, /^(systemctl (list-timers|show)|systemd-analyze calendar) /);
  }
});

test('a timer spec is read in its own zone or the server zone; the journal prints panel time', async () => {
  assert.equal(specTimeZone('Mon *-*-* 05:17:00', 'Europe/Helsinki'), 'Europe/Helsinki');
  assert.equal(specTimeZone('*-*-* 03:00:00 UTC', 'Europe/Helsinki'), 'UTC');
  assert.equal(specTimeZone('*-*-* 03:00:00 Asia/Yekaterinburg', 'Europe/Helsinki'), 'Asia/Yekaterinburg');

  // ig-token-refresh: «Mon 05:17» on a Helsinki server — 02:17 UTC in summer, 03:17 UTC after 25.10.
  assert.equal(zoneOffsetMinutes(Date.parse('2026-10-19T02:17:00Z'), 'Europe/Helsinki'), 180);
  assert.equal(zoneOffsetMinutes(Date.parse('2026-10-26T03:17:00Z'), 'Europe/Helsinki'), 120);
  assert.equal(zoneOffsetMinutes(Date.parse('2026-10-19T02:17:00Z'), 'Asia/Yekaterinburg'), 300);

  const calls: Array<{ command: string; env?: Record<string, string> }> = [];
  const service = createSystemdTimersService(async (command, args, options) => {
    calls.push({ command, env: options?.env });
    if (command === 'systemctl' && args[0] === 'list-timers') {
      return JSON.stringify([{ unit: 'ig-token-refresh.timer', activates: 'ig-token-refresh.service', next: null, last: null }]);
    }
    if (command === 'systemctl' && args.includes('TimersCalendar')) {
      return 'Id=ig-token-refresh.timer\nUnit=ig-token-refresh.service\nTimersCalendar={ OnCalendar=Mon *-*-* 05:17:00 ; next_elapse=@1793589420 }\nFragmentPath=/etc/systemd/system/ig-token-refresh.timer\n';
    }
    if (command === 'journalctl') return '2026-10-26T08:17:02+05:00 host systemd[1]: Starting ig-token-refresh.service...\n';
    return '';
  }, () => 'Europe/Helsinki');

  const journal = await service.readJournal('ig-token-refresh.timer', Date.parse('2026-10-26T10:00:00Z'), 'Asia/Yekaterinburg');
  assert.equal(journal?.service, 'ig-token-refresh.service');
  assert.deepEqual(calls.find((call) => call.command === 'journalctl')?.env, { TZ: 'Asia/Yekaterinburg' });
  const occurrences = await service.listOccurrences({ fromMs: 0, toMs: 1, nowMs: Date.parse('2026-10-26T10:00:00Z'), includePackaged: true });
  assert.deepEqual(occurrences, []);
});

test('a missing systemd yields no server schedule instead of an error', async () => {
  const service = createSystemdTimersService(async () => {
    throw new Error('spawn systemctl ENOENT');
  });
  assert.deepEqual(await service.listOccurrences({ fromMs: 0, toMs: 1, nowMs: 0, includePackaged: true }), []);
});
