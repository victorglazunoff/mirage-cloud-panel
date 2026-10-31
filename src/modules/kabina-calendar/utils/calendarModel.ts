import { fromPanelWall, getPanelTimeZone, toPanelWall } from '@/modules/kabina';
import type { CalendarEventType, CalendarItem } from '@/shared/types';

/**
 * The calendar lives in the panel zone (server `MIRAGE_TIMEZONE`, else the
 * server zone; shared with the header clock), whatever zone the browser is in:
 * the grid, the phrase parser and Google all use it.
 */
export function calendarZone(): string {
  return getPanelTimeZone();
}

/**
 * A Date whose local fields (getHours, getDate…) show the wall clock of an
 * instant in the panel zone. All grid math runs on such "wall" dates;
 * `fromWall` turns one back into the real instant for the API.
 */
export function toWall(instant: string | number | Date): Date {
  return toPanelWall(instant);
}

/** The real instant of a wall date (inverse of `toWall`). */
export function fromWall(wall: Date): Date {
  return fromPanelWall(wall);
}

/** Calendar views of DarkCalendar's «День / Неделя / Месяц» switch. */
export type CalendarView = 'day' | 'week' | 'month';

/** Pixel height of one hour in the grid (DarkCalendar `H`). */
export const HOUR_PX = 44;
/** The grid shows 08:00–21:00; earlier and later events sit in the «до 08» / «после 21» strips. */
export const GRID_START_MIN = 8 * 60;
export const GRID_END_MIN = 21 * 60;
export const GRID_HEIGHT_PX = ((GRID_END_MIN - GRID_START_MIN) / 60) * HOUR_PX;
/** «через N мин» is shown only for what is close enough to plan around. */
const COUNTDOWN_WINDOW_MS = 3 * 60 * 60 * 1000;

