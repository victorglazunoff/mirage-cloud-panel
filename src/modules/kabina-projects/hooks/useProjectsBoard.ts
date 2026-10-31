import { useCallback, useEffect, useRef, useState } from 'react';

import { panelTimezoneOffset } from '@/modules/kabina';
import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { HomeProjectsBoard, ServerEvent } from '@/shared/types';

/** Running/waiting changes without a frame reaching this tab, so the board also polls. */
const POLL_INTERVAL_MS = 10_000;
/** A streaming turn sends bursts of frames; they collapse into one refetch. */
const EVENT_DEBOUNCE_MS = 700;
/** Frames after which a project's status, stats or the list itself may have changed. */
const REFRESH_EVENT_KINDS = new Set([
  'session_upserted',
  'permission_request',
  'permission_resolved',
  'permission_cancelled',
  'turn_stopped',
  'task_status',
  'websocket_reconnected',
  'projects_updated',
]);

type ProjectsBoardState = {
  board: HomeProjectsBoard | null;
  error: string | null;
  /** Refetches now; resolves once the new board is in state (the wizard waits for it before «Готово»). */
  refresh: () => Promise<void>;
  /** Applies an optimistic change at once (star, rename, archive) until the next refetch confirms it. */
  patchProject: (projectId: string, patch: Partial<HomeProjectsBoard['projects'][number]>) => void;
};

/** Loads the «Все проекты» read model and keeps it fresh while the screen is open. */
export function useProjectsBoard(): ProjectsBoardState {
  // The last good board; kept on a failed refresh so the list never blanks.
  const [board, setBoard] = useState<HomeProjectsBoard | null>(null);
  // Why the latest refresh failed, shown only while there is nothing to display.
  const [error, setError] = useState<string | null>(null);
  const { subscribe } = useWebSocket();
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const response = await api.home.projects(panelTimezoneOffset());
      const body = await readApiJson<{ data: HomeProjectsBoard }>(response);
      // A slow response must not overwrite a newer one.
      if (requestId !== requestIdRef.current) return;
      setBoard(body.data);
      setError(null);
    } catch (refreshError) {
      if (requestId !== requestIdRef.current) return;
      setError(refreshError instanceof Error ? refreshError.message : 'Не удалось загрузить проекты');
    }
  }, []);

  const patchProject = useCallback<ProjectsBoardState['patchProject']>((projectId, patch) => {
    setBoard((current) => current && {
      ...current,
      projects: current.projects.map((project) => (project.projectId === projectId ? { ...project, ...patch } : project)),
    });
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      // Drop responses that land after unmount.
      requestIdRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = subscribe((event: ServerEvent) => {
      if (!event.kind || !REFRESH_EVENT_KINDS.has(event.kind)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, EVENT_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh, subscribe]);

  return { board, error, refresh, patchProject };
}
