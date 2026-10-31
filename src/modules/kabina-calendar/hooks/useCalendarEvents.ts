import { useCallback, useEffect, useRef, useState } from 'react';

import { calendarZone } from '@/modules/kabina-calendar/utils/calendarModel';
import { api, readApiJson } from '@/shared/api';
import type { CalendarItem } from '@/shared/types';

/** The calendar also changes from Google and the scheduled-message queue, so an open screen polls. */
const POLL_INTERVAL_MS = 60_000;

type CalendarEventsState = {
  /** Null until the first answer for the current range. */
  items: CalendarItem[] | null;
  error: string | null;
  /** When `items` last loaded (ms); with `error` set, how old the grid on screen is. */
  loadedAt: number | null;
  refresh: () => void;
  /** Puts a fresh copy of one item into the list right away (after an action), before the refetch lands. */
  replaceItem: (item: CalendarItem) => void;
  /** Drops an event (and the rest of its series, unless `onlyThis`) from the list right away after a delete. */
  removeItem: (id: string, onlyThis?: boolean) => void;
};

/** The zone the calendar API reads and writes in (the panel's, not the browser's). */
export function calendarTimeZone(): string {
  return calendarZone();
}

/** Loads `GET /api/calendar/events` for `[from, to)` and keeps it fresh while the screen is open. */
export function useCalendarEvents(from: Date, to: Date, types?: string): CalendarEventsState {
  // The last good listing; kept while a new range loads so the grid does not blank.
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  // Why the latest load failed.
  const [error, setError] = useState<string | null>(null);
  // When the listing on screen arrived.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const requestIdRef = useRef(0);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const refresh = useCallback(() => {
    const requestId = ++requestIdRef.current;
    void (async () => {
      try {
        const response = await api.calendar.events({ from: fromIso, to: toIso, tz: calendarTimeZone(), type: types });
        const body = await readApiJson<{ data: { items: CalendarItem[] } }>(response);
        // A slow answer for an old range must not overwrite the new one.
        if (requestId !== requestIdRef.current) return;
        setItems(body.data.items);
        setLoadedAt(Date.now());
        setError(null);
      } catch (loadError) {
        if (requestId !== requestIdRef.current) return;
        // fetch() rejects with a TypeError («Failed to fetch») when the panel is unreachable.
        setError(loadError instanceof TypeError
          ? 'нет связи с панелью — повторю сам через минуту'
          : loadError instanceof Error ? loadError.message : 'Не удалось загрузить календарь');
      }
    })();
  }, [fromIso, toIso, types]);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      requestIdRef.current += 1;
    };
  }, [refresh]);

  const replaceItem = useCallback((next: CalendarItem) => {
    setItems((current) => current?.map((item) => (item.id === next.id ? next : item)) ?? current);
  }, []);

  // A deleted event (or its whole series: occurrences carry `occurrenceOf`) leaves the grid at once.
  const removeItem = useCallback((id: string, onlyThis = false) => {
    setItems((current) => {
      if (!current) return current;
      if (onlyThis) return current.filter((item) => item.id !== id);
      const seriesId = current.find((item) => item.id === id)?.occurrenceOf ?? id;
      return current.filter((item) => item.id !== id && item.id !== seriesId && item.occurrenceOf !== seriesId);
    });
  }, []);

  return { items, error, loadedAt, refresh, replaceItem, removeItem };
}