const WEEKDAYS_SHORT = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];
const WEEKDAYS_LOWER = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
/** «во вторник», «в среду» — where the draft sits in the grid. */
const WEEKDAYS_IN = ['в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** One-item and filter labels per type (DarkCalendar `T`). */
export const TYPE_LABELS: Record<CalendarEventType, { one: string; many: string }> = {
  call: { one: 'Звонок', many: 'Звонки' },
  message: { one: 'Написать сообщение', many: 'Сообщения' },
  meeting: { one: 'Встреча', many: 'Встречи' },
  agent_task: { one: 'Задача агента · отложенное сообщение Claude', many: 'Задачи агента' },
  server_schedule: { one: 'Расписание сервера · повторяется', many: 'Сервер' },
};

export const TYPE_ORDER: CalendarEventType[] = ['call', 'message', 'meeting', 'agent_task', 'server_schedule'];

/** Calls, messages and meetings — the «с людьми» kinds that Claude can prepare for and Google receives. */
export function isPersonType(type: CalendarEventType): boolean {
  return type === 'call' || type === 'message' || type === 'meeting';
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Local midnight of the date. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
}

/** 0 = Monday … 6 = Sunday. */
export function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function startOfWeek(date: Date): Date {
  return addDays(startOfDay(date), -mondayIndex(date));
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** ISO-8601 week number («НЕДЕЛЯ 44»). */
export function isoWeek(date: Date): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** «26.10» */
export function formatDayMonth(date: Date): string {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}`;
}

/** «пн 26.10» */
export function formatDayFull(date: Date): string {
  return `${WEEKDAYS_LOWER[mondayIndex(date)]} ${formatDayMonth(date)}`;
}

export function weekdayShort(date: Date): string {
  return WEEKDAYS_SHORT[mondayIndex(date)];
}

export function weekdayIn(date: Date): string {
  return WEEKDAYS_IN[mondayIndex(date)];
}

export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Days shown and the request range of a view around `anchor`. */
export function viewRange(view: CalendarView, anchor: Date): { days: Date[]; from: Date; to: Date } {
  if (view === 'day') {
    const day = startOfDay(anchor);
    return { days: [day], from: day, to: addDays(day, 1) };
  }
  if (view === 'week') {
    const monday = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index));
    return { days, from: monday, to: addDays(monday, 7) };
  }
  // Month: whole weeks from the Monday on or before the 1st to the Sunday on or after the last day.
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const from = startOfWeek(first);
  const to = addDays(startOfWeek(last), 7);
  const days: Date[] = [];
  for (let day = from; day < to; day = addDays(day, 1)) days.push(day);
  return { days, from, to };
}

/** The anchor one step back or forward in the view. */
export function shiftAnchor(view: CalendarView, anchor: Date, step: -1 | 1): Date {
  if (view === 'day') return addDays(anchor, step);
  if (view === 'week') return addDays(anchor, 7 * step);
  return new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
}

/** Eyebrow and big title of the toolbar («КАЛЕНДАРЬ · 2026 · НЕДЕЛЯ 44», «26.10 — 01.11»). */
export function viewHeading(view: CalendarView, anchor: Date): { eyebrow: string; title: string; prevLabel: string; nextLabel: string } {
  if (view === 'day') {
    return {
      // Same width as the week's line, so «Сегодня» stays put when the view changes.
      eyebrow: `КАЛЕНДАРЬ · ${anchor.getFullYear()} · НЕДЕЛЯ ${isoWeek(anchor)}`,
      title: `${weekdayShort(anchor)} ${formatDayMonth(anchor)}`,
      prevLabel: 'Предыдущий день',
      nextLabel: 'Следующий день',
    };
  }
  if (view === 'week') {
    const monday = startOfWeek(anchor);
    return {
      eyebrow: `КАЛЕНДАРЬ · ${monday.getFullYear()} · НЕДЕЛЯ ${isoWeek(monday)}`,
      title: `${formatDayMonth(monday)} — ${formatDayMonth(addDays(monday, 6))}`,
      prevLabel: 'Предыдущая неделя',
      nextLabel: 'Следующая неделя',
    };
  }
  return {
    eyebrow: `КАЛЕНДАРЬ · ${anchor.getFullYear()} · МЕСЯЦ`,
    title: MONTHS[anchor.getMonth()],
    prevLabel: 'Предыдущий месяц',
    nextLabel: 'Следующий месяц',
  };
}

const DAY_MIN = 24 * 60;

/**
 * The part of an event that falls on one day of the grid. An event from
 * Sunday 20:00 to Tuesday 10:00 gives three pieces: 20:00–24:00 on Sunday
 * (`toNextDay`), the whole Monday (both flags) and 00:00–10:00 on Tuesday
 * (`fromPrevDay`). Minutes are wall-clock minutes of that day in the panel zone.
 */
export type DayPiece = { item: CalendarItem; startMin: number; endMin: number; fromPrevDay: boolean; toNextDay: boolean };

/** True when the piece is a part of an event longer than its day (drawn as a continuing bar). */
export function isContinued(piece: Pick<DayPiece, 'fromPrevDay' | 'toNextDay'>): boolean {
  return piece.fromPrevDay || piece.toNextDay;
}

/**
 * Pieces of the events that touch `day` (a wall date), in their order. An
 * event ending exactly at midnight does not reach the next day; a zero-length
 * one belongs to the day it starts on.
 */
export function dayPieces(items: CalendarItem[], day: Date): DayPiece[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const pieces: DayPiece[] = [];
  for (const item of items) {
    const start = toWall(item.startsAt);
    const end = toWall(item.endsAt);
    if (start >= dayEnd) continue;
    const startsToday = start >= dayStart;
    if (!startsToday && end <= dayStart) continue;
    pieces.push({
      item,
      startMin: startsToday ? minutesOfDay(start) : 0,
      endMin: end >= dayEnd ? DAY_MIN : minutesOfDay(end),
      fromPrevDay: !startsToday,
      toNextDay: end > dayEnd,
    });
  }
  return pieces;
}

/** The piece of an event on its own start day (single-day events are one such piece). */
function startPiece(item: CalendarItem): DayPiece {
  return dayPieces([item], toWall(item.startsAt))[0] ?? { item, startMin: 0, endMin: 0, fromPrevDay: false, toNextDay: false };
}

/**
 * Where a piece sits in its day: the 08–21 grid, or the strips above and
 * below it. One-day events go by their start (as in DarkCalendar); a piece of
 * a longer event goes to the grid whenever it covers part of 08–21, so the
 * bar of a trip runs through the grid instead of hiding in «до 08».
 */
export function pieceBand(piece: DayPiece): 'early' | 'grid' | 'late' {
  if (piece.item.allDay) return 'early';
  if (isContinued(piece)) {
    if (piece.endMin <= GRID_START_MIN) return 'early';
    if (piece.startMin >= GRID_END_MIN) return 'late';
    return 'grid';
  }
  if (piece.startMin < GRID_START_MIN) return 'early';
  if (piece.startMin >= GRID_END_MIN) return 'late';
  return 'grid';
}

/** Where an event sits on its start day (see `pieceBand`). */
export function bandOf(item: CalendarItem): 'early' | 'grid' | 'late' {
  return pieceBand(startPiece(item));
}

/** Width of the rail a piece of a multi-day event takes at the left of a day column, px. */
export const RAIL_PX = 22;

/** One event (or one day's piece of it) placed in a day column of the grid. */
export type GridPlacement = {
  item: CalendarItem;
  top: number;
  height: number;
  lane: number;
  lanes: number;
  /**
   * A piece of an event longer than its day: drawn as a narrow rail at the
   * left of the column (`lane` is its rail index), so a two-day trip does not
   * squeeze the day's calls into half the width.
   */
  rail: boolean;
  /** Rails at the left of the column; ordinary events start after them, px. */
  inset: number;
  /** The event began on an earlier day: the bar continues above the grid. */
  fromPrevDay: boolean;
  /** The event goes on after this day: the bar continues below the grid. */
  toNextDay: boolean;
};

/**
 * Positions the grid pieces of one day (DarkCalendar `top` / `h`). Ordinary
 * events that overlap share the column side by side, so none hides another.
 * Pieces of events longer than their day become rails at the left edge,
 * clipped to the 08–21 grid and flush with the edge they continue past.
 */
export function placeDayPieces(pieces: DayPiece[]): GridPlacement[] {
  const rails = pieces.filter(isContinued);
  const inset = rails.length * RAIL_PX;
  const placements: GridPlacement[] = rails
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)
    .map((piece, index) => {
      const start = Math.max(piece.startMin, GRID_START_MIN);
      const end = Math.min(piece.endMin, GRID_END_MIN);
      // A rail that goes on past the grid edge touches it (no 1px gap), so it reads as continuing.
      const gapTop = piece.fromPrevDay && start === GRID_START_MIN ? 0 : 1;
      const gapBottom = piece.toNextDay && end === GRID_END_MIN ? 0 : 1;
      return {
        item: piece.item,
        top: ((start - GRID_START_MIN) / 60) * HOUR_PX + gapTop,
        height: Math.max(((end - start) / 60) * HOUR_PX - gapTop - gapBottom, 20),
        lane: index,
        lanes: rails.length,
        rail: true,
        inset: 0,
        fromPrevDay: piece.fromPrevDay,
        toNextDay: piece.toNextDay,
      };
    });

  const sorted = pieces
    .filter((piece) => !isContinued(piece))
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  let cluster: GridPlacement[] = [];
  let clusterEnd = -Infinity;
  const laneEnds: number[] = [];

  const closeCluster = () => {
    const lanes = Math.max(1, ...cluster.map((placement) => placement.lane + 1));
    cluster.forEach((placement) => {
      placement.lanes = lanes;
    });
    cluster = [];
    laneEnds.length = 0;
  };

  for (const piece of sorted) {
    const start = piece.startMin;
    const durationMin = Math.max(1, piece.endMin - start);
    const visualEnd = Math.min(GRID_END_MIN, start + Math.max(durationMin, 28));
    if (start >= clusterEnd && cluster.length) closeCluster();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(visualEnd);
    } else {
      laneEnds[lane] = visualEnd;
    }
    const clampedDuration = Math.min(durationMin, GRID_END_MIN - start);
    const placement: GridPlacement = {
      item: piece.item,
      top: ((start - GRID_START_MIN) / 60) * HOUR_PX + 1,
      height: Math.max((clampedDuration / 60) * HOUR_PX - 2, 20),
      lane,
      lanes: 1,
      rail: false,
      inset,
      fromPrevDay: false,
      toNextDay: false,
    };
    cluster.push(placement);
    placements.push(placement);
    clusterEnd = Math.max(clusterEnd, visualEnd);
  }
  if (cluster.length) closeCluster();
  return placements;
}

/** Positions one-day events of their start day (see `placeDayPieces`). */
export function placeDayEvents(items: CalendarItem[]): GridPlacement[] {
  return placeDayPieces(items.map(startPiece));
}

function clockOfMinutes(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`;
}

/**
 * The time label of a piece in a strip or a month cell: the start on its
 * first day, «до 10:00» on its last, «весь день» in between.
 */
export function pieceTimeText(piece: DayPiece): string {
  if (piece.item.allDay || (piece.fromPrevDay && piece.toNextDay)) return 'весь день';
  if (piece.fromPrevDay) return `до ${clockOfMinutes(piece.endMin)}`;
  return clockOfMinutes(piece.startMin);
}

/** «вс 20:00 → вт 10:00»: the whole span of an event longer than a day. */
export function formatSpan(item: CalendarItem): string {
  const start = toWall(item.startsAt);
  const end = toWall(item.endsAt);
  return `${formatDayFull(start).slice(0, 2)} ${formatClock(start)} → ${formatDayFull(end).slice(0, 2)} ${formatClock(end)}`;
}

/** Pixel offset of an instant inside the 08–21 grid, or null when it is outside. */
export function gridOffset(date: Date): number | null {
  const minutes = minutesOfDay(date);
  if (minutes < GRID_START_MIN || minutes > GRID_END_MIN) return null;
  return Math.round(((minutes - GRID_START_MIN) / 60) * HOUR_PX);
}

/** The nearest planned event with people or for Claude (not server timers), for the «через N мин» mark. */
export function findNextItem(items: CalendarItem[], nowMs: number): CalendarItem | null {
  return items
    .filter((item) => item.type !== 'server_schedule' && item.status === 'planned' && Date.parse(item.startsAt) > nowMs)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null;
}

/** «через 28 мин», «через 1 ч 05 мин»; empty when the event is too far away. */
export function formatCountdown(startsAtMs: number, nowMs: number): string {
  const left = startsAtMs - nowMs;
  if (left <= 0 || left > COUNTDOWN_WINDOW_MS) return '';
  const minutes = Math.max(1, Math.round(left / 60_000));
  if (minutes < 60) return `через\u00a0${minutes}\u00a0мин`;
  return `через\u00a0${Math.floor(minutes / 60)}\u00a0ч ${pad2(minutes % 60)}\u00a0мин`;
}

/** «за 15 мин», «за 1 ч», «в момент события», «без напоминания». */
export function formatRemind(minutes: number | null): string {
  if (minutes === null) return 'без напоминания';
  if (minutes === 0) return 'в момент события';
  if (minutes % 1440 === 0) return `за ${minutes / 1440} ${plural(minutes / 1440, 'день', 'дня', 'дней')}`;
  if (minutes % 60 === 0) return `за ${minutes / 60} ч`;
  return `за ${minutes} мин`;
}

/** «2 мин назад», «только что», «в 14:05», «вчера в 23:10». */
export function formatAgo(iso: string | null, nowMs: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  const seconds = Math.round((nowMs - at) / 1000);
  if (seconds < 45) return 'только что';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const date = toWall(at);
  const now = toWall(nowMs);
  if (isSameDay(date, now)) return `в ${formatClock(date)}`;
  if (isSameDay(date, addDays(now, -1))) return `вчера в ${formatClock(date)}`;
  return `${formatDayMonth(date)} в ${formatClock(date)}`;
}

/** Telegram link from a free-text contact (`@nick`, `t.me/nick`, `nick`); null when it is not a username. */
export function telegramUrl(value: string | null): string | null {
  if (!value) return null;
  const match = /(?:t\.me\/|@)?([A-Za-z][A-Za-z0-9_]{3,31})\s*$/.exec(value.trim());
  return match ? `https://t.me/${match[1]}` : null;
}

/** `tel:` link from a free-text phone; null when there are too few digits. */
export function phoneUrl(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 5 ? `tel:${digits}` : null;
}

/** The second line of a grid event (DarkCalendar `sub`). */
export function itemSubline(item: CalendarItem): string {
  if (item.source === 'scheduled_message') return item.agent?.sessionTitle || item.projectName || 'Claude';
  if (item.source === 'systemd') return item.server?.unit ?? 'сервер';
  const contact = item.contact?.name;
  if (item.type === 'meeting') return [contact, item.location].filter(Boolean).join(' · ') || item.projectName || (item.source === 'google' ? 'Google' : '');
  return contact || item.location || item.projectName || (item.source === 'google' ? 'Google' : '');
}

/** The short title of strip pills («Сборка» for a long timer description). */
export function itemShortTitle(item: CalendarItem): string {
  if (item.source === 'systemd') return item.server?.description || item.server?.unit || item.title;
  return item.title;
}

function formatOffset(minutes: number): string {
  const hours = Math.trunc(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return `UTC${minutes >= 0 ? '+' : '−'}${hours}${rest ? `:${pad2(rest)}` : ''}`;
}

/**
 * The zone line of a server timer: systemd reads `OnCalendar` in the server's
 * zone (e.g. Europe/Helsinki), which may have summer time, so the same «05:17»
 * lands an hour apart in a panel zone without it before and after the switch. `note` explains a
 * firing whose offset differs from today's, null otherwise.
 */
export function describeTimerZone(server: NonNullable<CalendarItem['server']>, panelLabel: string): { value: string; note: string | null } | null {
  if (!server.timeZone) return null;
  const at = server.utcOffsetMin;
  const current = server.currentUtcOffsetMin;
  const value = server.timeZone === 'UTC' ? 'UTC' : `${server.timeZone}${current !== null ? ` · ${formatOffset(current)}` : ''}`;
  if (at === null || current === null || at === current) return { value, note: null };
  const shiftMin = Math.abs(at - current);
  const shift = shiftMin % 60 === 0 ? `${shiftMin / 60} ч` : `${shiftMin} мин`;
  const direction = at > current ? 'раньше' : 'позже';
  return {
    value,
    note: `в этот день на сервере ${formatOffset(at)} (сезонный перевод часов) — по ${panelLabel} запуск на ${shift} ${direction}, чем сейчас`,
  };
}
