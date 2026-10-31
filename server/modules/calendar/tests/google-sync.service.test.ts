import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCalendarService } from '@/modules/calendar/services/calendar.service.js';
import { GoogleCalendarError } from '@/modules/calendar/services/google-calendar-client.service.js';
import type { GoogleCalendarEvent } from '@/modules/calendar/services/google-calendar-client.service.js';
import { createGoogleCalendarSync, readSyncConfig } from '@/modules/calendar/services/google-sync.service.js';
import { calendarEventsDb, closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const NOW = Date.parse('2026-10-26T05:00:00Z'); // Monday 10:00 in Yekaterinburg

/** An in-memory Google Calendar that records every write. */
function createFakeGoogle() {
  const store = new Map<string, GoogleCalendarEvent>();
  const writes: Array<{ op: 'insert' | 'patch' | 'delete'; id: string }> = [];
  let counter = 0;
  let changed: string[] = [];
  let expireToken = false;
  const touch = (id: string) => {
    changed.push(id);
  };
  /** Google's instance of a recurring event (`<master>_<20261027T040000Z>`), as events.get returns it. */
  const instanceOf = (id: string): GoogleCalendarEvent | null => {
    const match = /^(.+)_(\d{8}T\d{6}Z)$/.exec(id);
    const master = match ? store.get(match[1]) : undefined;
    if (!match || !master?.recurrence?.length) return null;
    const stamp = match[2];
    const start = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
    if (master.recurrence.some((line) => line.startsWith('EXDATE') && line.includes(stamp))) return { id, status: 'cancelled', recurringEventId: match[1] };
    return { ...master, id, etag: `"i${counter}"`, recurringEventId: match[1], recurrence: undefined, start: { dateTime: start } };
  };
  const client = {
    async getCalendar() {
      return { summary: 'owner@example.com', timeZone: 'Asia/Yekaterinburg' };
    },
    async listEvents(query: { syncToken?: string | null; timeMin?: string; pageToken?: string | null }) {
      if (query.syncToken && expireToken) {
        expireToken = false;
        throw new GoogleCalendarError('Google ответил 410', 410);
      }
      const ids = query.syncToken ? [...new Set(changed)] : [...store.keys()];
      changed = [];
      return { items: ids.map((id) => store.get(id)).filter(Boolean) as GoogleCalendarEvent[], nextPageToken: null, nextSyncToken: `tok-${++counter}` };
    },
    async getEvent(id: string) {
      return store.get(id) ?? instanceOf(id);
    },
    async findEventByPanelId(panelId: string) {
      return [...store.values()].find((event) => event.status !== 'cancelled'
        && event.extendedProperties?.private?.miragePanel === panelId) ?? null;
    },
    async insertEvent(body: Omit<GoogleCalendarEvent, 'id'>) {
      const id = `g${++counter}`;
      store.set(id, { ...body, id, etag: `"e${counter}"`, status: 'confirmed' });
      writes.push({ op: 'insert', id });
      return store.get(id) as GoogleCalendarEvent;
    },
    async patchEvent(id: string, body: Partial<GoogleCalendarEvent>) {
      const current = store.get(id) ?? instanceOf(id);
      if (!current) throw new GoogleCalendarError('Google ответил 404', 404);
      store.set(id, { ...current, ...body, id, etag: `"e${++counter}"` });
      writes.push({ op: 'patch', id });
      return store.get(id) as GoogleCalendarEvent;
    },
    async deleteEvent(id: string) {
      const current = store.get(id);
      if (current) store.set(id, { ...current, status: 'cancelled' });
      writes.push({ op: 'delete', id });
    },
  };
  return {
    client,
    store,
    writes,
    /** A change made by the user in Google (not by the panel). */
    userEdits(id: string, patch: Partial<GoogleCalendarEvent>) {
      store.set(id, { ...(store.get(id) ?? { id }), ...patch, id, etag: `"u${++counter}"` });
      touch(id);
    },
    expireSyncToken() {
      expireToken = true;
    },
  };
}

type Harness = {
  userId: number;
  google: ReturnType<typeof createFakeGoogle>;
  service: ReturnType<typeof createCalendarService>;
  sync: ReturnType<typeof createGoogleCalendarSync>;
};

async function withSync(options: { pushTitlePrefix?: string | null }, runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'calendar-google-sync-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    const userId = Number(userDb.createUser('alice', 'hash').id);
    const google = createFakeGoogle();
    const sync = createGoogleCalendarSync({
      config: {
        enabled: true,
        reason: null,
        calendarId: 'owner@example.com',
        timeZone: 'Asia/Yekaterinburg',
        pollIntervalMs: 120_000,
        pushTitlePrefix: options.pushTitlePrefix ?? null,
      },
      client: google.client,
      events: calendarEventsDb,
      resolveUserId: () => userId,
      now: () => NOW,
    });
    const service = createCalendarService({
      now: () => NOW,
      events: calendarEventsDb,
      listScheduledMessages: () => [],
      describeSession: () => ({ projectId: null, sessionTitle: '' }),
      getProject: () => null,
      listProjects: () => [],
      listServerTimers: async () => [],
      readTimerJournal: async () => null,
      createSession: () => ({ sessionId: 's' }),
      sessionExists: () => false,
      scheduleMessage: () => ({ id: 'sm', scheduledFor: new Date(NOW).toISOString() }),
    });
    await runTest({ userId, google, service, sync });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const FOREIGN: GoogleCalendarEvent = {
  id: 'alice-own-1',
  etag: '"v1"',
  status: 'confirmed',
  summary: 'Созвон с бухгалтером',
  description: '<b>Взять</b> отчёт',
  start: { dateTime: '2026-10-27T11:00:00+05:00' },
  end: { dateTime: '2026-10-27T11:30:00+05:00' },
};

test('panel calls, messages and meetings go to Google with the panel mark; agent tasks do not', async () => {
  await withSync({}, async ({ userId, google, service, sync }) => {
    const call = service.createEvent(userId, { type: 'call', title: 'Позвонить [имя]', startsAt: '2026-10-27T06:00:00Z' });
    service.createEvent(userId, { type: 'agent_task', title: 'Сводка', startsAt: '2026-10-27T04:00:00Z' });
    await sync.syncNow();

    assert.deepEqual(google.writes.map((write) => write.op), ['insert']);
    const pushed = google.store.get(google.writes[0].id) as GoogleCalendarEvent;
    assert.equal(pushed.summary, 'Позвонить [имя]');
    assert.equal(pushed.extendedProperties?.private?.miragePanel, call.id);
    assert.equal(pushed.start?.timeZone, 'Asia/Yekaterinburg');

    const item = service.getEvent(userId, call.id);
    assert.equal(item.google?.eventId, google.writes[0].id);
    assert.equal(item.google?.pending, false);
    assert.equal(sync.getStatus().state, 'idle');
    assert.ok(sync.getStatus().lastSuccessAt);

    // «Перенести» is patched into the same Google event, not duplicated.
    service.reschedule(userId, call.id, { preset: 'plus1h' });
    await sync.syncNow();
    assert.deepEqual(google.writes.map((write) => write.op), ['insert', 'patch']);
    assert.equal(google.store.get(google.writes[0].id)?.start?.dateTime, '2026-10-27T07:00:00.000Z');
  });
});

test('a move or a delete made in Google comes back to the panel event', async () => {
  await withSync({}, async ({ userId, google, service, sync }) => {
    const meeting = service.createEvent(userId, { type: 'meeting', title: 'Встреча', startsAt: '2026-10-28T09:00:00Z' });
    await sync.syncNow();
    const googleId = google.writes[0].id;

    google.userEdits(googleId, { start: { dateTime: '2026-10-28T16:00:00+05:00' }, end: { dateTime: '2026-10-28T17:00:00+05:00' } });
    await sync.syncNow();
    assert.equal(service.getEvent(userId, meeting.id).startsAt, '2026-10-28T11:00:00.000Z');
    assert.equal(google.writes.length, 1, 'pulling a change writes nothing back');

    google.userEdits(googleId, { status: 'cancelled' });
    await sync.syncNow();
    const cancelled = service.getEvent(userId, meeting.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.google, null);
  });
});

test('the user\'s own Google events are imported read-only and never written back', async () => {
  await withSync({}, async ({ userId, google, service, sync }) => {
    google.userEdits(FOREIGN.id, FOREIGN);
    await sync.syncNow();

    const listing = await service.listEvents({
      userId, from: '2026-10-26T00:00:00Z', to: '2026-11-01T00:00:00Z', types: null, project: null,
      includeCancelled: false, includePackagedTimers: false, timeZone: 'Asia/Yekaterinburg',
    });
    const imported = listing.items.find((item) => item.google?.eventId === FOREIGN.id);
    assert.ok(imported);
    assert.equal(imported.source, 'google');
    assert.equal(imported.type, 'call');
    assert.equal(imported.readOnly, true);
    assert.equal(imported.note, 'Взять отчёт');

    // Editing, moving or deleting it in the panel is refused.
    for (const attempt of [
      () => service.updateEvent(userId, imported.id, { title: 'Другое' }),
      () => service.reschedule(userId, imported.id, { preset: 'plus1h' }),
      () => service.deleteEvent(userId, imported.id),
    ]) {
      assert.throws(attempt, (error: unknown) => error instanceof AppError && error.code === 'CALENDAR_GOOGLE_READ_ONLY');
    }
    // «Отметить сделанным» stays local.
    assert.equal(service.setStatus(userId, imported.id, 'done').status, 'done');
    await sync.syncNow();
    assert.deepEqual(google.writes, []);
    assert.equal(google.store.get(FOREIGN.id)?.summary, FOREIGN.summary);

    // Deleted in Google — gone from the panel.
    google.userEdits(FOREIGN.id, { status: 'cancelled' });
    await sync.syncNow();
    assert.equal(calendarEventsDb.getByGoogleEventId(userId, FOREIGN.id), undefined);
  });
});

test('guard: a panel event pointed at a foreign Google event never patches or deletes it', async () => {
  await withSync({}, async ({ userId, google, service, sync }) => {
    google.userEdits(FOREIGN.id, FOREIGN);
    await sync.syncNow();
    const imported = calendarEventsDb.getByGoogleEventId(userId, FOREIGN.id);
    assert.ok(imported);
    calendarEventsDb.removeImported(userId, FOREIGN.id);

    // The API cannot set the link…
    const call = service.createEvent(userId, { type: 'call', title: 'Звонок', startsAt: '2026-10-27T06:00:00Z' });
    service.updateEvent(userId, call.id, { google: { eventId: FOREIGN.id, etag: '"x"' } });
    assert.notEqual(calendarEventsDb.getById(userId, call.id)?.google_event_id, FOREIGN.id);

    // …and even a corrupted row (link forced in the database) does not touch the foreign event.
    calendarEventsDb.update(userId, call.id, { google_event_id: FOREIGN.id, google_pending: 1 });
    await sync.syncNow();
    assert.equal(google.writes.filter((write) => write.id === FOREIGN.id).length, 0);
    assert.match(calendarEventsDb.getById(userId, call.id)?.google_error ?? '', /не принадлежит панели/);

    // A queued Google deletion of a foreign event is dropped without deleting it.
    calendarEventsDb.queueGoogleDeletion(userId, FOREIGN.id, call.id);
    await sync.syncNow();
    assert.equal(google.writes.filter((write) => write.id === FOREIGN.id).length, 0);
    assert.equal(google.store.get(FOREIGN.id)?.status, 'confirmed');
    assert.deepEqual(calendarEventsDb.listGoogleDeletions(userId), []);
  });
});

test('deleting a panel event removes its own Google copy', async () => {
  await withSync({}, async ({ userId, google, service, sync }) => {
    const message = service.createEvent(userId, { type: 'message', title: 'Написать', startsAt: '2026-10-27T06:00:00Z' });
    await sync.syncNow();
    const googleId = google.writes[0].id;
    service.deleteEvent(userId, message.id);
    await sync.syncNow();
    assert.deepEqual(google.writes.map((write) => write.op), ['insert', 'delete']);
    assert.equal(google.store.get(googleId)?.status, 'cancelled');
    assert.deepEqual(calendarEventsDb.listGoogleDeletions(userId), []);
  });
});

test('an expired sync token (410) falls back to a full resync', async () => {
  await withSync({}, async ({ userId, google, sync }) => {
    await sync.syncNow();
    google.expireSyncToken();
    google.userEdits(FOREIGN.id, FOREIGN);
    await sync.syncNow();
    assert.ok(calendarEventsDb.getByGoogleEventId(userId, FOREIGN.id));
    assert.equal(sync.getStatus().lastError, null);
    assert.ok(sync.getStatus().lastFullSyncAt);
  });
});

test('on a test stand only events with the given title prefix go to Google', async () => {
  await withSync({ pushTitlePrefix: 'Мираж · тест' }, async ({ userId, google, service, sync }) => {
    const other = service.createEvent(userId, { type: 'call', title: 'Позвонить клиенту', startsAt: '2026-10-27T06:00:00Z' });
    service.createEvent(userId, { type: 'call', title: 'Мираж · тест звонка', startsAt: '2026-10-27T07:00:00Z' });
    await sync.syncNow();
    assert.equal(google.writes.length, 1);
    assert.equal(google.store.get(google.writes[0].id)?.summary, 'Мираж · тест звонка');
    assert.match(service.getEvent(userId, other.id).google?.error ?? '', /Стенд/);
  });
});

test('exceptions of a series reach Google: a deleted repeat as EXDATE, a moved or done one as its instance', async () => {
  await withSync({}, async ({ userId, google, service, sync }) => {
    const series = service.createEvent(userId, {
      type: 'call', title: 'Планёрка', startsAt: '2026-10-20T04:00:00Z', durationMin: 30, recurrence: 'FREQ=DAILY',
    });
    await sync.syncNow();
    const masterId = google.writes[0].id;

    service.deleteEvent(userId, `${series.id}@2026-10-29T04:00:00.000Z`, 'occurrence');
    service.reschedule(userId, `${series.id}@2026-10-28T04:00:00.000Z`, { preset: 'plus1h' });
    service.setStatus(userId, `${series.id}@2026-10-27T04:00:00.000Z`, 'done');
    await sync.syncNow();

    assert.deepEqual(google.store.get(masterId)?.recurrence, ['RRULE:FREQ=DAILY', 'EXDATE:20261029T040000Z']);
    const movedInstance = google.store.get(`${masterId}_20261028T040000Z`);
    assert.equal(movedInstance?.start?.dateTime, '2026-10-28T05:00:00.000Z');
    assert.equal(movedInstance?.end?.dateTime, '2026-10-28T05:30:00.000Z');
    assert.match(google.store.get(`${masterId}_20261027T040000Z`)?.description ?? '', /сделано/);
    // The master keeps its own time, nothing else was written.
    assert.equal(google.store.get(masterId)?.start?.dateTime, '2026-10-20T04:00:00.000Z');
    assert.equal(sync.getStatus().pendingPush, 0);
    assert.equal(sync.getStatus().lastError, null);

    // Guard: whatever sits under the instance id must be an instance of this series, or it is not touched.
    const foreignId = `${masterId}_20261030T040000Z`;
    google.store.set(foreignId, { ...FOREIGN, id: foreignId });
    service.setStatus(userId, `${series.id}@2026-10-30T04:00:00.000Z`, 'done');
    await sync.syncNow();
    assert.equal(google.writes.filter((write) => write.id === foreignId).length, 0);
    assert.equal(google.store.get(foreignId)?.summary, FOREIGN.summary);
    assert.equal(sync.getStatus().pendingPush, 0, 'a refused instance is not retried forever');
  });
});

test('a date-only UNTIL goes to Google as the end of that day in the panel zone, not in UTC', async () => {
  await withSync({}, async ({ userId, google, service, sync }) => {
    // Daily at 02:00 ЕКБ (21:00 UTC the day before) until 3 November.
    service.createEvent(userId, {
      type: 'call', title: 'Ночной созвон', startsAt: '2026-10-26T21:00:00Z', recurrence: 'FREQ=DAILY;UNTIL=20261103',
    });
    await sync.syncNow();
    const pushed = google.store.get(google.writes[0].id) as GoogleCalendarEvent;
    // 3 Nov 23:59:59 in Yekaterinburg is 18:59:59 UTC; UTC end of day would add 4 Nov 02:00 ЕКБ in Google.
    assert.deepEqual(pushed.recurrence, ['RRULE:FREQ=DAILY;UNTIL=20261103T185959Z']);
  });
});

test('the Google sync has no defaults: off until the key file and the calendar are both set', () => {
  const exists = () => true;
  const off = readSyncConfig({}, exists);
  assert.equal(off.enabled, false);
  assert.match(off.reason ?? '', /MIRAGE_GOOGLE_CREDENTIALS и MIRAGE_GOOGLE_CALENDAR_ID/);
  assert.equal(off.credentialsPath, '');
  assert.equal(off.calendarId, '');
  assert.equal(readSyncConfig({ MIRAGE_GOOGLE_CREDENTIALS: '/srv/key.json' }, exists).enabled, false);
  assert.equal(readSyncConfig({ MIRAGE_GOOGLE_CALENDAR_ID: 'team@example.com' }, exists).enabled, false);

  const on = readSyncConfig({ MIRAGE_GOOGLE_CREDENTIALS: '/srv/key.json', MIRAGE_GOOGLE_CALENDAR_ID: 'team@example.com' }, exists);
  assert.equal(on.enabled, true);
  assert.equal(on.calendarId, 'team@example.com');
  const noFile = readSyncConfig({ MIRAGE_GOOGLE_CREDENTIALS: '/srv/key.json', MIRAGE_GOOGLE_CALENDAR_ID: 'team@example.com' }, () => false);
  assert.equal(noFile.reason, 'нет файла ключа сервисного аккаунта Google');
  assert.equal(readSyncConfig({ MIRAGE_GOOGLE_SYNC: 'off', MIRAGE_GOOGLE_CREDENTIALS: '/srv/key.json', MIRAGE_GOOGLE_CALENDAR_ID: 'x' }, exists).enabled, false);
});
