import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { CalendarSyncStatus } from '@/shared/types';

const POLL_INTERVAL_MS = 30_000;

/** The Google badge: reads `/api/calendar/sync-status` and runs «Синхронизировать сейчас». */
export function useCalendarSync(onSynced: () => void) {
  // Last status from the server; null until the first answer.
  const [status, setStatus] = useState<CalendarSyncStatus | null>(null);
  // True while «Синхронизировать сейчас» is running.
  const [isSyncing, setIsSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await readApiJson<{ data: CalendarSyncStatus }>(await api.calendar.syncStatus());
      setStatus(body.data);
    } catch {
      // The badge keeps its last state; the grid works without it.
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  const syncNow = useCallback(async () => {
    setIsSyncing(true);
    try {
      const body = await readApiJson<{ data: CalendarSyncStatus }>(await api.calendar.syncNow());
      setStatus(body.data);
      onSynced();
    } catch {
      await load();
    } finally {
      setIsSyncing(false);
    }
  }, [load, onSynced]);

  return { status, isSyncing, syncNow, reload: load };
}
