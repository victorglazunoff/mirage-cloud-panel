import { existsSync } from 'node:fs';

import { calendarEventsDb, userDb } from '@/modules/database/index.js';
import type { CalendarEventRow, CalendarEventWritableFields } from '@/modules/database/index.js';
import type { CalendarEventType, CalendarSyncStatus } from '@/shared/types.js';

import { addLocalDays, defaultCalendarTimeZone, parseRecurrenceRule, zonedTimeToUtc } from './calendar-time.service.js';
import { createGoogleCalendarClient, GoogleCalendarError } from './google-calendar-client.service.js';
import type { GoogleCalendarClient, GoogleCalendarEvent, GoogleCalendarEventBody } from './google-calendar-client.service.js';

/** Types that go to Google Calendar; agent tasks, scheduled messages and server timers stay in the panel. */
export const GOOGLE_SYNCED_TYPES: ReadonlyArray<CalendarEventType> = ['call', 'message', 'meeting'];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000;
/** A local change reaches Google this long after the last edit (edits in a burst go together). */
const PUSH_DEBOUNCE_MS = 3_000;
/** The first run waits for the server to settle. */
const FIRST_RUN_DELAY_MS = 5_000;
/** A full sync imports Google events from this far back. */
const FULL_SYNC_LOOKBACK_MS = 30 * DAY_MS;
const MAX_LIST_PAGES = 40;
const MAX_DELETE_ATTEMPTS = 10;
const DEFAULT_LENGTH_MIN: Partial<Record<CalendarEventType, number>> = { call: 30, message: 15, meeting: 60 };
const TYPE_LABEL: Partial<Record<CalendarEventType, string>> = { call: 'Звонок', message: 'Сообщение', meeting: 'Встреча' };
const PANEL_MARK = 'miragePanel';

type SyncConfig = {
  enabled: boolean;
  /** Why the sync is off (shown on the calendar screen). */
  reason: string | null;
  calendarId: string;
  timeZone: string;
  pollIntervalMs: number;
  /** Test stands: only panel events whose title starts with it go to Google. */
  pushTitlePrefix: string | null;
};

type SyncDependencies = {
  config: SyncConfig;
  client: Pick<GoogleCalendarClient, 'getCalendar' | 'listEvents' | 'getEvent' | 'findEventByPanelId' | 'insertEvent' | 'patchEvent' | 'deleteEvent'>;
  events: typeof calendarEventsDb;
  /** The panel user whose events are synced (the panel is single-user). */
  resolveUserId(): number | null;
  now(): number;
  log?(message: string): void;
};

function errorText(error: unknown): string {
  if (error instanceof GoogleCalendarError) return error.message;
  if (error instanceof Error) return error.message.slice(0, 300);
  return 'Неизвестная ошибка синхронизации.';
}

function panelMark(event: GoogleCalendarEvent): string | null {
  return event.extendedProperties?.private?.[PANEL_MARK] ?? null;
}

/** `20261130T000000Z` from a UTC instant, the RRULE UNTIL form Google accepts. */
function compactUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * The UTC UNTIL of a rule. A date-only UNTIL (`UNTIL=20261103`) ends the
 * series on that day in the panel zone, as the panel expands it; Google wants
 * a UTC instant there (the start has a zone), so it is the zone's last second
 * of that day, not 23:59:59 UTC.
 */
function googleUntilMs(rule: NonNullable<ReturnType<typeof parseRecurrenceRule>>, timeZone: string): number | null {
  if (rule.untilDay === undefined) return rule.untilMs;
  const lastDay = new Date(rule.untilDay * DAY_MS);
  const nextDay = addLocalDays({ year: lastDay.getUTCFullYear(), month: lastDay.getUTCMonth() + 1, day: lastDay.getUTCDate() }, 1);
  return zonedTimeToUtc({ ...nextDay, hour: 0, minute: 0 }, timeZone) - 1000;
}

