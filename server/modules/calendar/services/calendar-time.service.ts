/**
 * Time-zone arithmetic and recurrence expansion for the calendar.
 *
 * The panel stores UTC instants, while "завтра в 11" and "каждый день в 9" are
 * wall-clock times of the user (the panel zone by default). Everything here
 * works through `Intl`, so any IANA zone with any DST rules is handled.
 */

import { getPanelTimeZone } from '@/shared/utils.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Zone used when the request names none: the panel zone (`MIRAGE_TIMEZONE`, else
 * the server's own). Used by `resolveTimeZone` here and by the Google sync config.
 */
export function defaultCalendarTimeZone(): string {
  return getPanelTimeZone();
}

/** Wall-clock parts of an instant in a zone. `weekday` is 0 = Monday … 6 = Sunday. */
export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Returns `candidate` when it is a zone `Intl` knows, otherwise the default zone. */
export function resolveTimeZone(candidate: unknown): string {
  if (typeof candidate === 'string' && candidate.trim()) {
    try {
      getFormatter(candidate.trim());
      return candidate.trim();
    } catch {
      // Unknown zone names fall through to the default.
    }
  }
  return defaultCalendarTimeZone();
}

export function toZonedParts(instantMs: number, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of getFormatter(timeZone).formatToParts(new Date(instantMs))) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** Minutes `timeZone` is ahead of UTC at `instantMs` (+300 for UTC+5 zones such as Asia/Yekaterinburg, +180/+120 for Helsinki in summer/winter). */
export function zoneOffsetMinutes(instantMs: number, timeZone: string): number {
  return Math.round(zoneOffsetMs(instantMs, timeZone) / MINUTE_MS);
}

function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = toZonedParts(instantMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUtc - Math.floor(instantMs / MINUTE_MS) * MINUTE_MS;
}

/**
 * The UTC instant of a wall-clock time in a zone. Day and month overflow is
 * normalised (`day: 32` is the 1st of the next month), so callers can add days
 * to `day` directly.
 */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const firstGuess = naive - zoneOffsetMs(naive, timeZone);
  const secondOffset = zoneOffsetMs(firstGuess, timeZone);
  return naive - secondOffset;
}

/** Calendar date `days` after the given one (wall-clock arithmetic, no zone involved). */
export function addLocalDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: (shifted.getUTCDay() + 6) % 7,
  };
}

function localDayNumber(date: { year: number; month: number; day: number }): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS);
}

// ----------------- Recurrence -----------------

/** Parsed RRULE subset the calendar supports. `byDay` uses 0 = Monday. */
export type RecurrenceRule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  byDay: number[];
  untilMs: number | null;
  count: number | null;
  /**
   * A date-only UNTIL (`UNTIL=20261103`) as a wall-clock day number: the series
   * ends on that day in the zone it is expanded in (RFC 5545 reads a DATE
   * UNTIL in local time). `untilMs` then holds its UTC end of day for callers
   * that need an instant. Absent for an UNTIL with a time.
   */
  untilDay?: number;
};

const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const MAX_EXPANSION_DAYS = 3700;

/**
 * Parses `FREQ=…;INTERVAL=…;BYDAY=…;UNTIL=…;COUNT=…` (an optional `RRULE:`
 * prefix is accepted). Returns null for anything outside the subset, so the
 * service can refuse it instead of storing a rule it cannot expand.
 */
export function parseRecurrenceRule(rule: string): RecurrenceRule | null {
  const body = rule.trim().replace(/^RRULE:/i, '');
  if (!body) {
    return null;
  }
  const fields = new Map<string, string>();
  for (const pair of body.split(';')) {
    const [key, value] = pair.split('=');
    if (!key || value === undefined || fields.has(key.toUpperCase())) {
      return null;
    }
    fields.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  }
  for (const key of fields.keys()) {
    if (!['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT'].includes(key)) {
      return null;
    }
  }

  const freq = fields.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') {
    return null;
  }
  const interval = fields.has('INTERVAL') ? Number(fields.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    return null;
  }
  const byDay: number[] = [];
  if (fields.has('BYDAY')) {
    for (const token of (fields.get('BYDAY') ?? '').split(',')) {
      const index = RRULE_DAYS.indexOf(token);
      if (index < 0) {
        return null;
      }
      byDay.push(index);
    }
  }
  let untilMs: number | null = null;
  let untilDay: number | undefined;
  if (fields.has('UNTIL')) {
    const raw = fields.get('UNTIL') ?? '';
    const compact = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(raw);
    if (compact && compact[4] === undefined) {
      untilDay = localDayNumber({ year: Number(compact[1]), month: Number(compact[2]), day: Number(compact[3]) });
    }
    untilMs = compact
      ? Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]),
        Number(compact[4] ?? 23), Number(compact[5] ?? 59), Number(compact[6] ?? 59))
      : Date.parse(raw);
    if (!Number.isFinite(untilMs)) {
      return null;
    }
  }
  let count: number | null = null;
  if (fields.has('COUNT')) {
    count = Number(fields.get('COUNT'));
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      return null;
    }
  }
  return { freq, interval, byDay: [...new Set(byDay)].sort(), untilMs, count, ...(untilDay !== undefined ? { untilDay } : {}) };
}

/**
 * Start instants of a recurring series inside `[fromMs, toMs)`.
 *
 * Occurrences keep the series' wall-clock time in `timeZone`, so "каждый день
 * в 9" stays at 9:00 across DST changes. `COUNT` is counted from the series
 * start. Expansion stops after ~10 years of days to bound the work.
 */
export function expandRecurrence(
  seriesStartMs: number,
  rule: RecurrenceRule,
  fromMs: number,
  toMs: number,
  timeZone: string,
): number[] {
  const start = toZonedParts(seriesStartMs, timeZone);
  const startDay = localDayNumber(start);
  const startWeek = Math.floor((startDay + 3) / 7); // Day 0 (1970-01-01) was a Thursday.
  const byDay = rule.freq === 'WEEKLY' && rule.byDay.length === 0 ? [start.weekday] : rule.byDay;
  const occurrences: number[] = [];
  let emitted = 0;

  for (let offset = 0; offset < MAX_EXPANSION_DAYS; offset += 1) {
    const date = addLocalDays(start, offset);
    const dayNumber = startDay + offset;
    let matches: boolean;
    if (rule.freq === 'DAILY') {
      matches = offset % rule.interval === 0 && (byDay.length === 0 || byDay.includes(date.weekday));
    } else if (rule.freq === 'WEEKLY') {
      const weekIndex = Math.floor((dayNumber + 3) / 7) - startWeek;
      matches = weekIndex % rule.interval === 0 && byDay.includes(date.weekday);
    } else {
      const months = (date.year - start.year) * 12 + (date.month - start.month);
      matches = date.day === start.day && months % rule.interval === 0;
    }
    if (!matches) {
      continue;
    }

    const instant = zonedTimeToUtc({ ...date, hour: start.hour, minute: start.minute }, timeZone);
    if (instant < seriesStartMs) {
      continue;
    }
    const pastUntil = rule.untilDay !== undefined
      ? dayNumber > rule.untilDay
      : rule.untilMs !== null && instant > rule.untilMs;
    if (instant >= toMs || pastUntil) {
      break;
    }
    emitted += 1;
    if (rule.count !== null && emitted > rule.count) {
      break;
    }
    if (instant >= fromMs) {
      occurrences.push(instant);
    }
  }
  return occurrences;
}
