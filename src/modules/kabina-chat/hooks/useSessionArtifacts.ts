import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ArtifactSummary, ArtifactViewTicket } from '@/shared/types';

/**
 * Used by the kabina-chat screen: the open session's Artifacts
 * (`GET /api/sessions/:id/artifacts`), kept current by the `artifact_published`
 * websocket event, plus which one is shown in the side panel. `onPublished`
 * lets the screen open a freshly published artifact beside the chat.
 */
export function useSessionArtifacts(sessionId: string | null, onPublished?: (artifact: ArtifactSummary) => void) {
  const { subscribe } = useWebSocket();
  // Artifacts of the open session, newest first (empty until loaded or without a session).
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const onPublishedRef = useRef(onPublished);
  onPublishedRef.current = onPublished;

  const reload = useCallback(async () => {
    const target = sessionRef.current;
    if (!target) return;
    try {
      const response = await api.artifacts.listForSession(target);
      if (!response.ok) return;
      const body = await response.json() as { artifacts?: ArtifactSummary[] };
      if (sessionRef.current === target && Array.isArray(body.artifacts)) setArtifacts(body.artifacts);
    } catch {
      // The list is an extra: a failed read leaves what was shown.
    }
  }, []);

  useEffect(() => {
    setArtifacts([]);
    if (sessionId) void reload();
  }, [reload, sessionId]);

  useEffect(() => subscribe((frame) => {
    const event = frame as { kind?: string; sessionId?: string; artifact?: ArtifactSummary };
    if (event.kind !== 'artifact_published' || !event.artifact || event.sessionId !== sessionRef.current) return;
    const published = event.artifact;
    setArtifacts((current) => [published, ...current.filter((item) => item.artifactId !== published.artifactId)]);
    onPublishedRef.current?.(published);
    // The event carries only the new version; the list has the full history.
    void reload();
  }), [reload, subscribe]);

  return { artifacts, reload };
}

/**
 * Used by the kabina-chat artifact panel: the short-lived, ticketed frame URL
 * for one Artifact version. `refreshKey` re-asks for a new ticket («Обновить»).
 */
export function useArtifactFrame(artifactId: string | null, version: string | null, sessionId: string | null, refreshKey: number) {
  // The frame URL for the iframe, or null while it is being fetched / unavailable.
  const [ticket, setTicket] = useState<ArtifactViewTicket | null>(null);
  // Set when the panel could not get a frame (no local copy, offline).
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTicket(null);
    setError(null);
    if (!artifactId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.artifacts.viewTicket(artifactId, { version, sessionId });
        if (cancelled) return;
        if (!response.ok) {
          setError(response.status === 404 ? 'Локальной копии нет — открой на claude.ai.' : 'Не удалось открыть артефакт.');
          return;
        }
        setTicket(await response.json() as ArtifactViewTicket);
      } catch {
        if (!cancelled) setError('Нет связи с панелью.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId, refreshKey, sessionId, version]);

  return { ticket, error };
}
