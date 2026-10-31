import { useSyncExternalStore } from 'react';

/**
 * The panel's own time zone. Every clock and time on the Kabina screens is
 * shown in the zone the server reports (`MIRAGE_TIMEZONE`, else the server's
 * own zone), whatever zone the browser (or a test machine) is in, and signed
 * with the server's caption (`MIRAGE_TIMEZONE_LABEL`, e.g. «ЕКБ») or, without
 * one, with the zone's UTC offset («UTC+5»).
 */

/**
 * Used by this file (the zone until the server answered) and by tests that pin
 * the panel zone to the machine's: the browser's own IANA zone, UTC if unknown.
 */
export function browserTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

let currentZone = browserTimeZone();
/** The server's caption of `currentZone`; null — the UTC offset is shown instead. */
let currentLabel: string | null = null;
let loadStarted = false;
const listeners = new Set<() => void>();
const formatters = new Map<string, Intl.DateTimeFormat>();

function isValidZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone the Kabina screens show time in (the default until the server answered). */
export function getPanelTimeZone(): string {
  return currentZone;
}

/**
 * Sets the panel zone and its caption (from the server; also used by tests).
 * An invalid zone keeps the current one; a blank or missing label means «no
 * caption, show the UTC offset».
 */
export function setPanelTimeZone(zone: unknown, label: unknown = null): void {
  const nextZone = isValidZone(zone) ? zone : currentZone;
  const nextLabel = typeof label === 'string' && label.trim() ? label.trim() : null;
  if (nextZone === currentZone && nextLabel === currentLabel) return;
  if (nextZone !== currentZone) formatters.clear();
  currentZone = nextZone;
  currentLabel = nextLabel;
  for (const listener of listeners) listener();
}

/**
 * Reads the zone once per page load from `GET /api/auth/status` (public, so it
 * also works on the sign-in screen). Failures keep the default.
 */
function loadPanelTimeZone(): void {
  if (loadStarted || typeof fetch !== 'function') return;
  loadStarted = true;
  void fetch('/api/auth/status')
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { timeZone?: unknown; timeZoneLabel?: unknown } | null) => {
      if (body) setPanelTimeZone(body.timeZone, body.timeZoneLabel);
    })
    .catch(() => {
      // Offline or an older server: the default zone stays.
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  loadPanelTimeZone();
  return () => {
    listeners.delete(listener);
  };
}

/** Zone and caption together: a caption that arrives for an unchanged zone still re-renders. */
function readZoneSnapshot(): string {
  return `${currentZone}\n${currentLabel ?? ''}`;
}

/**
 * Used by the shell clock and the screens: the panel zone, re-rendering when the
 * server's answer (zone or caption) arrives.
 */
export function usePanelTimeZone(): string {
  useSyncExternalStore(subscribe, readZoneSnapshot, readZoneSnapshot);
  return currentZone;
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/**
 * A Date whose local fields (getHours, getDate, getDay…) show the wall clock
 * of `instant` in the panel zone. Screens format such "wall" dates with the
 * usual getters; `fromPanelWall` turns one back into the real instant.
 */
export function toPanelWall(instant: string | number | Date, zone: string = currentZone): Date {
  const ms = typeof instant === 'string' ? Date.parse(instant) : typeof instant === 'number' ? instant : instant.getTime();
  if (!Number.isFinite(ms)) return new Date(Number.NaN);
  const parts: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) parts[part.type] = Number(part.value);
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, ((ms % 1000) + 1000) % 1000);
}

/** The real instant of a wall date (inverse of `toPanelWall`). */
export function fromPanelWall(wall: Date, zone: string = currentZone): Date {
  const guess = Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes(), wall.getSeconds());
  const shown = toPanelWall(guess, zone);
  const offset = Date.UTC(shown.getFullYear(), shown.getMonth(), shown.getDate(), shown.getHours(), shown.getMinutes(), shown.getSeconds()) - guess;
  return new Date(guess - offset + wall.getMilliseconds());
}

/**
 * Minutes between UTC and the panel zone at `instant`, signed like `Date#getTimezoneOffset()`
 * (positive west of UTC: UTC+5 gives −300). Used for the `?tzOffset=` of
 * `/api/home/*`, so «сегодня» on the server is the panel's day, not the device's.
 */
export function panelTimezoneOffset(instant: Date = new Date(), zone: string = currentZone): number {
  const wall = toPanelWall(instant, zone);
  const minuteStart = Math.floor(instant.getTime() / 60_000) * 60_000;
  const east = Math.round((Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes()) - minuteStart) / 60_000);
  return east === 0 ? 0 : -east;
}

/**
 * The caption of panel times: the server's `MIRAGE_TIMEZONE_LABEL` («ЕКБ») for the
 * panel zone, else «UTC+N» of the zone at `instant`.
 */
export function panelZoneLabel(zone: string = currentZone, instant: Date = new Date()): string {
  if (zone === currentZone && currentLabel) return currentLabel;
  const wall = toPanelWall(instant, zone);
  const offsetMinutes = Math.round((Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes()) - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000);
  const hours = Math.trunc(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  return `UTC${offsetMinutes >= 0 ? '+' : '−'}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}
