import { calendarEventsDb, projectsDb, scheduledMessagesDb, sessionsDb } from '@/modules/database/index.js';
import type {
  CalendarEventRow,
  CalendarEventWritableFields,
  CalendarOccurrenceOverrideRow,
  ScheduledMessageRow,
} from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/index.js';
import type {
  CalendarEventInput,
  CalendarEventStatus,
  CalendarEventType,
  CalendarItem,
  CalendarParseResult,
  CalendarPrepareResult,
} from '@/shared/types.js';
import { AppError, getPanelTimeZone } from '@/shared/utils.js';

import { parseCalendarPhrase } from './calendar-phrase-parser.service.js';
import {
  addLocalDays,
  expandRecurrence,
  parseRecurrenceRule,
  resolveTimeZone,
  zoneOffsetMinutes,
  toZonedParts,
  zonedTimeToUtc,
} from './calendar-time.service.js';
import { GOOGLE_SYNCED_TYPES, googleCalendarSync } from './google-sync.service.js';
import { createSystemdTimersService } from './systemd-timers.service.js';
import type { ServerTimerOccurrence } from './systemd-timers.service.js';
import type { RecurrenceRule } from './calendar-time.service.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A calendar request covers at most about a quarter; months are the widest view. */
const MAX_RANGE_MS = 93 * DAY_MS;
/** Instants the calendar accepts: 1970 to the end of 9999 (anything else is a typo or garbage). */
const MIN_INSTANT_MS = 0;
const MAX_INSTANT_MS = Date.UTC(9999, 11, 31, 23, 59);
const EDITABLE_TYPES: ReadonlyArray<CalendarEventType> = ['call', 'message', 'meeting', 'agent_task'];
/** Every calendar type; used by the calendar routes to whitelist the `type` filter. */
export const CALENDAR_TYPES: ReadonlyArray<CalendarEventType> = [...EDITABLE_TYPES, 'server_schedule'];
const STATUSES: ReadonlyArray<CalendarEventStatus> = ['planned', 'done', 'cancelled', 'no_answer'];
const DEFAULT_DURATION_MIN: Record<CalendarEventType, number> = {
  call: 30, message: 15, meeting: 60, agent_task: 30, server_schedule: 15,
};
const TEXT_LIMITS = { title: 300, note: 10_000, contact: 200, location: 300 } as const;

type ProjectLookup = { projectId: string; projectPath: string; displayName: string };

type CalendarServiceDependencies = {
  now(): number;
  events: typeof calendarEventsDb;
  listScheduledMessages(userId: number, fromIso: string, toIso: string): ScheduledMessageRow[];
  describeSession(sessionId: string): { projectId: string | null; sessionTitle: string };
  getProject(projectId: string): ProjectLookup | null;
  listProjects(): ProjectLookup[];
  listServerTimers(input: { fromMs: number; toMs: number; nowMs: number; includePackaged: boolean }): Promise<ServerTimerOccurrence[]>;
  createSession(projectPath: string, initialMessage: string): { sessionId: string };
  sessionExists(sessionId: string): boolean;
  scheduleMessage(input: { userId: number; sessionId: string; content: string; scheduledFor: string }): { id: string; scheduledFor: string };
  /** Tells the Google sync that a panel event changed, so it pushes soon instead of on the next poll. */
  onGoogleChange?(): void;
  /** Last journal lines of a listed systemd timer's service; null when the timer is unknown. */
  readTimerJournal(unit: string, nowMs: number, timeZone: string): Promise<{ unit: string; service: string; lines: string[] } | null>;
};

function readOnlyImported(): AppError {
  return new AppError('Событие пришло из Google Календаря — измени или удали его там. Здесь можно отметить сделанным.', {
    code: 'CALENDAR_GOOGLE_READ_ONLY',
    statusCode: 409,
  });
}

/** Filters of `GET /api/calendar/events`, already parsed by the route. */
type CalendarListQuery = {
  userId: number;
  from: string | null;
  to: string | null;
  types: CalendarEventType[] | null;
  /** A project id, `'none'` for events without a project, or null for all. */
  project: string | null;
  includeCancelled: boolean;
  includePackagedTimers: boolean;
  timeZone: string | null;
};

function badRequest(message: string, code = 'CALENDAR_INVALID_INPUT', details?: unknown): AppError {
  return new AppError(message, { code, statusCode: 400, details });
}

function parseInstant(value: unknown, field: string): number {
  const instant = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(instant)) {
    throw badRequest(`${field}: нужна дата-время в формате ISO 8601.`);
  }
  // Years like +275760 parse, but the end time and toISOString() then throw (500).
  if (instant < MIN_INSTANT_MS || instant > MAX_INSTANT_MS) {
    throw badRequest(`${field}: дата вне 1970–9999 годов.`);
  }
  return instant;
}

