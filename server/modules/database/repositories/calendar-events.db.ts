import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { CalendarEventStatus, CalendarEventType } from '@/shared/types.js';

/** One stored calendar event, exactly as the `calendar_events` table holds it. */
export type CalendarEventRow = {
  id: string;
  user_id: number;
  event_type: CalendarEventType;
  title: string;
  starts_at: string;
  ends_at: string | null;
  project_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_telegram: string | null;
  location: string | null;
  note: string | null;
  remind_before_min: number | null;
  status: CalendarEventStatus;
  session_id: string | null;
  recurrence: string | null;
  completed_at: string | null;
  prepared_at: string | null;
  prepare_message_id: string | null;
  google_event_id: string | null;
  etag: string | null;
  google_synced_at: string | null;
  /** `panel` — made in the panel; `google` — imported from Google Calendar, read-only. */
  origin: 'panel' | 'google';
  /** 1 while a local change of a panel event has not reached Google yet. */
  google_pending: number;
  google_error: string | null;
  /** 1 for an imported all-day Google event. */
  all_day: number;
  created_at: string;
  updated_at: string;
};

/** Columns a caller may write; `id`, `user_id` and timestamps are owned here. */
export type CalendarEventWritableFields = Partial<Pick<CalendarEventRow,
  | 'event_type'
  | 'title'
  | 'starts_at'
  | 'ends_at'
  | 'project_id'
  | 'contact_name'
  | 'contact_phone'
  | 'contact_telegram'
  | 'location'
  | 'note'
  | 'remind_before_min'
  | 'status'
  | 'session_id'
  | 'recurrence'
  | 'completed_at'
  | 'prepared_at'
  | 'prepare_message_id'
  | 'google_event_id'
  | 'etag'
  | 'google_synced_at'
  | 'origin'
  | 'google_pending'
  | 'google_error'
  | 'all_day'
>>;

/**
 * One exception of a recurring event (`calendar_event_overrides`): the
 * occurrence that the series generates at `original_start`, moved
 * (`starts_at` / `ends_at`), marked with its own `status`, or deleted on its
 * own (`status = 'cancelled'`, an EXDATE).
 */