/**
 * The panel's RRULE subset as Google's `recurrence` lines, plus one EXDATE
 * line for the occurrences deleted on their own (UTC, the RECURRENCE-ID form
 * Google accepts next to a zoned start); null when the rule does not parse.
 */
function toGoogleRecurrence(rule: string | null, timeZone: string, exdates: string[] = []): string[] | null {
  if (!rule) return null;
  const parsed = parseRecurrenceRule(rule);
  if (!parsed) return null;
  const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const parts = [`FREQ=${parsed.freq}`];
  if (parsed.interval > 1) parts.push(`INTERVAL=${parsed.interval}`);
  if (parsed.byDay.length) parts.push(`BYDAY=${parsed.byDay.map((day) => days[day]).join(',')}`);
  const untilMs = googleUntilMs(parsed, timeZone);
  if (untilMs !== null) parts.push(`UNTIL=${compactUtc(untilMs)}`);
  if (parsed.count !== null) parts.push(`COUNT=${parsed.count}`);
  const lines = [`RRULE:${parts.join(';')}`];
  if (exdates.length) lines.push(`EXDATE:${exdates.map((iso) => compactUtc(Date.parse(iso))).join(',')}`);
  return lines;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Imported Google events become calls when their title says so, meetings otherwise. */
function guessImportedType(title: string): CalendarEventType {
  return /(^|[^а-яё])(по)?звон|созвон|\bcall\b/iu.test(title) ? 'call' : 'meeting';
}

/**
 * The Google body of a panel event. The panel id rides in
 * `extendedProperties.private.miragePanel`: it is how the sync recognises its
 * own events and the guard that keeps it away from everyone else's.
 */
function toGoogleBody(row: CalendarEventRow, timeZone: string, forPatch: boolean, exdates: string[] = []): Partial<GoogleCalendarEventBody> {
  const startMs = Date.parse(row.starts_at);
  const storedEnd = row.ends_at ? Date.parse(row.ends_at) : Number.NaN;
  const endMs = Number.isFinite(storedEnd) && storedEnd > startMs
    ? storedEnd
    : startMs + (DEFAULT_LENGTH_MIN[row.event_type] ?? 30) * MINUTE_MS;
  const contact = [row.contact_name, row.contact_phone, row.contact_telegram].filter(Boolean).join(' · ');
  const description = [
    `${TYPE_LABEL[row.event_type] ?? 'Событие'} · из панели Mirage${row.status === 'done' ? ' · сделано' : ''}`,
    contact ? `Контакт: ${contact}` : null,
    row.note ? `\n${row.note}` : null,
  ].filter(Boolean).join('\n');
  const recurrence = toGoogleRecurrence(row.recurrence, timeZone, exdates);
  const body: Partial<GoogleCalendarEventBody> = {
    summary: row.title,
    description,
    location: row.location ?? (forPatch ? '' : undefined),
    start: { dateTime: new Date(startMs).toISOString(), timeZone },
    end: { dateTime: new Date(endMs).toISOString(), timeZone },
    extendedProperties: { private: { [PANEL_MARK]: row.id, miragePanelType: row.event_type } },
    reminders: row.remind_before_min !== null
      ? { useDefault: false, overrides: [{ method: 'popup', minutes: row.remind_before_min }] }
      : { useDefault: true },
  };
  if (recurrence) body.recurrence = recurrence;
  else if (forPatch) body.recurrence = [];
  return body;
}

/**
 * Creates the two-way Google Calendar sync of the calendar module.
 *
 * Out: panel calls, messages and meetings are inserted / patched / deleted in
 * Google, marked with their panel id; agent tasks, scheduled messages and
 * server timers never go. Before any patch or delete the Google event is read
 * back and must carry this event's panel id — an event the panel did not make
 * is never modified or removed.
 *
 * In: `events.list` with a `syncToken` every two minutes (a 410 restarts with a
 * full sync). A moved own event takes the new time, a deleted one is cancelled;
 * the user's own Google events are imported read-only (`origin = 'google'`).
 */
export function createGoogleCalendarSync(dependencies: SyncDependencies) {
  const { config, client, events } = dependencies;
  const log = dependencies.log ?? (() => undefined);
  let running: Promise<void> | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let soonTimer: NodeJS.Timeout | null = null;
  let firstTimer: NodeJS.Timeout | null = null;
  let calendarName: string | null = null;
  const nowIso = () => new Date(dependencies.now()).toISOString();

  /** Removes a Google event only if it is this panel event's own copy. */
  const deleteOwnGoogleEvent = async (googleEventId: string, panelEventId: string): Promise<'deleted' | 'gone' | 'foreign'> => {
    const remote = await client.getEvent(googleEventId);
    if (!remote || remote.status === 'cancelled') return 'gone';
    if (panelMark(remote) !== panelEventId) {
      log(`[calendar-sync] не удаляю ${googleEventId}: событие не принадлежит панели`);
      return 'foreign';
    }
    await client.deleteEvent(googleEventId, remote.etag);
    return 'deleted';
  };

  const pushDeletions = async (userId: number): Promise<string[]> => {
    const failures: string[] = [];
    for (const deletion of events.listGoogleDeletions(userId)) {
      try {
        await deleteOwnGoogleEvent(deletion.google_event_id, deletion.panel_event_id);
        events.finishGoogleDeletion(deletion.google_event_id);
      } catch (error) {
        if (deletion.attempts + 1 >= MAX_DELETE_ATTEMPTS) {
          events.finishGoogleDeletion(deletion.google_event_id);
        } else {
          events.failGoogleDeletion(deletion.google_event_id, errorText(error));
        }
        failures.push(errorText(error));
      }
    }
    return failures;
  };

  const pushPending = async (userId: number): Promise<string[]> => {
    const failures: string[] = [];
    for (const row of events.listPendingGooglePush(userId)) {
      // Imported events are never written back, whatever their flags say.
      if (row.origin !== 'panel') {
        events.update(userId, row.id, { google_pending: 0 });
        continue;
      }
      const markDone = (fields: CalendarEventWritableFields) => {
        // An edit made while this push was in flight keeps the event pending.
        const current = events.getById(userId, row.id);
        const changedMeanwhile = current && current.updated_at !== row.updated_at;
        events.update(userId, row.id, {
          ...fields,
          google_pending: changedMeanwhile ? 1 : 0,
          google_error: null,
          google_synced_at: nowIso(),
        });
      };
      try {
        const belongsInGoogle = GOOGLE_SYNCED_TYPES.includes(row.event_type) && row.status !== 'cancelled';
        if (!belongsInGoogle && !row.google_event_id) {
          markDone({});
          continue;
        }
        if (config.pushTitlePrefix && !row.title.startsWith(config.pushTitlePrefix) && !row.google_event_id) {
          events.update(userId, row.id, {
            google_pending: 0,
            google_error: `Стенд: в Google уходят только события «${config.pushTitlePrefix}…»`,
          });
          continue;
        }
        if (!belongsInGoogle) {
          if (row.google_event_id) await deleteOwnGoogleEvent(row.google_event_id, row.id);
          markDone({ google_event_id: null, etag: null });
          continue;
        }

        // Occurrences deleted on their own go with the series as EXDATE.
        const exdates = row.recurrence
          ? events.listOccurrenceOverrides(userId, [row.id]).filter((override) => override.status === 'cancelled').map((override) => override.original_start)
          : [];
        const body = toGoogleBody(row, config.timeZone, Boolean(row.google_event_id), exdates);
        if (row.google_event_id) {
          const remote = await client.getEvent(row.google_event_id);
          if (!remote || remote.status === 'cancelled') {
            // Deleted in Google meanwhile: the deletion wins, the event is cancelled here.
            events.update(userId, row.id, {
              status: 'cancelled', completed_at: nowIso(), google_event_id: null, etag: null,
              google_pending: 0, google_error: null, google_synced_at: nowIso(),
            });
            continue;
          }
          if (panelMark(remote) !== row.id) {
            log(`[calendar-sync] не меняю ${row.google_event_id}: событие не принадлежит панели`);
            events.update(userId, row.id, {
              google_event_id: null, etag: null, google_pending: 0,
              google_error: 'Связанное событие Google не принадлежит панели — не трогаю его.',
            });
            continue;
          }
          const patched = await client.patchEvent(row.google_event_id, body, remote.etag);
          markDone({ etag: patched.etag ?? null });
        } else {
          // A push cut off after Google accepted it left a copy: adopt it instead of duplicating.
          const existing = await client.findEventByPanelId(row.id);
          const saved = existing
            ? await client.patchEvent(existing.id, toGoogleBody(row, config.timeZone, true, exdates), existing.etag)
            : await client.insertEvent(body as GoogleCalendarEventBody);
          markDone({ google_event_id: saved.id, etag: saved.etag ?? null });
        }
      } catch (error) {
        events.update(userId, row.id, { google_error: errorText(error) });
        failures.push(errorText(error));
      }
    }
    return failures;
  };

  /**
   * Pushes the moved or done occurrences of panel series to their Google
   * instances (`<series>_<20261028T040000Z>`). Before a patch the instance is
   * read back and must be an instance of this series' own Google event; a
   * deleted occurrence needs nothing here (its EXDATE goes with the series).
   */
  const pushOverrides = async (userId: number): Promise<string[]> => {
    const failures: string[] = [];
    for (const override of events.listPendingOverridePush(userId)) {
      const settle = (fields: { google_error?: string | null }) => {
        // A change made while this push was in flight keeps the exception pending.
        const current = events.getOccurrenceOverride(userId, override.event_id, override.original_start);
        const changedMeanwhile = current && current.updated_at !== override.updated_at;
        events.upsertOccurrenceOverride(userId, override.event_id, override.original_start, {
          google_pending: changedMeanwhile ? 1 : 0,
          google_error: fields.google_error ?? null,
        });
      };
      const series = events.getById(userId, override.event_id);
      if (!series || series.origin !== 'panel' || !series.recurrence || series.status === 'cancelled'
        || !GOOGLE_SYNCED_TYPES.includes(series.event_type)) {
        settle({});
        continue;
      }
      // The series has to be in Google first (its insert or patch is pending or was not allowed).
      if (!series.google_event_id) {
        if (!series.google_pending) settle({});
        continue;
      }
      if (series.google_pending) continue;
      if (override.status === 'cancelled') {
        settle({});
        continue;
      }
      try {
        const originalMs = Date.parse(override.original_start);
        const instanceId = `${series.google_event_id}_${compactUtc(originalMs)}`;
        const remote = await client.getEvent(instanceId);
        if (!remote || remote.status === 'cancelled' || remote.recurringEventId !== series.google_event_id) {
          log(`[calendar-sync] не меняю ${instanceId}: это не повтор серии панели`);
          settle({ google_error: 'Повтор не найден в Google как часть серии — не трогаю его.' });
          continue;
        }
        const base = toGoogleBody({ ...series, status: override.status }, config.timeZone, true);
        const length = Date.parse(base.end?.dateTime as string) - Date.parse(base.start?.dateTime as string);
        const startMs = override.starts_at ? Date.parse(override.starts_at) : originalMs;
        const endMs = override.starts_at && override.ends_at ? Date.parse(override.ends_at) : startMs + length;
        await client.patchEvent(instanceId, {
          start: { dateTime: new Date(startMs).toISOString(), timeZone: config.timeZone },
          end: { dateTime: new Date(endMs).toISOString(), timeZone: config.timeZone },
          description: base.description,
        }, remote.etag);
        settle({});
      } catch (error) {
        events.upsertOccurrenceOverride(userId, override.event_id, override.original_start, { google_error: errorText(error) });
        failures.push(errorText(error));
      }
    }
    return failures;
  };

  const readTimes = (event: GoogleCalendarEvent): { startMs: number; endMs: number; allDay: boolean } | null => {
    const readDate = (value: string) => {
      const [year, month, day] = value.split('-').map(Number);
      return zonedTimeToUtc({ year, month, day, hour: 0, minute: 0 }, config.timeZone);
    };
    if (event.start?.dateTime) {
      const startMs = Date.parse(event.start.dateTime);
      const endMs = event.end?.dateTime ? Date.parse(event.end.dateTime) : startMs + 60 * MINUTE_MS;
      return Number.isFinite(startMs) ? { startMs, endMs: Number.isFinite(endMs) ? endMs : startMs, allDay: false } : null;
    }
    if (event.start?.date) {
      const startMs = readDate(event.start.date);
      const endMs = event.end?.date ? readDate(event.end.date) : startMs + DAY_MS;
      return { startMs, endMs, allDay: true };
    }
    return null;
  };

  /** Applies one changed Google event to the panel. */
  const applyRemote = (userId: number, event: GoogleCalendarEvent): void => {
    const mark = panelMark(event);
    if (mark) {
      const own = events.getById(userId, mark);
      if (own && own.origin === 'panel') {
        // Instances of a recurring panel event and stale copies are not separate panel events.
        if (event.recurringEventId) return;
        if (own.google_event_id && own.google_event_id !== event.id) return;
        if (event.status === 'cancelled') {
          if (own.status !== 'cancelled' || own.google_event_id) {
            events.update(userId, own.id, {
              status: 'cancelled', completed_at: own.completed_at ?? nowIso(), google_event_id: null, etag: null,
              google_pending: 0, google_error: null, google_synced_at: nowIso(),
            });
          }
          return;
        }
        // A local change not yet pushed wins; the push overwrites Google.
        if (own.google_pending) return;
        const times = readTimes(event);
        if (!times) return;
        events.update(userId, own.id, {
          title: event.summary?.trim() || own.title,
          starts_at: new Date(times.startMs).toISOString(),
          ends_at: new Date(times.endMs).toISOString(),
          location: event.location?.trim() || null,
          google_event_id: event.id,
          etag: event.etag ?? null,
          google_synced_at: nowIso(),
          google_error: null,
        });
        return;
      }
      // Its panel row was deleted here and the Google delete is queued.
      if (events.hasGoogleDeletion(event.id)) return;
      // Otherwise it is another panel's event (a test stand): shown read-only like any Google event.
    }

    const existing = events.getByGoogleEventId(userId, event.id);
    // Never overwrite a panel event from here — its link is handled above.
    if (existing && existing.origin !== 'google') return;
    if (event.status === 'cancelled') {
      events.removeImported(userId, event.id);
      return;
    }
    const times = readTimes(event);
    if (!times) return;
    const title = event.summary?.trim() || '(без названия)';
    const fields: CalendarEventWritableFields = {
      title: title.slice(0, 300),
      starts_at: new Date(times.startMs).toISOString(),
      ends_at: new Date(times.endMs).toISOString(),
      location: event.location?.trim().slice(0, 300) || null,
      note: event.description ? htmlToText(event.description).slice(0, 10_000) || null : null,
      all_day: times.allDay ? 1 : 0,
      etag: event.etag ?? null,
      google_synced_at: nowIso(),
      google_pending: 0,
    };
    if (existing) {
      events.update(userId, existing.id, fields);
    } else {
      events.create(userId, {
        ...fields,
        event_type: guessImportedType(title),
        title: fields.title as string,
        starts_at: fields.starts_at as string,
        origin: 'google',
        google_event_id: event.id,
      });
    }
  };

  const pull = async (userId: number): Promise<void> => {
    const state = events.getSyncState(config.calendarId);
    let syncToken = state?.sync_token ?? null;
    let full = !syncToken;
    const timeMin = new Date(dependencies.now() - FULL_SYNC_LOOKBACK_MS).toISOString();
    const seen = new Set<string>();

    const listAll = async () => {
      let pageToken: string | null = null;
      let nextSyncToken: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await client.listEvents({ syncToken: full ? null : syncToken, timeMin, pageToken });
        for (const item of result.items) {
          seen.add(item.id);
          applyRemote(userId, item);
        }
        pageToken = result.nextPageToken;
        nextSyncToken = result.nextSyncToken ?? nextSyncToken;
        if (!pageToken) break;
      }
      return nextSyncToken;
    };

    let nextSyncToken: string | null;
    try {
      nextSyncToken = await listAll();
    } catch (error) {
      if (!(error instanceof GoogleCalendarError && error.status === 410) || full) throw error;
      // The sync token expired: start over with a full listing.
      log('[calendar-sync] syncToken устарел — полная синхронизация');
      full = true;
      syncToken = null;
      events.saveSyncState(config.calendarId, userId, { sync_token: null });
      nextSyncToken = await listAll();
    }

    if (full) {
      // Imported events Google no longer lists in the window were deleted there.
      for (const googleEventId of events.listImportedGoogleIdsFrom(userId, timeMin)) {
        if (!seen.has(googleEventId)) events.removeImported(userId, googleEventId);
      }
    }
    events.saveSyncState(config.calendarId, userId, {
      sync_token: nextSyncToken,
      ...(full ? { last_full_sync_at: nowIso() } : {}),
    });
  };

  const runOnce = async (): Promise<void> => {
    const userId = dependencies.resolveUserId();
    if (userId === null) return;
    events.saveSyncState(config.calendarId, userId, { last_attempt_at: nowIso() });
    try {
      if (!calendarName) {
        calendarName = (await client.getCalendar()).summary;
        events.saveSyncState(config.calendarId, userId, { calendar_name: calendarName });
      }
      const failures = [...await pushDeletions(userId), ...await pushPending(userId), ...await pushOverrides(userId)];
      await pull(userId);
      if (failures.length) {
        throw new Error(`Не отправлено в Google: ${failures.length} — ${failures[0]}`);
      }
      events.saveSyncState(config.calendarId, userId, { last_success_at: nowIso(), last_error: null });
    } catch (error) {
      log(`[calendar-sync] ошибка: ${errorText(error)}`);
      events.saveSyncState(config.calendarId, userId, { last_error: errorText(error) });
    }
  };

  const run = (): Promise<void> => {
    if (!config.enabled) return Promise.resolve();
    if (!running) {
      running = runOnce().finally(() => {
        running = null;
      });
    }
    return running;
  };

  return {
    /** Starts the poll (first run after a short delay). No-op when the sync is not configured. */
    start(): void {
      if (!config.enabled || pollTimer) {
        if (!config.enabled) log(`[calendar-sync] выключена: ${config.reason ?? 'не настроена'}`);
        return;
      }
      firstTimer = setTimeout(() => void run(), FIRST_RUN_DELAY_MS);
      firstTimer.unref?.();
      pollTimer = setInterval(() => void run(), config.pollIntervalMs);
      pollTimer.unref?.();
    },

    stop(): void {
      for (const timer of [pollTimer, soonTimer, firstTimer]) if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      soonTimer = null;
      firstTimer = null;
    },

    /** A panel event changed: push within a few seconds instead of waiting for the poll. */
    requestSoon(): void {
      if (!config.enabled || !pollTimer) return;
      if (soonTimer) clearTimeout(soonTimer);
      soonTimer = setTimeout(() => {
        soonTimer = null;
        void run();
      }, PUSH_DEBOUNCE_MS);
      soonTimer.unref?.();
    },

    /** «Синхронизировать сейчас»: runs (or joins the running) sync and returns the fresh status. */
    async syncNow(): Promise<CalendarSyncStatus> {
      await run();
      return this.getStatus();
    },

    getStatus(): CalendarSyncStatus {
      const userId = dependencies.resolveUserId();
      const state = events.getSyncState(config.calendarId);
      const base: CalendarSyncStatus = {
        enabled: config.enabled,
        state: 'off',
        reason: config.reason,
        calendarId: config.enabled ? config.calendarId : null,
        calendarName: state?.calendar_name ?? calendarName,
        timeZone: config.timeZone,
        lastSuccessAt: state?.last_success_at ?? null,
        lastAttemptAt: state?.last_attempt_at ?? null,
        lastFullSyncAt: state?.last_full_sync_at ?? null,
        lastError: state?.last_error ?? null,
        pendingPush: userId === null ? 0 : events.countPendingGooglePush(userId) + events.countPendingOverridePush(userId),
        pendingDeletes: userId === null ? 0 : events.listGoogleDeletions(userId).length,
        importedCount: userId === null ? 0 : events.countImportedFromGoogle(userId),
        pollIntervalSec: Math.round(config.pollIntervalMs / 1000),
        pushTitlePrefix: config.pushTitlePrefix,
      };
      if (!config.enabled) return base;
      return { ...base, state: running ? 'syncing' : state?.last_error ? 'error' : 'idle' };
    },
  };
}