function cleanText(value: unknown, field: string, limit: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw badRequest(`${field}: ожидается строка.`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw badRequest(`${field}: не длиннее ${limit} символов.`);
  return trimmed || null;
}

function defaultEndMs(row: Pick<CalendarEventRow, 'event_type' | 'starts_at' | 'ends_at'>, startMs: number): number {
  const storedStart = Date.parse(row.starts_at);
  const storedEnd = row.ends_at ? Date.parse(row.ends_at) : Number.NaN;
  const length = Number.isFinite(storedEnd) && storedEnd > storedStart
    ? storedEnd - storedStart
    : DEFAULT_DURATION_MIN[row.event_type] * MINUTE_MS;
  return startMs + length;
}

/** The prompt that asks Claude to prepare for an event (DarkCalendar «Поручить Claude подготовить»). */
function buildPreparePrompt(row: CalendarEventRow, whenText: string, extra: string | null): string {
  const who = [row.contact_name, row.contact_phone, row.contact_telegram].filter(Boolean).join(', ');
  const facts = [
    `Событие: «${row.title}», ${whenText}.`,
    who ? `Кто: ${who}.` : null,
    row.location ? `Где: ${row.location}.` : null,
    row.note ? `Заметка: ${row.note}` : null,
  ].filter(Boolean).join('\n');

  const asks: Record<CalendarEventType, string> = {
    call: 'Подготовь план звонка: цель, три главных вопроса, возможные возражения и что на них ответить. '
      + 'Если в проекте есть переписка или заметки об этом человеке — опирайся на них.',
    message: 'Подготовь черновик сообщения в тоне прошлой переписки с этим человеком. '
      + 'Я проверю и отправлю сам — ничего не отправляй.',
    meeting: 'Подготовь повестку и короткий бриф встречи: цель, что обсудить, что взять с собой, '
      + 'какие решения нужно получить.',
    agent_task: 'Выполни задачу из события.',
    server_schedule: 'Опиши, что делает это расписание.',
  };

  return [
    asks[row.event_type],
    facts,
    extra ? `Дополнительно: ${extra}` : null,
    'Ответь текстом в этом диалоге. Ничего не публикуй, не звони и не пиши людям от моего имени.',
  ].filter(Boolean).join('\n\n');
}

/** What an action on one occurrence of a series touches: «Только это» or «Вся серия». */
type OccurrenceScope = 'occurrence' | 'series';

/** True when the series generates an occurrence exactly at `instantMs` (in the panel zone unless given). */
function isOccurrenceOf(row: CalendarEventRow, rule: RecurrenceRule, instantMs: number, timeZone = resolveTimeZone(null)): boolean {
  return expandRecurrence(Date.parse(row.starts_at), rule, instantMs, instantMs + 1, timeZone).includes(instantMs);
}

/**
 * Creates the calendar service around explicit persistence, session and
 * systemd dependencies so tests can run it against a temporary database.
 */
export function createCalendarService(dependencies: CalendarServiceDependencies) {
  const projectCache = new Map<string, ProjectLookup | null>();
  const lookupProject = (projectId: string | null): ProjectLookup | null => {
    if (!projectId) return null;
    if (!projectCache.has(projectId)) projectCache.set(projectId, dependencies.getProject(projectId));
    return projectCache.get(projectId) ?? null;
  };

  const loadOwnEvent = (userId: number, id: string): CalendarEventRow => {
    // Edits and «prepare» on an occurrence (`<id>@<start>`) apply to its stored series.
    const eventId = id.split('@')[0];
    const row = dependencies.events.getById(userId, eventId);
    if (!row) {
      throw new AppError('Событие не найдено.', { code: 'CALENDAR_EVENT_NOT_FOUND', statusCode: 404 });
    }
    return row;
  };

  /**
   * The series row and, for an occurrence id (`<series>@<start>`), the start
   * the series gives that occurrence. A start the series never generates is a
   * 404, so a stale or forged id cannot plant an exception.
   */
  const loadOccurrence = (userId: number, id: string): { row: CalendarEventRow; originalMs: number | null } => {
    const row = loadOwnEvent(userId, id);
    const at = id.indexOf('@');
    const rule = row.recurrence ? parseRecurrenceRule(row.recurrence) : null;
    if (at < 0 || !rule) return { row, originalMs: null };
    const originalMs = Date.parse(id.slice(at + 1));
    if (!Number.isFinite(originalMs) || !isOccurrenceOf(row, rule, originalMs)) {
      throw new AppError('Такого повтора у серии нет — обнови календарь.', { code: 'CALENDAR_OCCURRENCE_NOT_FOUND', statusCode: 404 });
    }
    return { row, originalMs };
  };

  /**
   * One item of the calendar. For an occurrence, `occurrenceStartMs` is where
   * the series puts it (its id stays `<series>@<that start>` even when moved)
   * and `override` holds its own time and status.
   */
  const toItem = (
    row: CalendarEventRow,
    occurrenceStartMs: number,
    occurrenceOf: string | null,
    override: CalendarOccurrenceOverrideRow | null = null,
  ): CalendarItem => {
    const project = lookupProject(row.project_id);
    const hasContact = Boolean(row.contact_name || row.contact_phone || row.contact_telegram);
    const startMs = override?.starts_at ? Date.parse(override.starts_at) : occurrenceStartMs;
    const endMs = override?.starts_at && override.ends_at ? Date.parse(override.ends_at) : defaultEndMs(row, startMs);
    const googlePending = row.google_pending === 1 || override?.google_pending === 1;
    const googleError = override?.google_error ?? row.google_error;
    return {
      id: occurrenceOf ? `${row.id}@${new Date(occurrenceStartMs).toISOString()}` : row.id,
      source: row.origin === 'google' ? 'google' : 'panel',
      type: row.event_type,
      title: row.title,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
      projectId: row.project_id,
      projectName: project?.displayName ?? null,
      contact: hasContact ? { name: row.contact_name, phone: row.contact_phone, telegram: row.contact_telegram } : null,
      location: row.location,
      note: row.note,
      remindBeforeMin: row.remind_before_min,
      status: override ? override.status : row.status,
      sessionId: row.session_id,
      recurrence: row.recurrence,
      occurrenceOf,
      originalStartsAt: occurrenceOf ? new Date(occurrenceStartMs).toISOString() : null,
      readOnly: row.origin === 'google',
      preparedAt: row.prepared_at,
      allDay: row.all_day === 1,
      google: row.google_event_id || row.etag || googlePending || googleError
        ? {
          eventId: row.google_event_id,
          etag: row.etag,
          syncedAt: row.google_synced_at,
          pending: googlePending,
          error: googleError,
        }
        : null,
      agent: null,
      server: null,
    };
  };

  /**
   * Occurrences of a series overlapping `[fromMs, toMs)` with its exceptions
   * applied: a deleted day is skipped, a moved one shows at its new time (also
   * when only the new time is in the range), a done one carries its status.
   */
  const expandSeries = (
    row: CalendarEventRow,
    rule: RecurrenceRule,
    fromMs: number,
    toMs: number,
    timeZone: string,
    overrides: CalendarOccurrenceOverrideRow[],
  ): CalendarItem[] => {
    const seriesStartMs = Date.parse(row.starts_at);
    const lengthMs = defaultEndMs(row, seriesStartMs) - seriesStartMs;
    const overlaps = (startMs: number, endMs: number) => startMs < toMs && (startMs >= fromMs || endMs > fromMs);
    const byStart = new Map(overrides.map((override) => [override.original_start, override]));
    const items: CalendarItem[] = [];
    for (const occurrence of expandRecurrence(seriesStartMs, rule, fromMs - lengthMs, toMs, timeZone)) {
      const override = byStart.get(new Date(occurrence).toISOString()) ?? null;
      // Deleted on its own (EXDATE), or moved — a moved one is placed below by its new time.
      if (override && (override.status === 'cancelled' || override.starts_at)) continue;
      if (overlaps(occurrence, occurrence + lengthMs)) items.push(toItem(row, occurrence, row.id, override));
    }
    for (const override of overrides) {
      if (!override.starts_at || override.status === 'cancelled') continue;
      const startMs = Date.parse(override.starts_at);
      const endMs = override.ends_at ? Date.parse(override.ends_at) : startMs + lengthMs;
      if (!overlaps(startMs, endMs)) continue;
      const originalMs = Date.parse(override.original_start);
      // An exception left behind by an edit of the series (no longer one of its occurrences) is ignored.
      if (!isOccurrenceOf(row, rule, originalMs, timeZone)) continue;
      items.push(toItem(row, originalMs, row.id, override));
    }
    return items;
  };

  /** Exceptions of the recurring rows, by series id. */
  const overridesOf = (rows: CalendarEventRow[]): Map<string, CalendarOccurrenceOverrideRow[]> => {
    const bySeries = new Map<string, CalendarOccurrenceOverrideRow[]>();
    const byUser = new Map<number, string[]>();
    for (const row of rows) {
      if (!row.recurrence) continue;
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.id]);
    }
    for (const [userId, ids] of byUser) {
      for (const override of dependencies.events.listOccurrenceOverrides(userId, ids)) {
        bySeries.set(override.event_id, [...(bySeries.get(override.event_id) ?? []), override]);
      }
    }
    return bySeries;
  };

  /** The current state of one occurrence (its exception applied). */
  const occurrenceItem = (userId: number, row: CalendarEventRow, originalMs: number): CalendarItem => {
    const override = dependencies.events.getOccurrenceOverride(userId, row.id, new Date(originalMs).toISOString()) ?? null;
    return toItem(row, originalMs, row.id, override);
  };

  /** Panel calls, messages and meetings go to Google; their exceptions follow them there. */
  const goesToGoogle = (row: CalendarEventRow): boolean => row.origin === 'panel' && GOOGLE_SYNCED_TYPES.includes(row.event_type);

  /** Validates an API payload into table columns; `existing` is set for PATCH. */
  const toWritableFields = (input: CalendarEventInput, existing: CalendarEventRow | null): CalendarEventWritableFields => {
    const fields: CalendarEventWritableFields = {};

    if (input.type !== undefined || !existing) {
      if (!input.type || !EDITABLE_TYPES.includes(input.type)) {
        throw badRequest('type: одно из call, message, meeting, agent_task (расписания сервера только читаются).');
      }
      fields.event_type = input.type;
    }
    if (input.title !== undefined || !existing) {
      const title = cleanText(input.title, 'title', TEXT_LIMITS.title);
      if (!title) throw badRequest('title: заголовок обязателен.');
      fields.title = title;
    }

    let startMs = existing ? Date.parse(existing.starts_at) : Number.NaN;
    if (input.startsAt !== undefined || !existing) {
      startMs = parseInstant(input.startsAt, 'startsAt');
      fields.starts_at = new Date(startMs).toISOString();
    }
    if (input.durationMin !== undefined) {
      if (!Number.isInteger(input.durationMin) || input.durationMin < 1 || input.durationMin > 24 * 60) {
        throw badRequest('durationMin: от 1 до 1440 минут.');
      }
      fields.ends_at = new Date(startMs + input.durationMin * MINUTE_MS).toISOString();
    } else if (input.endsAt !== undefined) {
      if (input.endsAt === null) {
        fields.ends_at = null;
      } else {
        const endMs = parseInstant(input.endsAt, 'endsAt');
        if (endMs < startMs) throw badRequest('endsAt: конец раньше начала.');
        fields.ends_at = new Date(endMs).toISOString();
      }
    } else if (existing && fields.starts_at && existing.ends_at) {
      // Moving the start keeps the length.
      fields.ends_at = new Date(defaultEndMs(existing, startMs)).toISOString();
    }

    if (input.projectId !== undefined) {
      if (input.projectId !== null && (typeof input.projectId !== 'string' || !lookupProject(input.projectId))) {
        throw new AppError('Проект не найден.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
      }
      fields.project_id = input.projectId;
    }
    if (input.contact !== undefined) {
      fields.contact_name = cleanText(input.contact?.name, 'contact.name', TEXT_LIMITS.contact);
      fields.contact_phone = cleanText(input.contact?.phone, 'contact.phone', TEXT_LIMITS.contact);
      fields.contact_telegram = cleanText(input.contact?.telegram, 'contact.telegram', TEXT_LIMITS.contact);
    }
    if (input.location !== undefined) fields.location = cleanText(input.location, 'location', TEXT_LIMITS.location);
    if (input.note !== undefined) fields.note = cleanText(input.note, 'note', TEXT_LIMITS.note);
    if (input.remindBeforeMin !== undefined) {
      if (input.remindBeforeMin !== null
        && (!Number.isInteger(input.remindBeforeMin) || input.remindBeforeMin < 0 || input.remindBeforeMin > 7 * 24 * 60)) {
        throw badRequest('remindBeforeMin: от 0 до 10080 минут или null.');
      }
      fields.remind_before_min = input.remindBeforeMin;
    }
    if (input.status !== undefined) {
      if (!STATUSES.includes(input.status)) throw badRequest('status: planned, done, cancelled или no_answer.');
      fields.status = input.status;
      fields.completed_at = input.status === 'planned' ? null : new Date(dependencies.now()).toISOString();
    }
    if (input.sessionId !== undefined) {
      if (input.sessionId !== null && (typeof input.sessionId !== 'string' || !dependencies.sessionExists(input.sessionId))) {
        throw new AppError('Диалог не найден.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      }
      fields.session_id = input.sessionId;
    }
    if (input.recurrence !== undefined) {
      const rule = typeof input.recurrence === 'string' ? input.recurrence.trim() : null;
      if (rule && !parseRecurrenceRule(rule)) {
        throw badRequest('recurrence: поддерживается FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY, UNTIL, COUNT.');
      }
      fields.recurrence = rule || null;
    }
    if (input.google !== undefined) {
      fields.google_event_id = cleanText(input.google?.eventId, 'google.eventId', 1024);
      fields.etag = cleanText(input.google?.etag, 'google.etag', 1024);
    }
    return fields;
  };

  const resolveRange = (query: CalendarListQuery, timeZone: string): { fromMs: number; toMs: number } => {
    if (query.from || query.to) {
      const fromMs = query.from ? parseInstant(query.from, 'from') : Number.NaN;
      const toMs = query.to ? parseInstant(query.to, 'to') : fromMs + 7 * DAY_MS;
      const start = Number.isFinite(fromMs) ? fromMs : toMs - 7 * DAY_MS;
      if (toMs <= start) throw badRequest('to должно быть позже from.');
      if (toMs - start > MAX_RANGE_MS) throw badRequest('Диапазон не больше 93 дней.', 'CALENDAR_RANGE_TOO_WIDE');
      return { fromMs: start, toMs };
    }
    // Default: the current Monday-to-Monday week in the user's zone.
    const today = toZonedParts(dependencies.now(), timeZone);
    const monday = addLocalDays(today, -today.weekday);
    const fromMs = zonedTimeToUtc({ ...monday, hour: 0, minute: 0 }, timeZone);
    const nextMonday = addLocalDays(monday, 7);
    return { fromMs, toMs: zonedTimeToUtc({ ...nextMonday, hour: 0, minute: 0 }, timeZone) };
  };

  return {
    /**
     * Everything the calendar shows in a range: the user's events (recurring
     * ones expanded), scheduled panel messages as `agent_task` and systemd
     * timers as `server_schedule`, sorted by start.
     */
    async listEvents(query: CalendarListQuery): Promise<{ from: string; to: string; timeZone: string; items: CalendarItem[] }> {
      projectCache.clear();
      const timeZone = resolveTimeZone(query.timeZone);
      const { fromMs, toMs } = resolveRange(query, timeZone);
      const fromIso = new Date(fromMs).toISOString();
      const toIso = new Date(toMs).toISOString();
      const wants = (type: CalendarEventType) => !query.types || query.types.includes(type);
      const projectMatches = (projectId: string | null) =>
        !query.project || (query.project === 'none' ? projectId === null : projectId === query.project);

      const items: CalendarItem[] = [];
      // Events overlapping the range are listed, not only those starting in it: a trip from
      // Sunday 20:00 to Tuesday 10:00 belongs to Monday's week too. A day of lookback also
      // catches events without a stored end, whose default length is under an hour.
      const candidatesFromIso = new Date(fromMs - DAY_MS).toISOString();
      const candidates = dependencies.events.listCandidatesInRange(query.userId, candidatesFromIso, toIso)
        .filter((row) => wants(row.event_type) && projectMatches(row.project_id))
        .filter((row) => row.status !== 'cancelled' || query.includeCancelled);
      const overrides = overridesOf(candidates);
      for (const row of candidates) {
        const startMs = Date.parse(row.starts_at);
        const lengthMs = defaultEndMs(row, startMs) - startMs;
        const rule = row.recurrence ? parseRecurrenceRule(row.recurrence) : null;
        if (rule) {
          items.push(...expandSeries(row, rule, fromMs, toMs, timeZone, overrides.get(row.id) ?? []));
        } else if (startMs < toMs && (startMs >= fromMs || startMs + lengthMs > fromMs)) {
          items.push(toItem(row, startMs, null));
        }
      }

      if (wants('agent_task')) {
        for (const message of dependencies.listScheduledMessages(query.userId, fromIso, toIso)) {
          const session = dependencies.describeSession(message.session_id);
          if (!projectMatches(session.projectId)) continue;
          const startMs = Date.parse(message.scheduled_for);
          const preview = message.content.replace(/\s+/g, ' ').trim();
          items.push({
            id: `scheduled:${message.id}`,
            source: 'scheduled_message',
            type: 'agent_task',
            title: preview.length > 80 ? `${preview.slice(0, 79)}…` : preview,
            startsAt: new Date(startMs).toISOString(),
            endsAt: new Date(startMs + DEFAULT_DURATION_MIN.agent_task * MINUTE_MS).toISOString(),
            projectId: session.projectId,
            projectName: lookupProject(session.projectId)?.displayName ?? null,
            contact: null,
            location: null,
            note: null,
            remindBeforeMin: null,
            status: message.status === 'sent' ? 'done' : 'planned',
            sessionId: message.session_id,
            recurrence: null,
            occurrenceOf: null,
            readOnly: true,
            preparedAt: null,
            allDay: false,
            google: null,
            agent: {
              scheduledMessageId: message.id,
              sessionTitle: session.sessionTitle,
              content: message.content,
              deliveryStatus: message.status,
              failureReason: message.failure_reason,
            },
            server: null,
          });
        }
      }

      if (wants('server_schedule') && !query.project) {
        const occurrences = await dependencies.listServerTimers({
          fromMs, toMs, nowMs: dependencies.now(), includePackaged: query.includePackagedTimers,
        });
        for (const { timer, startsAtMs } of occurrences) {
          items.push({
            id: `systemd:${timer.unit}@${new Date(startsAtMs).toISOString()}`,
            source: 'systemd',
            type: 'server_schedule',
            title: timer.description || timer.unit,
            startsAt: new Date(startsAtMs).toISOString(),
            endsAt: new Date(startsAtMs + DEFAULT_DURATION_MIN.server_schedule * MINUTE_MS).toISOString(),
            projectId: null,
            projectName: null,
            contact: null,
            location: null,
            note: null,
            remindBeforeMin: null,
            status: startsAtMs <= dependencies.now() ? 'done' : 'planned',
            sessionId: null,
            recurrence: null,
            occurrenceOf: null,
            readOnly: true,
            preparedAt: null,
            allDay: false,
            google: null,
            agent: null,
            server: {
              unit: timer.unit,
              activates: timer.activates,
              description: timer.description,
              calendarSpec: timer.calendarSpecs.join('; ') || null,
              lastTriggerAt: timer.lastTriggerMs ? new Date(timer.lastTriggerMs).toISOString() : null,
              lastResult: timer.lastResult,
              timeZone: timer.timeZone,
              // The spec zone's offset at this firing vs now: summer time moves a firing by an hour.
              utcOffsetMin: timer.timeZone ? zoneOffsetMinutes(startsAtMs, timer.timeZone) : null,
              currentUtcOffsetMin: timer.timeZone ? zoneOffsetMinutes(dependencies.now(), timer.timeZone) : null,
            },
          });
        }
      }

      items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.title.localeCompare(b.title));
      return { from: fromIso, to: toIso, timeZone, items };
    },

    /**
     * Occurrences in `[fromMs, toMs)` of planned events (any user) that carry
     * a reminder — the Telegram bot sends «через N мин» for them. Recurring
     * events are expanded in the panel zone like the calendar grid.
     */
    listReminders(fromMs: number, toMs: number, timeZone: string): CalendarItem[] {
      projectCache.clear();
      const items: CalendarItem[] = [];
      const fromIso = new Date(fromMs).toISOString();
      const toIso = new Date(toMs).toISOString();
      const candidates = dependencies.events.listReminderCandidates(fromIso, toIso);
      const overrides = overridesOf(candidates);
      for (const row of candidates) {
        const startMs = Date.parse(row.starts_at);
        const rule = row.recurrence ? parseRecurrenceRule(row.recurrence) : null;
        if (rule) {
          // A moved occurrence reminds at its new time, a done or deleted one not at all (the bot sends planned only).
          items.push(...expandSeries(row, rule, fromMs, toMs, resolveTimeZone(timeZone), overrides.get(row.id) ?? [])
            .filter((item) => Date.parse(item.startsAt) >= fromMs));
        } else if (startMs >= fromMs && startMs < toMs) {
          items.push(toItem(row, startMs, null));
        }
      }
      return items;
    },

    getEvent(userId: number, id: string): CalendarItem {
      projectCache.clear();
      const { row, originalMs } = loadOccurrence(userId, id);
      return originalMs === null ? toItem(row, Date.parse(row.starts_at), null) : occurrenceItem(userId, row, originalMs);
    },

    createEvent(userId: number, input: CalendarEventInput): CalendarItem {
      projectCache.clear();
      const fields = toWritableFields(input, null);
      const goesToGoogle = GOOGLE_SYNCED_TYPES.includes(fields.event_type as CalendarEventType);
      const row = dependencies.events.create(userId, {
        ...fields,
        event_type: fields.event_type as CalendarEventType,
        title: fields.title as string,
        starts_at: fields.starts_at as string,
        origin: 'panel',
        google_pending: goesToGoogle ? 1 : 0,
      });
      if (goesToGoogle) dependencies.onGoogleChange?.();
      return toItem(row, Date.parse(row.starts_at), null);
    },

    /**
     * Edits a panel event and queues it for Google when it is (or was) a
     * synced type. Events imported from Google are read-only here; only their
     * local status may change (see `setStatus`).
     */
    updateEvent(userId: number, id: string, input: CalendarEventInput): CalendarItem {
      projectCache.clear();
      const existing = loadOwnEvent(userId, id);
      const onlyStatus = Object.keys(input).every((key) => key === 'status');
      if (existing.origin === 'google' && !onlyStatus) throw readOnlyImported();
      if (existing.origin === 'google' && input.status === 'cancelled') throw readOnlyImported();
      const fields = toWritableFields(input, existing);
      // The Google link is owned by the sync; a client cannot point an event at another Google event.
      delete fields.google_event_id;
      delete fields.etag;
      const nextType = fields.event_type ?? existing.event_type;
      const touchesGoogle = existing.origin === 'panel'
        && (GOOGLE_SYNCED_TYPES.includes(nextType) || Boolean(existing.google_event_id));
      if (touchesGoogle) fields.google_pending = 1;
      const row = dependencies.events.update(userId, existing.id, fields) as CalendarEventRow;
      if (touchesGoogle) dependencies.onGoogleChange?.();
      return toItem(row, Date.parse(row.starts_at), null);
    },

    /**
     * Deletes a panel event; its Google copy (if any) is queued for removal by
     * the sync. For an occurrence id, `scope: 'occurrence'` (the default)
     * deletes only that day — an EXDATE of the series — and `'series'` the
     * whole series.
     */
    deleteEvent(userId: number, id: string, scope: OccurrenceScope = 'occurrence'): void {
      const { row: existing, originalMs } = loadOccurrence(userId, id);
      if (existing.origin === 'google') throw readOnlyImported();
      if (originalMs !== null && scope === 'occurrence') {
        dependencies.events.upsertOccurrenceOverride(userId, existing.id, new Date(originalMs).toISOString(), {
          status: 'cancelled', completed_at: new Date(dependencies.now()).toISOString(), google_pending: 0, google_error: null,
        });
        // The EXDATE rides on the series' Google event.
        if (goesToGoogle(existing)) {
          dependencies.events.update(userId, existing.id, { google_pending: 1 });
          dependencies.onGoogleChange?.();
        }
        return;
      }
      if (existing.google_event_id) {
        dependencies.events.queueGoogleDeletion(userId, existing.google_event_id, existing.id);
      }
      dependencies.events.remove(userId, existing.id);
      if (existing.google_event_id) dependencies.onGoogleChange?.();
    },

    /**
     * «Отметить сделанным» / «Вернуть в план» and the other statuses. On an
     * occurrence id only that occurrence changes (an exception of the series);
     * `cancelled` there deletes just that day.
     */
    setStatus(userId: number, id: string, status: CalendarEventStatus): CalendarItem {
      const { row: existing, originalMs } = loadOccurrence(userId, id);
      if (originalMs === null) return this.updateEvent(userId, existing.id, { status });
      if (!STATUSES.includes(status)) throw badRequest('status: planned, done, cancelled или no_answer.');
      if (status === 'cancelled') {
        this.deleteEvent(userId, id, 'occurrence');
        return occurrenceItem(userId, existing, originalMs);
      }
      projectCache.clear();
      const key = new Date(originalMs).toISOString();
      const current = dependencies.events.getOccurrenceOverride(userId, existing.id, key);
      const google = goesToGoogle(existing);
      if (status === 'planned' && !current?.starts_at && !(google && current)) {
        // Back to plan and nothing else changed: the exception is gone.
        dependencies.events.removeOccurrenceOverride(userId, existing.id, key);
      } else {
        dependencies.events.upsertOccurrenceOverride(userId, existing.id, key, {
          status,
          completed_at: status === 'planned' ? null : new Date(dependencies.now()).toISOString(),
          ...(google ? { google_pending: 1 } : {}),
        });
        if (google) dependencies.onGoogleChange?.();
      }
      return occurrenceItem(userId, existing, originalMs);
    },

    /**
     * «Перенести»: an exact new start, a shift in minutes, or a preset
     * (`plus30m`, `plus1h`, `tomorrow`). The length is kept and the event goes
     * back to `planned`.
     */
    reschedule(
      userId: number,
      id: string,
      input: { startsAt?: string; shiftMinutes?: number; preset?: string },
      scope: OccurrenceScope = 'occurrence',
    ): CalendarItem {
      const { row: existing, originalMs } = loadOccurrence(userId, id);
      if (existing.origin === 'google') throw readOnlyImported();
      const seriesStart = Date.parse(existing.starts_at);
      const override = originalMs === null
        ? undefined
        : dependencies.events.getOccurrenceOverride(userId, existing.id, new Date(originalMs).toISOString());
      // Presets count from where the event (or this occurrence) is now.
      const currentStart = override?.starts_at ? Date.parse(override.starts_at) : originalMs ?? seriesStart;
      let nextStart: number;
      if (input.startsAt !== undefined) {
        nextStart = parseInstant(input.startsAt, 'startsAt');
      } else if (input.shiftMinutes !== undefined) {
        if (!Number.isInteger(input.shiftMinutes) || Math.abs(input.shiftMinutes) > 366 * 24 * 60) {
          throw badRequest('shiftMinutes: целое число минут, не больше года.');
        }
        nextStart = currentStart + input.shiftMinutes * MINUTE_MS;
      } else if (input.preset === 'plus30m' || input.preset === 'plus1h' || input.preset === 'tomorrow') {
        nextStart = currentStart + { plus30m: 30 * MINUTE_MS, plus1h: 60 * MINUTE_MS, tomorrow: DAY_MS }[input.preset];
      } else {
        throw badRequest('Укажи startsAt, shiftMinutes или preset (plus30m, plus1h, tomorrow).');
      }
      if (originalMs === null) {
        return this.updateEvent(userId, existing.id, {
          startsAt: new Date(nextStart).toISOString(),
          status: 'planned',
        });
      }

      if (scope === 'series') {
        // «Вся серия»: the series moves by the same step; its exceptions follow their occurrences.
        const shiftMs = nextStart - currentStart;
        this.updateEvent(userId, existing.id, { startsAt: new Date(seriesStart + shiftMs).toISOString() });
        dependencies.events.shiftOccurrenceOverrides(userId, existing.id, shiftMs, goesToGoogle(existing));
        projectCache.clear();
        return occurrenceItem(userId, loadOwnEvent(userId, existing.id), originalMs + shiftMs);
      }

      // «Только это»: the occurrence keeps its length and goes back to plan.
      const lengthMs = override?.starts_at && override.ends_at
        ? Date.parse(override.ends_at) - Date.parse(override.starts_at)
        : defaultEndMs(existing, seriesStart) - seriesStart;
      const google = goesToGoogle(existing);
      projectCache.clear();
      dependencies.events.upsertOccurrenceOverride(userId, existing.id, new Date(originalMs).toISOString(), {
        starts_at: new Date(nextStart).toISOString(),
        ends_at: new Date(nextStart + lengthMs).toISOString(),
        status: 'planned',
        completed_at: null,
        ...(google ? { google_pending: 1 } : {}),
      });
      if (google) dependencies.onGoogleChange?.();
      return occurrenceItem(userId, existing, originalMs);
    },

    /** «Открыть журнал» of a server timer; 404 for a unit the server does not list. */
    async readTimerJournal(unit: string): Promise<{ unit: string; service: string; lines: string[] }> {
      if (!/^[\w@.:-]+\.timer$/.test(unit)) throw badRequest('unit: имя таймера systemd (*.timer).');
      let journal: Awaited<ReturnType<CalendarServiceDependencies['readTimerJournal']>>;
      try {
        journal = await dependencies.readTimerJournal(unit, dependencies.now(), getPanelTimeZone());
      } catch {
        throw new AppError('Журнал недоступен: нет systemd или прав на journalctl.', { code: 'CALENDAR_JOURNAL_UNAVAILABLE', statusCode: 503 });
      }
      if (!journal) throw new AppError('Таймер не найден.', { code: 'CALENDAR_TIMER_NOT_FOUND', statusCode: 404 });
      return journal;
    },

    /** Reads a quick-add phrase into a draft event (nothing is saved). */
    parsePhrase(input: { text: string; timeZone: string | null; now: string | null }): CalendarParseResult {
      const text = input.text.trim();
      if (!text) throw badRequest('text: фраза пустая.');
      if (text.length > 500) throw badRequest('text: не длиннее 500 символов.');
      const nowMs = input.now ? parseInstant(input.now, 'now') : dependencies.now();
      return parseCalendarPhrase({
        text,
        nowMs,
        timeZone: resolveTimeZone(input.timeZone),
        projects: dependencies.listProjects().map((project) => ({
          projectId: project.projectId,
          displayName: project.displayName,
          names: [project.displayName, project.projectPath.split(/[\\/]/).pop() ?? ''],
        })),
      });
    },

    /**
     * «Поручить Claude подготовить»: puts a preparation task for the event
     * into a project session through the scheduled-messages queue — at `at`,
     * or right away (the dispatcher picks it up within 30 seconds). A new
     * session is opened in the project unless `sessionId` names one.
     */
    prepare(
      userId: number,
      id: string,
      input: { projectId: string | null; sessionId: string | null; at: string | null; instructions: string | null; timeZone: string | null },
    ): CalendarPrepareResult {
      projectCache.clear();
      const row = loadOwnEvent(userId, id);
      const timeZone = resolveTimeZone(input.timeZone);

      let sessionId = input.sessionId;
      let projectId = input.projectId ?? row.project_id;
      if (sessionId) {
        if (!dependencies.sessionExists(sessionId)) {
          throw new AppError('Диалог не найден.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        }
        projectId = dependencies.describeSession(sessionId).projectId ?? projectId;
      }
      const project = lookupProject(projectId);
      if (!project) {
        throw new AppError('Выбери проект, в котором Claude будет готовить.', {
          code: 'CALENDAR_PROJECT_REQUIRED',
          statusCode: 400,
        });
      }

      const startParts = toZonedParts(Date.parse(row.starts_at), timeZone);
      const pad = (value: number) => String(value).padStart(2, '0');
      const whenText = `${pad(startParts.day)}.${pad(startParts.month)}.${startParts.year} в ${pad(startParts.hour)}:${pad(startParts.minute)}`;
      const instructions = cleanText(input.instructions, 'instructions', 2_000);
      const content = buildPreparePrompt(row, whenText, instructions);

      if (!sessionId) {
        sessionId = dependencies.createSession(project.projectPath, `Подготовка: ${row.title}`).sessionId;
      }
      const scheduledFor = input.at
        ? new Date(parseInstant(input.at, 'at')).toISOString()
        : new Date(dependencies.now()).toISOString();
      const scheduled = dependencies.scheduleMessage({ userId, sessionId, content, scheduledFor });

      const updated = dependencies.events.update(userId, row.id, {
        session_id: sessionId,
        prepared_at: new Date(dependencies.now()).toISOString(),
        prepare_message_id: scheduled.id,
      }) as CalendarEventRow;

      return {
        event: toItem(updated, Date.parse(updated.starts_at), null),
        projectId: project.projectId,
        sessionId,
        scheduledMessageId: scheduled.id,
        scheduledFor: scheduled.scheduledFor,
        sessionUrl: `/p/${encodeURIComponent(project.projectId)}/s/${encodeURIComponent(sessionId)}`,
      };
    },
  };
}

function describeProjectRow(row: { project_id: string; project_path: string; custom_project_name: string | null }): ProjectLookup {
  return {
    projectId: row.project_id,
    projectPath: row.project_path,
    displayName: row.custom_project_name?.trim() || row.project_path.split(/[\\/]/).filter(Boolean).pop() || row.project_path,
  };
}

const systemdTimers = createSystemdTimersService();

/** Used by the calendar routes; wired to the real database, sessions and systemd. */
export const calendarService = createCalendarService({
  now: () => Date.now(),
  events: calendarEventsDb,
  listScheduledMessages: (userId, fromIso, toIso) => scheduledMessagesDb.listForUserBetween(userId, fromIso, toIso),
  describeSession: (sessionId) => {
    const session = sessionsDb.getSessionById(sessionId);
    const project = session?.project_path ? projectsDb.getProjectPath(session.project_path) : null;
    return {
      projectId: project?.project_id ?? null,
      sessionTitle: session?.custom_name?.trim() || 'Без названия',
    };
  },
  getProject: (projectId) => {
    const row = projectsDb.getProjectById(projectId);
    return row ? describeProjectRow(row) : null;
  },
  listProjects: () => projectsDb.getProjectPaths().map(describeProjectRow),
  listServerTimers: (input) => systemdTimers.listOccurrences(input),
  createSession: (projectPath, initialMessage) => sessionsService.createAppSession('claude', projectPath, initialMessage),
  sessionExists: (sessionId) => Boolean(sessionsDb.getSessionById(sessionId)),
  scheduleMessage: (input) => {
    const scheduled = scheduledMessagesService.schedule(input);
    return { id: scheduled.id, scheduledFor: scheduled.scheduledFor };
  },
  onGoogleChange: () => googleCalendarSync.requestSoon(),
  readTimerJournal: (unit, nowMs, timeZone) => systemdTimers.readJournal(unit, nowMs, timeZone),
});
