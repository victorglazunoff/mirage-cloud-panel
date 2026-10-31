import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { SessionContextUsage } from '@/shared/types';

/** While a turn runs the window fills quickly; idle sessions change only on the next message. */
const RUNNING_POLL_MS = 15_000;
const IDLE_POLL_MS = 60_000;

/**
 * Used by the kabina-chat context panel and phone sheet: `GET /api/context/:id`
 * for the open session (polled, faster while a turn runs, re-read when a turn
 * ends), plus «Сжать сессию» — queue or cancel a compaction after the turn.
 */
export function useSessionContext(sessionId: string | null, isRunning: boolean) {
  // Latest context reading of the open session; null until the first answer or without a session.
  const [usage, setUsage] = useState<SessionContextUsage | null>(null);
  // Set when the last read failed, so the panel can say so instead of showing stale zeros.
  const [error, setError] = useState<string | null>(null);
  // A compaction request is in flight (the button shows it and ignores repeat clicks).
  const [isCompactPending, setIsCompactPending] = useState(false);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const read = useCallback(async (fresh = false) => {
    const target = sessionRef.current;
    if (!target) return;
    try {
      const response = await api.sessionContext.read(target, fresh);
      const body = await response.json().catch(() => null) as { data?: SessionContextUsage } | SessionContextUsage | null;
      if (sessionRef.current !== target) return;
      const data = body && 'data' in body ? body.data : body;
      if (!response.ok || !data || typeof (data as SessionContextUsage).maxTokens !== 'number') {
        setError('контекст недоступен');
        return;
      }
      setUsage(data as SessionContextUsage);
      setError(null);
    } catch {
      if (sessionRef.current === target) setError('нет связи');
    }
  }, []);

  // Another session: forget the old reading and read the new one right away.
  useEffect(() => {
    setUsage(null);
    setError(null);
    if (sessionId) void read();
  }, [read, sessionId]);

  // `isRunning` changes the poll rate only: the last reading stays on screen until the next
  // one lands, so a turn's start or end never flashes «считаю контекст…».
  useEffect(() => {
    if (!sessionId) return undefined;
    const timer = window.setInterval(() => void read(), isRunning ? RUNNING_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isRunning, read, sessionId]);

  // A turn just ended: the window changed, read it without the server cache.
  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) void read(true);
    wasRunningRef.current = isRunning;
  }, [isRunning, read]);

  const toggleCompact = useCallback(async () => {
    const target = sessionRef.current;
    if (!target || isCompactPending) return;
    setIsCompactPending(true);
    const queued = Boolean(usage?.compactQueued);
    try {
      const response = queued ? await api.sessionContext.cancelCompact(target) : await api.sessionContext.queueCompact(target);
      if (response.ok && sessionRef.current === target) {
        setUsage((current) => (current ? { ...current, compactQueued: !queued } : current));
      }
    } finally {
      setIsCompactPending(false);
    }
  }, [isCompactPending, usage?.compactQueued]);

  return { usage, error, isCompactPending, toggleCompact, refresh: read };
}
