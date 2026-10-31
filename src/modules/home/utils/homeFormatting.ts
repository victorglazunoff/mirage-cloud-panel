/**
 * Russian date/number wording for the home screen.
 * Pure functions only, so every phrase the screen shows is unit-tested.
 */

import { fromPanelWall, toPanelWall } from '@/modules/kabina';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAYS_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
const WEEKDAYS_LOWER_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WEEKDAYS_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];


/** Picks the Russian plural form: plural(2, ['агент', 'агента', 'агентов']) → 'агента'. */
export function plural(count: number, forms: [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

/** Two-digit counter for the summary board: 2 → '02'. */
export function padCount(count: number): string {
  return String(Math.max(0, count)).padStart(2, '0');
}

// Every function below takes real instants and shows them on the panel's wall clock (not the browser's).

export function formatClock(date: Date): string {
  const wall = toPanelWall(date);
  return `${String(wall.getHours()).padStart(2, '0')}:${String(wall.getMinutes()).padStart(2, '0')}`;
}

function sameWallDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Whether two instants fall on the same day of the panel's calendar. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return sameWallDay(toPanelWall(a), toPanelWall(b));
}

/** The instant of panel-zone midnight at the start of `date`'s day. */
export function startOfLocalDay(date: Date): Date {
  const wall = toPanelWall(date);
  return fromPanelWall(new Date(wall.getFullYear(), wall.getMonth(), wall.getDate()));
}

/** Wall date of the day before the wall date `wall`. */
function wallYesterday(wall: Date): Date {
  return new Date(wall.getFullYear(), wall.getMonth(), wall.getDate() - 1);
}

export function greetingFor(date: Date): string {
  const hour = toPanelWall(date).getHours();
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  if (hour >= 18 && hour < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}


/** 'ПН 26 ОКТЯБРЯ' for the phone summary eyebrow (DarkPhoneMain). */
export function formatShortLongDate(instant: Date): string {
  const date = toPanelWall(instant);
  return `${WEEKDAYS_SHORT[date.getDay()]} ${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()].toUpperCase()}`;
}

/** 'ПОНЕДЕЛЬНИК, 26 ОКТЯБРЯ' for the summary eyebrow. */
export function formatLongDate(instant: Date): string {
  const date = toPanelWall(instant);
  return `${WEEKDAYS_FULL[date.getDay()]}, ${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]}`.toUpperCase();
}


/** How long something has been going: 'сейчас', '12 мин', '1 ч 20 мин'. */
export function formatElapsed(sinceMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - sinceMs) / MINUTE_MS);
  if (minutes < 1) return 'сейчас';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
}

/**
 * Whom the greeting names: «Как тебя называть» from the settings (Аккаунт) first;
 * without it, the login only when it is a Russian name ("иван" → "Иван") —
 * a Latin handle such as "alicework" reads like a username, not a person.
 */