/**
 * Sync settings from the environment. The sync is off until both
 * `MIRAGE_GOOGLE_CREDENTIALS` (the service account key file) and
 * `MIRAGE_GOOGLE_CALENDAR_ID` are set — there are no defaults. The key file
 * path is checked, its contents are not read here. Exported for the calendar tests.
 */
export function readSyncConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (filePath: string) => boolean = existsSync,
): SyncConfig & { credentialsPath: string } {
  const credentialsPath = env.MIRAGE_GOOGLE_CREDENTIALS?.trim() ?? '';
  const calendarId = env.MIRAGE_GOOGLE_CALENDAR_ID?.trim() ?? '';
  const switchValue = (env.MIRAGE_GOOGLE_SYNC || '').trim().toLowerCase();
  const pollSec = Number(env.MIRAGE_GOOGLE_SYNC_INTERVAL_SEC);
  let reason: string | null = null;
  if (['0', 'off', 'false', 'no'].includes(switchValue)) reason = 'выключена настройкой MIRAGE_GOOGLE_SYNC';
  else if (env.NODE_ENV === 'test') reason = 'тестовый запуск';
  else if (!credentialsPath || !calendarId) reason = 'не настроена: задай MIRAGE_GOOGLE_CREDENTIALS и MIRAGE_GOOGLE_CALENDAR_ID';
  else if (!fileExists(credentialsPath)) reason = 'нет файла ключа сервисного аккаунта Google';
  return {
    enabled: reason === null,
    reason,
    calendarId,
    credentialsPath,
    timeZone: defaultCalendarTimeZone(),
    pollIntervalMs: Number.isFinite(pollSec) && pollSec >= 30 ? pollSec * 1000 : DEFAULT_POLL_INTERVAL_MS,
    pushTitlePrefix: env.MIRAGE_GOOGLE_PUSH_ONLY_PREFIX?.trim() || null,
  };
}

function resolveSyncUserId(): number | null {
  const configured = Number(process.env.MIRAGE_GOOGLE_USER_ID);
  if (Number.isInteger(configured) && configured > 0) return configured;
  const first = userDb.getFirstUser();
  return first ? Number(first.id) : null;
}

const syncConfig = readSyncConfig();

/** Used by the calendar module (routes, service, server start): the live Google Calendar sync. */
export const googleCalendarSync = createGoogleCalendarSync({
  config: syncConfig,
  client: createGoogleCalendarClient({ credentialsPath: syncConfig.credentialsPath, calendarId: syncConfig.calendarId }),
  events: calendarEventsDb,
  resolveUserId: resolveSyncUserId,
  now: () => Date.now(),
  log: (message) => console.log(message),
});
