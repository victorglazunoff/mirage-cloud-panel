import { useEffect, useState } from 'react';

import { panelTimezoneOffset } from '@/modules/kabina';
import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { HomeOverview, ServerEvent } from '@/shared/types';

/** Busy/waiting state changes without a websocket frame reaching this tab, so the feed also polls. */
const POLL_INTERVAL_MS = 8_000;
/** Bursts of frames (a streaming turn) collapse into one refetch. */
const EVENT_DEBOUNCE_MS = 700;
/** Frames after which the overview may have changed. */
const REFRESH_EVENT_KINDS = new Set([
  'session_upserted',
  'permission_request',
  'permission_resolved',
  'permission_cancelled',
  'turn_stopped',
  'task_status',
  'websocket_reconnected',
]);

/** What a subscriber of the shared overview sees. */
type HomeOverviewSnapshot = {
  /** The last good overview; kept on a failed refresh so screens never blank. */
  overview: HomeOverview | null;
  /** Why the latest refresh failed; null after a good one. */
  error: string | null;
};

/*
 * One poller for the whole page: the home screen, the shell's activity watcher (bell + HUD),
 * ⌘K and «Файлы» read the same `/api/home/overview` answer instead of each fetching it.
 * The first subscriber starts the poll (and reads at once), the last one stops it; websocket
 * frames from any subscriber collapse into one debounced refetch.
 */
let snapshot: HomeOverviewSnapshot = { overview: null, error: null };
const listeners = new Set<(next: HomeOverviewSnapshot) => void>();
let pollTimer: number | null = null;
let nudgeTimer: number | null = null;
let requestCounter = 0;

function publish(next: HomeOverviewSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener(snapshot));
}

function loadOverview(): Promise<void> {
  const requestId = ++requestCounter;
  return (async () => {
    try {
      const body = await readApiJson<{ data: HomeOverview }>(await api.home.overview(panelTimezoneOffset()));
      // A slow response must not overwrite a newer one.
      if (requestId !== requestCounter) return;
      publish({ overview: body.data, error: null });
    } catch (error) {
      if (requestId !== requestCounter) return;
      publish({ overview: snapshot.overview, error: error instanceof Error ? error.message : 'Не удалось загрузить сводку' });
    }
  })();
}

function handleVisibility() {
  if (document.visibilityState === 'visible') void loadOverview();
}

function nudgeOverview() {
  if (nudgeTimer !== null) window.clearTimeout(nudgeTimer);
  nudgeTimer = window.setTimeout(() => {
    nudgeTimer = null;
    void loadOverview();
  }, EVENT_DEBOUNCE_MS);
}

function subscribe(listener: (next: HomeOverviewSnapshot) => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void loadOverview();
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadOverview();
    }, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (pollTimer !== null) window.clearInterval(pollTimer);
    if (nudgeTimer !== null) window.clearTimeout(nudgeTimer);
    pollTimer = null;
    nudgeTimer = null;
    document.removeEventListener('visibilitychange', handleVisibility);
    // Drop answers that land after the last subscriber left.
    requestCounter += 1;
  };
}

/**
 * Used by the home screen, the Kabina shell's activity watcher (bell entries, HUD «работают N»),
 * ⌘K live states and «Файлы» favourites: the home read model from one shared poll (every 8 s
 * and on websocket frames). Starts from the cached answer, so a screen change does not blink.
 * `refresh` asks for a new read now (a retry button).
 */
export function useHomeOverviewFeed(): HomeOverviewSnapshot & { refresh: () => Promise<void> } {
  // The shared overview answer; starts from the cache.
  const [current, setCurrent] = useState<HomeOverviewSnapshot>(snapshot);
  const { subscribe: subscribeToServer } = useWebSocket();

  useEffect(() => subscribe(setCurrent), []);

  useEffect(() => subscribeToServer((event: ServerEvent) => {
    if (event.kind && REFRESH_EVENT_KINDS.has(event.kind)) nudgeOverview();
  }), [subscribeToServer]);

  return { ...current, refresh: loadOverview };
}