export function greetingName(settingsName: string | null | undefined, username: string | undefined): string | null {
  const chosen = settingsName?.trim();
  if (chosen) return chosen;
  const name = username?.trim();
  if (!name || !/^[А-Яа-яЁё-]{2,24}$/.test(name)) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * When the next event is, short enough for a board cell: 'в 15:00' today,
 * 'завтра 11:00', 'пт 11:00' within the week, '03.11 11:00' later (panel clock).
 */
export function formatEventWhen(at: Date, now: Date): string {
  const clock = formatClock(at);
  if (isSameLocalDay(at, now)) return `в ${clock}`;
  const days = Math.round((startOfLocalDay(at).getTime() - startOfLocalDay(now).getTime()) / 86_400_000);
  if (days === 1) return `завтра ${clock}`;
  const wall = toPanelWall(at);
  if (days > 1 && days < 7) return `${WEEKDAYS_LOWER_SHORT[wall.getDay()]} ${clock}`;
  return `${String(wall.getDate()).padStart(2, '0')}.${String(wall.getMonth() + 1).padStart(2, '0')} ${clock}`;
}

/** Time until something: 'через 28 мин', 'через 4 ч 48 мин', 'через 2 дня'. */
export function formatCountdown(targetMs: number, nowMs: number): string {
  const minutes = Math.ceil(Math.max(0, targetMs - nowMs) / MINUTE_MS);
  if (minutes < 1) return 'сейчас';
  if (minutes < 60) return `через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `через ${hours} ч ${rest} мин` : `через ${hours} ч`;
  }
  const days = Math.floor(hours / 24);
  return `через ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
}

/** When a project was last touched: '5 мин назад', 'сегодня 12:41', 'вчера 19:40', '24 окт'. */
export function formatLastActivity(iso: string | null, now: Date): string {
  if (!iso) return 'нет диалогов';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'нет диалогов';
  const diff = now.getTime() - date.getTime();
  if (diff >= 0 && diff < HOUR_MS) {
    const minutes = Math.floor(diff / MINUTE_MS);
    return minutes < 1 ? 'только что' : `${minutes} мин назад`;
  }
  const wall = toPanelWall(date);
  const wallNow = toPanelWall(now);
  if (sameWallDay(wall, wallNow)) return `сегодня ${formatClock(date)}`;
  if (sameWallDay(wall, wallYesterday(wallNow))) return `вчера ${formatClock(date)}`;
  const sameYear = wall.getFullYear() === wallNow.getFullYear();
  return `${wall.getDate()} ${MONTHS_SHORT[wall.getMonth()]}${sameYear ? '' : ` ${wall.getFullYear()}`}`;
}

/** Time column of the log: '13:58' today, 'вчера', '24.10' earlier. */
export function formatLogTime(iso: string | null, now: Date): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const wall = toPanelWall(date);
  const wallNow = toPanelWall(now);
  if (sameWallDay(wall, wallNow)) return formatClock(date);
  if (sameWallDay(wall, wallYesterday(wallNow))) return 'вчера';
  return `${String(wall.getDate()).padStart(2, '0')}.${String(wall.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Reset wording for a limit: within a day → 'сброс через 4 ч 48 мин',
 * later → 'сброс чт 5:00'.
 */
export function formatReset(iso: string | null, now: Date): string {
  if (!iso) return 'время сброса неизвестно';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'время сброса неизвестно';
  if (date.getTime() - now.getTime() < DAY_MS) {
    // Each number keeps its unit on a phone card: never «мин» alone on a line.
    return `сброс ${formatCountdown(date.getTime(), now.getTime()).replace(/(\d) /g, '$1\u00a0')}`;
  }
  const wall = toPanelWall(date);
  return `сброс ${WEEKDAYS_LOWER_SHORT[wall.getDay()]} ${wall.getHours()}:${String(wall.getMinutes()).padStart(2, '0')}`;
}

/** '5 ноя' — the day credits expire. */
export function formatShortDay(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const wall = toPanelWall(date);
  return `${wall.getDate()} ${MONTHS_SHORT[wall.getMonth()]}`;
}

/**
 * What is left of the credits, whole dollars: 'осталось $48 из $250'. The needle shows
 * the share spent, so the caption names the remainder outright instead of a bare '$48 из 250'.
 */
export function formatCredits(remaining: number, limit: number): string {
  return `осталось $${Math.floor(remaining)} из $${Math.round(limit)}`;
}

/** Percent label inside a gauge: 6 → '6%', 80.4 → '80%'. */
export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Share of the weekly window already behind us (0..1), derived from its reset
 * time — the window is seven days long and ends at `resetsAt`.
 */
export function weeklyElapsedShare(resetsAt: string | null, nowMs: number): number | null {
  if (!resetsAt) return null;
  const end = Date.parse(resetsAt);
  if (Number.isNaN(end)) return null;
  const start = end - 7 * DAY_MS;
  return Math.min(1, Math.max(0, (nowMs - start) / (7 * DAY_MS)));
}

type WeekDayCell = {
  key: string;
  date: Date;
  weekday: string;
  ariaWeekday: string;
  dayOfMonth: number;
  isToday: boolean;
  isWeekend: boolean;
  count: number;
};

/**
 * Wall dates (panel zone, local midnight) of the days an event touches: its
 * start day and, for an event running past midnight, every following day it
 * reaches. An end exactly at midnight does not reach the next day.
 */
function wallDaysOf(startIso: string, endIso: string | undefined): Date[] {
  const start = toPanelWall(new Date(startIso));
  if (Number.isNaN(start.getTime())) return [];
  const end = endIso ? toPanelWall(new Date(endIso)) : start;
  const days = [new Date(start.getFullYear(), start.getMonth(), start.getDate())];
  // Bounded: a runaway end date must not freeze the strip.
  for (let index = 1; index < 60; index += 1) {
    const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    if (Number.isNaN(end.getTime()) || end <= next) break;
    days.push(next);
  }
  return days;
}

/**
 * How an event sits on a panel day (`day` is that day's midnight instant):
 * `null` when it does not touch it, otherwise whether it began on an earlier
 * day and goes on after it. Used by the home calendar block, where an event
 * from Sunday 20:00 to Tuesday 10:00 is listed on Monday and Tuesday too.
 */
export function eventOnLocalDay(
  event: { scheduledFor: string; endsAt?: string },
  day: Date,
): { fromPrevDay: boolean; toNextDay: boolean } | null {
  const days = wallDaysOf(event.scheduledFor, event.endsAt);
  const target = toPanelWall(day);
  const index = days.findIndex((wall) => sameWallDay(wall, target));
  if (index === -1) return null;
  return { fromPrevDay: index > 0, toNextDay: index < days.length - 1 };
}

/**
 * Seven days starting today, each with how many scheduled items fall on it.
 * An item is a start instant or `{ startsAt, endsAt }`; the latter counts on
 * every day it runs over.
 */
export function buildWeek(now: Date, eventTimes: Array<string | { startsAt: string; endsAt?: string }>): WeekDayCell[] {
  const today = toPanelWall(now);
  const counts = new Map<string, number>();
  for (const entry of eventTimes) {
    const span = typeof entry === 'string' ? { startsAt: entry, endsAt: undefined } : entry;
    for (const wall of wallDaysOf(span.startsAt, span.endsAt)) {
      const key = wall.toDateString();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from({ length: 7 }, (_, index) => {
    // Calendar arithmetic, not +24h, so a DST switch cannot skip a day.
    const wallDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + index);
    const day = wallDay.getDay();
    return {
      key: wallDay.toDateString(),
      // The real instant of that day's panel midnight, like the other functions here take.
      date: fromPanelWall(wallDay),
      weekday: WEEKDAYS_SHORT[day],
      ariaWeekday: WEEKDAYS_FULL[day],
      dayOfMonth: wallDay.getDate(),
      isToday: index === 0,
      isWeekend: day === 0 || day === 6,
      count: counts.get(wallDay.toDateString()) ?? 0,
    };
  });
}