export type CalendarOccurrenceOverrideRow = {
  event_id: string;
  user_id: number;
  original_start: string;
  starts_at: string | null;
  ends_at: string | null;
  status: CalendarEventStatus;
  completed_at: string | null;
  google_pending: number;
  google_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Columns of an override a caller may write. */
export type CalendarOccurrenceOverrideFields = Partial<Pick<CalendarOccurrenceOverrideRow,
  'starts_at' | 'ends_at' | 'status' | 'completed_at' | 'google_pending' | 'google_error'>>;

const OVERRIDE_COLUMNS: ReadonlyArray<keyof CalendarOccurrenceOverrideFields> = [
  'starts_at', 'ends_at', 'status', 'completed_at', 'google_pending', 'google_error',
];

/** One panel event deleted locally whose Google copy still has to be removed. */
export type CalendarGoogleDeletionRow = {
  google_event_id: string;
  user_id: number;
  panel_event_id: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
};

/** Sync bookkeeping of one Google calendar (`calendar_google_sync`). */
export type CalendarGoogleSyncRow = {
  calendar_id: string;
  user_id: number;
  calendar_name: string | null;
  sync_token: string | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_full_sync_at: string | null;
  last_error: string | null;
  updated_at: string;
};

// Whitelist: column names are interpolated into SQL, values never are.
const WRITABLE_COLUMNS: ReadonlyArray<keyof CalendarEventWritableFields> = [
  'event_type', 'title', 'starts_at', 'ends_at', 'project_id', 'contact_name', 'contact_phone',
  'contact_telegram', 'location', 'note', 'remind_before_min', 'status', 'session_id', 'recurrence',
  'completed_at', 'prepared_at', 'prepare_message_id', 'google_event_id', 'etag', 'google_synced_at',
  'origin', 'google_pending', 'google_error', 'all_day',
];

const SYNC_COLUMNS: ReadonlyArray<keyof Omit<CalendarGoogleSyncRow, 'calendar_id' | 'user_id' | 'updated_at'>> = [
  'calendar_name', 'sync_token', 'last_success_at', 'last_attempt_at', 'last_full_sync_at', 'last_error',
];

export const calendarEventsDb = {
  create(userId: number, fields: CalendarEventWritableFields & Pick<CalendarEventRow, 'event_type' | 'title' | 'starts_at'>): CalendarEventRow {
    const db = getConnection();
    const id = randomUUID();
    const columns = WRITABLE_COLUMNS.filter((column) => fields[column] !== undefined);
    db.prepare(
      `INSERT INTO calendar_events (id, user_id, ${columns.join(', ')})
       VALUES (?, ?, ${columns.map(() => '?').join(', ')})`,
    ).run(id, userId, ...columns.map((column) => fields[column] ?? null));
    return calendarEventsDb.getById(userId, id) as CalendarEventRow;
  },

  getById(userId: number, id: string): CalendarEventRow | undefined {
    return getConnection()
      .prepare('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?')
      .get(id, userId) as CalendarEventRow | undefined;
  },

  /** The event linked to a Google event id (panel or imported), if any. */
  getByGoogleEventId(userId: number, googleEventId: string): CalendarEventRow | undefined {
    return getConnection()
      .prepare('SELECT * FROM calendar_events WHERE google_event_id = ? AND user_id = ?')
      .get(googleEventId, userId) as CalendarEventRow | undefined;
  },

  /**
   * Planned events of every user that carry a reminder and may start in
   * `[fromIso, toIso)` (recurring ones are expanded by the calendar service).
   * Used for the Telegram reminders of the calendar.
   */
  listReminderCandidates(fromIso: string, toIso: string): CalendarEventRow[] {
    return getConnection()
      .prepare(
        `SELECT * FROM calendar_events
         WHERE remind_before_min IS NOT NULL
           AND status = 'planned'
           AND starts_at < ?
           AND (recurrence IS NOT NULL OR starts_at >= ?)
         ORDER BY starts_at ASC`,
      )
      .all(toIso, fromIso) as CalendarEventRow[];
  },

  /**
   * Events that may show up in `[fromIso, toIso)`: one-off events starting in
   * the range (or, for multi-day imports, still running in it), plus every
   * recurring event that began before its end (the service expands those).
   */
  listCandidatesInRange(userId: number, fromIso: string, toIso: string): CalendarEventRow[] {
    return getConnection()
      .prepare(
        `SELECT * FROM calendar_events
         WHERE user_id = ?
           AND starts_at < ?
           AND (recurrence IS NOT NULL OR starts_at >= ? OR (ends_at IS NOT NULL AND ends_at > ?))
         ORDER BY starts_at ASC`,
      )
      .all(userId, toIso, fromIso, fromIso) as CalendarEventRow[];
  },

  /** Panel events whose local change still has to reach Google (never imported ones). */
  listPendingGooglePush(userId: number, limit = 50): CalendarEventRow[] {
    return getConnection()
      .prepare(
        `SELECT * FROM calendar_events
         WHERE user_id = ? AND origin = 'panel' AND google_pending = 1
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(userId, limit) as CalendarEventRow[];
  },

  countPendingGooglePush(userId: number): number {
    const row = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ? AND origin = 'panel' AND google_pending = 1`)
      .get(userId) as { n: number };
    return row.n;
  },

  countImportedFromGoogle(userId: number): number {
    const row = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ? AND origin = 'google'`)
      .get(userId) as { n: number };
    return row.n;
  },

  update(userId: number, id: string, fields: CalendarEventWritableFields): CalendarEventRow | undefined {
    const columns = WRITABLE_COLUMNS.filter((column) => fields[column] !== undefined);
    if (columns.length > 0) {
      getConnection()
        .prepare(
          `UPDATE calendar_events
           SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?`,
        )
        .run(...columns.map((column) => fields[column] ?? null), id, userId);
    }
    return calendarEventsDb.getById(userId, id);
  },

  remove(userId: number, id: string): boolean {
    const db = getConnection();
    // The series' exceptions go with it (also without foreign keys enforced).
    db.prepare('DELETE FROM calendar_event_overrides WHERE event_id = ? AND user_id = ?').run(id, userId);
    return db
      .prepare('DELETE FROM calendar_events WHERE id = ? AND user_id = ?')
      .run(id, userId).changes > 0;
  },

  /** Exceptions of the given series, for expanding them. */
  listOccurrenceOverrides(userId: number, eventIds: string[]): CalendarOccurrenceOverrideRow[] {
    if (eventIds.length === 0) return [];
    return getConnection()
      .prepare(
        `SELECT * FROM calendar_event_overrides
         WHERE user_id = ? AND event_id IN (${eventIds.map(() => '?').join(', ')})
         ORDER BY original_start ASC`,
      )
      .all(userId, ...eventIds) as CalendarOccurrenceOverrideRow[];
  },

  getOccurrenceOverride(userId: number, eventId: string, originalStart: string): CalendarOccurrenceOverrideRow | undefined {
    return getConnection()
      .prepare('SELECT * FROM calendar_event_overrides WHERE user_id = ? AND event_id = ? AND original_start = ?')
      .get(userId, eventId, originalStart) as CalendarOccurrenceOverrideRow | undefined;
  },

  /** Creates or updates the exception of one occurrence; `undefined` fields are left as they are. */
  upsertOccurrenceOverride(
    userId: number,
    eventId: string,
    originalStart: string,
    fields: CalendarOccurrenceOverrideFields,
  ): CalendarOccurrenceOverrideRow {
    const db = getConnection();
    db.prepare(
      `INSERT INTO calendar_event_overrides (event_id, user_id, original_start) VALUES (?, ?, ?)
       ON CONFLICT(event_id, original_start) DO NOTHING`,
    ).run(eventId, userId, originalStart);
    const columns = OVERRIDE_COLUMNS.filter((column) => fields[column] !== undefined);
    if (columns.length > 0) {
      db.prepare(
        `UPDATE calendar_event_overrides
         SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE event_id = ? AND user_id = ? AND original_start = ?`,
      ).run(...columns.map((column) => fields[column] ?? null), eventId, userId, originalStart);
    }
    return calendarEventsDb.getOccurrenceOverride(userId, eventId, originalStart) as CalendarOccurrenceOverrideRow;
  },

  removeOccurrenceOverride(userId: number, eventId: string, originalStart: string): void {
    getConnection()
      .prepare('DELETE FROM calendar_event_overrides WHERE user_id = ? AND event_id = ? AND original_start = ?')
      .run(userId, eventId, originalStart);
  },

  /**
   * Re-keys every exception of a series after the whole series moved by
   * `shiftMs`, so «сделано», a moved and a deleted day stay with their
   * occurrences. Moved ones are flagged for Google again (a series time
   * change may drop instance changes there).
   */
  shiftOccurrenceOverrides(userId: number, eventId: string, shiftMs: number, flagGoogle: boolean): void {
    const db = getConnection();
    const rows = calendarEventsDb.listOccurrenceOverrides(userId, [eventId]);
    db.transaction(() => {
      db.prepare('DELETE FROM calendar_event_overrides WHERE user_id = ? AND event_id = ?').run(userId, eventId);
      const insert = db.prepare(
        `INSERT INTO calendar_event_overrides
           (event_id, user_id, original_start, starts_at, ends_at, status, completed_at, google_pending, google_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(
          eventId, userId, new Date(Date.parse(row.original_start) + shiftMs).toISOString(), row.starts_at, row.ends_at,
          row.status, row.completed_at, flagGoogle && row.status !== 'cancelled' ? 1 : row.google_pending, row.google_error,
          row.created_at,
        );
      }
    })();
  },

  /** Exceptions whose change still has to reach the series' Google event. */
  listPendingOverridePush(userId: number, limit = 50): CalendarOccurrenceOverrideRow[] {
    return getConnection()
      .prepare(
        `SELECT * FROM calendar_event_overrides
         WHERE user_id = ? AND google_pending = 1
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(userId, limit) as CalendarOccurrenceOverrideRow[];
  },

  countPendingOverridePush(userId: number): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM calendar_event_overrides WHERE user_id = ? AND google_pending = 1')
      .get(userId) as { n: number };
    return row.n;
  },

  /** Forgets an imported Google event (it was deleted or cancelled in Google). Panel events are never touched. */
  removeImported(userId: number, googleEventId: string): boolean {
    return getConnection()
      .prepare(`DELETE FROM calendar_events WHERE google_event_id = ? AND user_id = ? AND origin = 'google'`)
      .run(googleEventId, userId).changes > 0;
  },

  /** Google ids of the imported events starting at or after `fromIso` (a full resync prunes the ones Google no longer lists). */
  listImportedGoogleIdsFrom(userId: number, fromIso: string): string[] {
    return (getConnection()
      .prepare(`SELECT google_event_id FROM calendar_events
                WHERE user_id = ? AND origin = 'google' AND google_event_id IS NOT NULL AND starts_at >= ?`)
      .all(userId, fromIso) as Array<{ google_event_id: string }>).map((row) => row.google_event_id);
  },

  /** Queues the Google copy of a deleted panel event for removal. */
  queueGoogleDeletion(userId: number, googleEventId: string, panelEventId: string): void {
    getConnection()
      .prepare(
        `INSERT INTO calendar_google_deletions (google_event_id, user_id, panel_event_id)
         VALUES (?, ?, ?)
         ON CONFLICT(google_event_id) DO NOTHING`,
      )
      .run(googleEventId, userId, panelEventId);
  },

  listGoogleDeletions(userId: number): CalendarGoogleDeletionRow[] {
    return getConnection()
      .prepare('SELECT * FROM calendar_google_deletions WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as CalendarGoogleDeletionRow[];
  },

  hasGoogleDeletion(googleEventId: string): boolean {
    return Boolean(getConnection()
      .prepare('SELECT 1 FROM calendar_google_deletions WHERE google_event_id = ?')
      .get(googleEventId));
  },

  finishGoogleDeletion(googleEventId: string): void {
    getConnection().prepare('DELETE FROM calendar_google_deletions WHERE google_event_id = ?').run(googleEventId);
  },

  failGoogleDeletion(googleEventId: string, error: string): void {
    getConnection()
      .prepare('UPDATE calendar_google_deletions SET attempts = attempts + 1, last_error = ? WHERE google_event_id = ?')
      .run(error, googleEventId);
  },

  getSyncState(calendarId: string): CalendarGoogleSyncRow | undefined {
    return getConnection()
      .prepare('SELECT * FROM calendar_google_sync WHERE calendar_id = ?')
      .get(calendarId) as CalendarGoogleSyncRow | undefined;
  },

  /** Creates or updates the bookkeeping row of a calendar; `undefined` fields are left as they are. */
  saveSyncState(
    calendarId: string,
    userId: number,
    fields: Partial<Omit<CalendarGoogleSyncRow, 'calendar_id' | 'user_id' | 'updated_at'>>,
  ): CalendarGoogleSyncRow {
    const db = getConnection();
    db.prepare(
      `INSERT INTO calendar_google_sync (calendar_id, user_id) VALUES (?, ?)
       ON CONFLICT(calendar_id) DO UPDATE SET user_id = excluded.user_id`,
    ).run(calendarId, userId);
    const columns = SYNC_COLUMNS.filter((column) => fields[column] !== undefined);
    if (columns.length > 0) {
      db.prepare(
        `UPDATE calendar_google_sync
         SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE calendar_id = ?`,
      ).run(...columns.map((column) => fields[column] ?? null), calendarId);
    }
    return calendarEventsDb.getSyncState(calendarId) as CalendarGoogleSyncRow;
  },
};
