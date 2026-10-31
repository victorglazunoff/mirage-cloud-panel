import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTypeFilter } from '@/modules/calendar/calendar.routes.js';
import { createCalendarService } from '@/modules/calendar/services/calendar.service.js';
import {
  calendarEventsDb,
  closeConnection,
  initializeDatabase,
  scheduledMessagesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

// The fixtures are Yekaterinburg wall-clock times: pin the panel zone so the machine's own zone does not matter.
process.env.MIRAGE_TIMEZONE = 'Asia/Yekaterinburg';

const NOW = Date.parse('2026-10-26T05:00:00Z'); // Monday 10:00 in Yekaterinburg
const WEEK = { from: '2026-10-25T19:00:00.000Z', to: '2026-11-01T19:00:00.000Z' };

type Harness = {
  userId: number;
  service: ReturnType<typeof createCalendarService>;
  scheduled: Array<{ userId: number; sessionId: string; content: string; scheduledFor: string }>;
  createdSessions: string[];
};

async function withCalendar(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'calendar-service-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const userId = Number(userDb.createUser('alice', 'hash').id);
    const projectPath = path.join(tempDirectory, 'demo-villa');
    sessionsDb.createAppSession('s-existing', 'claude', projectPath, 'Срезы рынка');
    const scheduled: Harness['scheduled'] = [];
    const createdSessions: string[] = [];
    const service = createCalendarService({
      now: () => NOW,
      events: calendarEventsDb,
      listScheduledMessages: (id, fromIso, toIso) => scheduledMessagesDb.listForUserBetween(id, fromIso, toIso),
      describeSession: (sessionId) => ({ projectId: sessionId === 's-existing' ? 'villa' : null, sessionTitle: 'Срезы рынка' }),
      getProject: (projectId) => (projectId === 'villa' ? { projectId: 'villa', projectPath, displayName: 'DemoVilla' } : null),
      listProjects: () => [{ projectId: 'villa', projectPath, displayName: 'DemoVilla' }],
      readTimerJournal: async (unit) => (unit === 'mirage-build.timer' ? { unit, service: 'mirage-build.service', lines: ['ok'] } : null),
      listServerTimers: async () => [{
        timer: {
          unit: 'mirage-build.timer', activates: 'mirage-build.service', description: 'Ночная сборка',
          calendarSpecs: ['*-*-* 03:00:00'], nextElapseMs: null, lastTriggerMs: null, lastResult: 'success', isPackaged: false, timeZone: 'Europe/Helsinki',
        },
        startsAtMs: Date.parse('2026-10-27T22:00:00Z'),
      }],
      createSession: (_projectPath, initialMessage) => {
        const sessionId = `s-new-${createdSessions.length + 1}`;
        sessionsDb.createAppSession(sessionId, 'claude', projectPath, initialMessage);
        createdSessions.push(sessionId);
        return { sessionId };
      },
      sessionExists: (sessionId) => Boolean(sessionsDb.getSessionById(sessionId)),
      scheduleMessage: (input) => {
        scheduled.push(input);
        return { id: `sm-${scheduled.length}`, scheduledFor: input.scheduledFor };
      },
    });
    await runTest({ userId, service, scheduled, createdSessions });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('events are created, validated and listed with the week feed merged in', async () => {
  await withCalendar(async ({ userId, service }) => {
    const call = service.createEvent(userId, {
      type: 'call', title: 'Интехсталь — отдел продаж', startsAt: '2026-10-27T06:00:00Z', durationMin: 20,
      projectId: 'villa', contact: { name: '[имя]', phone: '+7 900 000-00-00' }, remindBeforeMin: 15,
    });
    assert.equal(call.endsAt, '2026-10-27T06:20:00.000Z');
    assert.equal(call.projectName, 'DemoVilla');
    assert.deepEqual(call.contact, { name: '[имя]', phone: '+7 900 000-00-00', telegram: null });

    service.createEvent(userId, { type: 'agent_task', title: 'Сводка', startsAt: '2026-10-20T04:00:00Z', recurrence: 'FREQ=DAILY' });
    scheduledMessagesDb.create({
      userId, sessionId: 's-existing', content: 'Собери срез рынка', options: {}, scheduledFor: new Date('2026-10-28T10:00:00Z'),
    });

    const week = await service.listEvents({
      userId, from: WEEK.from, to: WEEK.to, types: null, project: null,
      includeCancelled: false, includePackagedTimers: false, timeZone: null,
    });
    const bySource = (source: string) => week.items.filter((item) => item.source === source);
    assert.equal(bySource('panel').filter((item) => item.occurrenceOf).length, 7);
    assert.equal(bySource('scheduled_message').length, 1);
    assert.equal(bySource('scheduled_message')[0].projectName, 'DemoVilla');
    assert.equal(bySource('scheduled_message')[0].readOnly, true);
    assert.equal(bySource('systemd')[0].server?.unit, 'mirage-build.timer');
    assert.deepEqual(week.items.map((item) => item.startsAt), [...week.items.map((item) => item.startsAt)].sort());

    const onlyCalls = await service.listEvents({
      userId, from: WEEK.from, to: WEEK.to, types: ['call'], project: 'villa',
      includeCancelled: false, includePackagedTimers: false, timeZone: null,
    });
    assert.deepEqual(onlyCalls.items.map((item) => item.id), [call.id]);

    assert.throws(() => service.createEvent(userId, { type: 'server_schedule', title: 'x', startsAt: WEEK.from }), AppError);
    assert.throws(() => service.createEvent(userId, { type: 'call', title: ' ', startsAt: WEEK.from }), AppError);
    assert.throws(() => service.createEvent(userId, { type: 'call', title: 'x', startsAt: 'завтра' }), AppError);
    assert.throws(() => service.createEvent(userId, { type: 'call', title: 'x', startsAt: WEEK.from, recurrence: 'FREQ=HOURLY' }), AppError);
    assert.throws(() => service.createEvent(userId, { type: 'call', title: 'x', startsAt: WEEK.from, projectId: 'nope' }), AppError);
  });
});

test('default range is the current Monday-to-Monday week in the panel zone', async () => {
  await withCalendar(async ({ userId, service }) => {
    const week = await service.listEvents({
      userId, from: null, to: null, types: ['call'], project: null,
      includeCancelled: false, includePackagedTimers: false, timeZone: null,
    });
    assert.equal(week.from, '2026-10-25T19:00:00.000Z');
    assert.equal(week.to, '2026-11-01T19:00:00.000Z');
    assert.equal(week.timeZone, 'Asia/Yekaterinburg');
  });
});

test('done, back to plan, reschedule presets and the recurring guard', async () => {
  await withCalendar(async ({ userId, service }) => {
    const event = service.createEvent(userId, { type: 'call', title: 'Звонок', startsAt: '2026-10-27T06:00:00Z', durationMin: 30 });
    const done = service.setStatus(userId, event.id, 'done');
    assert.equal(done.status, 'done');
    assert.equal(service.setStatus(userId, event.id, 'planned').status, 'planned');

    const later = service.reschedule(userId, event.id, { preset: 'plus1h' });
    assert.equal(later.startsAt, '2026-10-27T07:00:00.000Z');
    assert.equal(later.endsAt, '2026-10-27T07:30:00.000Z');
    const tomorrow = service.reschedule(userId, event.id, { preset: 'tomorrow' });
    assert.equal(tomorrow.startsAt, '2026-10-28T07:00:00.000Z');
    assert.throws(() => service.reschedule(userId, event.id, {}), AppError);

    service.deleteEvent(userId, event.id);
    assert.throws(() => service.getEvent(userId, event.id), (error: unknown) => error instanceof AppError && error.statusCode === 404);

    // A date that parses but cannot be shown is refused as input, not answered with a 500.
    assert.throws(
      () => service.createEvent(userId, { type: 'call', title: 'x', startsAt: '+275760-09-13T00:00:00.000Z' }),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
  });
});

test('«prepare» opens a session in the project and queues the task through scheduled messages', async () => {
  await withCalendar(async ({ userId, service, scheduled, createdSessions }) => {
    const event = service.createEvent(userId, {
      type: 'call', title: 'Позвонить [имя] про сайт', startsAt: '2026-10-27T06:00:00Z', projectId: 'villa',
      contact: { name: '[имя]' }, note: 'клиент с 2023 года',
    });
    const result = service.prepare(userId, event.id, { projectId: null, sessionId: null, at: null, instructions: null, timeZone: null });
    assert.equal(createdSessions.length, 1);
    assert.equal(result.sessionId, createdSessions[0]);
    assert.equal(result.sessionUrl, `/p/villa/s/${createdSessions[0]}`);
    assert.equal(result.scheduledFor, new Date(NOW).toISOString());
    assert.equal(result.event.sessionId, createdSessions[0]);
    assert.ok(result.event.preparedAt);
    assert.match(scheduled[0].content, /план звонка/);
    assert.match(scheduled[0].content, /27\.10\.2026 в 11:00/);
    assert.match(scheduled[0].content, /клиент с 2023 года/);

    const intoExisting = service.prepare(userId, event.id, {
      projectId: null, sessionId: 's-existing', at: '2026-10-27T05:00:00Z', instructions: 'коротко', timeZone: null,
    });
    assert.equal(intoExisting.sessionId, 's-existing');
    assert.equal(createdSessions.length, 1);
    assert.equal(scheduled[1].scheduledFor, '2026-10-27T05:00:00.000Z');

    const orphan = service.createEvent(userId, { type: 'message', title: 'Написать', startsAt: '2026-10-27T06:00:00Z' });
    assert.throws(
      () => service.prepare(userId, orphan.id, { projectId: null, sessionId: null, at: null, instructions: null, timeZone: null }),
      (error: unknown) => error instanceof AppError && error.code === 'CALENDAR_PROJECT_REQUIRED',
    );
  });
});

test('«Открыть журнал» reads only listed timers and rejects odd unit names', async () => {
  await withCalendar(async ({ service }) => {
    assert.deepEqual((await service.readTimerJournal('mirage-build.timer')).lines, ['ok']);
    await assert.rejects(service.readTimerJournal('ssh.timer'), (error: unknown) => error instanceof AppError && error.code === 'CALENDAR_TIMER_NOT_FOUND');
    await assert.rejects(service.readTimerJournal('../etc; rm -rf'), (error: unknown) => error instanceof AppError && error.code === 'CALENDAR_INVALID_INPUT');
  });
});

test('the route whitelists the type filter', () => {
  assert.deepEqual(readTypeFilter('call,meeting'), ['call', 'meeting']);
  assert.equal(readTypeFilter(undefined), null);
  assert.throws(() => readTypeFilter('party'), AppError);
});

test('reminders: planned events with a reminder, recurring ones expanded, others left out', async () => {
  await withCalendar(async ({ userId, service }) => {
    service.createEvent(userId, { type: 'call', title: 'Иван', startsAt: '2026-10-26T06:00:00Z', remindBeforeMin: 15 });
    service.createEvent(userId, { type: 'meeting', title: 'Без напоминания', startsAt: '2026-10-26T07:00:00Z', remindBeforeMin: null });
    const done = service.createEvent(userId, { type: 'call', title: 'Уже сделано', startsAt: '2026-10-26T08:00:00Z', remindBeforeMin: 10 });
    service.updateEvent(userId, done.id, { status: 'done' });
    service.createEvent(userId, {
      type: 'message', title: 'Сводка Ольге', startsAt: '2026-10-20T04:00:00Z', remindBeforeMin: 5, recurrence: 'FREQ=DAILY',
    });

    const items = service.listReminders(NOW, NOW + 24 * 3_600_000, 'Asia/Yekaterinburg');
    const rows = items.map((item) => [item.title, item.startsAt, item.remindBeforeMin]).sort((x, y) => String(x[1]).localeCompare(String(y[1])));
    // The recurring one at 09:00 ЕКБ today is already past NOW (10:00 ЕКБ); tomorrow's is in.
    assert.deepEqual(rows, [
      ['Иван', '2026-10-26T06:00:00.000Z', 15],
      ['Сводка Ольге', '2026-10-27T04:00:00.000Z', 5],
    ]);
  });
});

test('one occurrence of a series: «сделано», «Перенести» and «Удалить» act only on it', async () => {
  await withCalendar(async ({ userId, service }) => {
    // Daily 09:00 ЕКБ call with a reminder.
    const series = service.createEvent(userId, {
      type: 'call', title: 'Планёрка', startsAt: '2026-10-20T04:00:00Z', durationMin: 30, recurrence: 'FREQ=DAILY', remindBeforeMin: 10,
    });
    const at = (iso: string) => `${series.id}@${iso}`;
    const week = async () => (await service.listEvents({
      userId, ...WEEK, types: null, project: null, includeCancelled: false, includePackagedTimers: false, timeZone: null,
    })).items.filter((item) => item.occurrenceOf === series.id);

    // «Сделано» on Tuesday: only Tuesday is done.
    const done = service.setStatus(userId, at('2026-10-27T04:00:00.000Z'), 'done');
    assert.equal(done.id, at('2026-10-27T04:00:00.000Z'));
    assert.equal(done.status, 'done');
    let items = await week();
    assert.deepEqual(items.filter((item) => item.status === 'done').map((item) => item.startsAt), ['2026-10-27T04:00:00.000Z']);
    assert.equal(items.length, 7);
    assert.equal(service.getEvent(userId, series.id).status, 'planned', 'the series itself stays planned');

    // «Перенести · на час» on Wednesday: only Wednesday moves; its id stays the occurrence id.
    const moved = service.reschedule(userId, at('2026-10-28T04:00:00.000Z'), { preset: 'plus1h' });
    assert.equal(moved.id, at('2026-10-28T04:00:00.000Z'));
    assert.equal(moved.startsAt, '2026-10-28T05:00:00.000Z');
    assert.equal(moved.endsAt, '2026-10-28T05:30:00.000Z');
    assert.equal(moved.originalStartsAt, '2026-10-28T04:00:00.000Z');
    // Moving it again counts from where it is now.
    assert.equal(service.reschedule(userId, at('2026-10-28T04:00:00.000Z'), { preset: 'plus30m' }).startsAt, '2026-10-28T05:30:00.000Z');
    items = await week();
    assert.deepEqual(items.map((item) => item.startsAt).slice(1, 4), ['2026-10-27T04:00:00.000Z', '2026-10-28T05:30:00.000Z', '2026-10-29T04:00:00.000Z']);
    assert.equal(service.getEvent(userId, series.id).startsAt, '2026-10-20T04:00:00.000Z');

    // A move into the next range shows up there, not in the old one.
    service.reschedule(userId, at('2026-11-01T04:00:00.000Z'), { preset: 'tomorrow' });
    items = await week();
    assert.equal(items.some((item) => item.id === at('2026-11-01T04:00:00.000Z')), false);
    const nextWeek = await service.listEvents({
      userId, from: '2026-11-01T19:00:00.000Z', to: '2026-11-08T19:00:00.000Z', types: null, project: null,
      includeCancelled: false, includePackagedTimers: false, timeZone: null,
    });
    assert.equal(nextWeek.items.filter((item) => item.id === at('2026-11-01T04:00:00.000Z'))[0]?.startsAt, '2026-11-02T04:00:00.000Z');

    // «Удалить · только это» on Thursday: Thursday is gone, the series stays.
    service.deleteEvent(userId, at('2026-10-29T04:00:00.000Z'), 'occurrence');
    items = await week();
    assert.equal(items.some((item) => item.id === at('2026-10-29T04:00:00.000Z')), false);
    assert.equal(items.length, 5);

    // Reminders: the done one is out, the moved one at its new time, the deleted one gone.
    const reminders = service.listReminders(Date.parse('2026-10-26T19:00:00Z'), Date.parse('2026-10-29T19:00:00Z'), 'Asia/Yekaterinburg');
    assert.deepEqual(
      reminders.filter((item) => item.status === 'planned').map((item) => item.startsAt),
      ['2026-10-28T05:30:00.000Z'],
    );

    // «Вернуть в план» clears the done mark of that one.
    assert.equal(service.setStatus(userId, at('2026-10-27T04:00:00.000Z'), 'planned').status, 'planned');

    // An id that is not an occurrence of the series is refused.
    assert.throws(
      () => service.setStatus(userId, at('2026-10-27T04:17:00.000Z'), 'done'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );

    // «Перенести · вся серия» from an occurrence shifts the series by the same step.
    service.reschedule(userId, at('2026-10-30T04:00:00.000Z'), { preset: 'plus1h' }, 'series');
    assert.equal(service.getEvent(userId, series.id).startsAt, '2026-10-20T05:00:00.000Z');
    items = await week();
    // The exceptions follow their occurrences: Wednesday stays moved, Thursday stays deleted.
    assert.equal(items.find((item) => item.id === at('2026-10-28T05:00:00.000Z'))?.startsAt, '2026-10-28T05:30:00.000Z');
    assert.equal(items.some((item) => item.id === at('2026-10-29T05:00:00.000Z')), false);
    assert.equal(items.length, 5);

    // «Удалить · вся серия».
    service.deleteEvent(userId, at('2026-10-30T05:00:00.000Z'), 'series');
    assert.deepEqual(await week(), []);
  });
});

test('an event that started before the range and runs into it is listed (multi-day)', async () => {
  await withCalendar(async ({ userId, service }) => {
    // Sun 25.10 20:00 → Tue 27.10 10:00 ЕКБ: starts before the Mon–Sun week, runs into it.
    const trip = service.createEvent(userId, {
      type: 'meeting', title: 'Выезд', startsAt: '2026-10-25T15:00:00Z', endsAt: '2026-10-27T05:00:00Z',
    });
    // Every Sunday 22:00 ЕКБ for 12 hours: the occurrence of 25.10 ends Mon 10:00.
    const watch = service.createEvent(userId, {
      type: 'meeting', title: 'Дежурство', startsAt: '2026-10-18T17:00:00Z', endsAt: '2026-10-19T05:00:00Z', recurrence: 'FREQ=WEEKLY',
    });
    // Ended right at the start of the range: not in it.
    service.createEvent(userId, { type: 'call', title: 'Вчерашний', startsAt: '2026-10-25T18:30:00Z', durationMin: 30 });
    // No stored end: the meeting's default hour still reaches past midnight.
    service.createEvent(userId, { type: 'meeting', title: 'Поздняя', startsAt: '2026-10-25T18:30:00Z' });

    const listing = await service.listEvents({
      userId, ...WEEK, types: null, project: null, includeCancelled: false, includePackagedTimers: false, timeZone: null,
    });
    const own = listing.items.filter((item) => item.source === 'panel').map((item) => [item.title, item.startsAt, item.endsAt]);
    assert.deepEqual(own, [
      ['Выезд', '2026-10-25T15:00:00.000Z', '2026-10-27T05:00:00.000Z'],
      ['Дежурство', '2026-10-25T17:00:00.000Z', '2026-10-26T05:00:00.000Z'],
      ['Поздняя', '2026-10-25T18:30:00.000Z', '2026-10-25T19:30:00.000Z'],
      ['Дежурство', '2026-11-01T17:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ]);
    assert.ok(listing.items.some((item) => item.id === trip.id));
    assert.ok(listing.items.some((item) => item.occurrenceOf === watch.id));
  });
});
