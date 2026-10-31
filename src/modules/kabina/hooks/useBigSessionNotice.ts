import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { SessionTranscriptSize } from '@/shared/types';

const MB = 1024 * 1024;
/** DarkStates L4: «файл сессии больше 250 МБ». */
const THRESHOLD_BYTES = 250 * MB;
/** DarkStates L4: «Остаться» прячет до 400 МБ. */
const STAY_UNTIL_BYTES = 400 * MB;
/** The transcript grows only while a turn runs; once a minute is plenty. */
const POLL_MS = 60_000;
const STAY_KEY_PREFIX = 'kb-big-session-stay:';

function readStayUntil(sessionId: string): number | null {
  try {
    const raw = window.localStorage.getItem(`${STAY_KEY_PREFIX}${sessionId}`);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStayUntil(sessionId: string, bytes: number | null): void {
  try {
    if (bytes === null) window.localStorage.removeItem(`${STAY_KEY_PREFIX}${sessionId}`);
    else window.localStorage.setItem(`${STAY_KEY_PREFIX}${sessionId}`, String(bytes));
  } catch {
    // No storage: «Остаться» lasts until the page reloads.
  }
}

type BigSessionNoticeState = {
  /** Show the L4 plaque now. */
  visible: boolean;
  /** Transcript size in bytes; null until known or without a file. */
  sizeBytes: number | null;
  thresholdBytes: number;
  scaleMaxBytes: number;
  /** «Остаться здесь»: hide until the transcript reaches 400 МБ (remembered per session). */
  stay: () => void;
  /** «вернуть» after «Остаться»: show the plaque again. */
  undoStay: () => void;
  /** Whether the user chose «Остаться» for the current size band (for the outcome line). */
  stayed: boolean;
};

/**
 * Used by the chat (wired by the chat wave) for DarkStates L4: polls the
 * session transcript size and says whether «Большая сессия» should show —
 * over 250 МБ, unless the user chose «Остаться», which hides it until 400 МБ.
 */
export function useBigSessionNotice(sessionId: string | null): BigSessionNoticeState {
  // Latest known transcript size of the open session.
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  // Size up to which the user asked not to be reminded (from storage, per session).
  const [stayUntil, setStayUntil] = useState<number | null>(() => (sessionId ? readStayUntil(sessionId) : null));

  useEffect(() => {
    setSizeBytes(null);
    setStayUntil(sessionId ? readStayUntil(sessionId) : null);
    if (!sessionId) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const body = await readApiJson<{ data: SessionTranscriptSize }>(await api.contextSize(sessionId));
        if (!cancelled) setSizeBytes(body.data.bytes);
      } catch {
        // Unknown size shows nothing; the next poll retries.
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  const stay = useCallback(() => {
    if (!sessionId) return;
    writeStayUntil(sessionId, STAY_UNTIL_BYTES);
    setStayUntil(STAY_UNTIL_BYTES);
  }, [sessionId]);

  const undoStay = useCallback(() => {
    if (!sessionId) return;
    writeStayUntil(sessionId, null);
    setStayUntil(null);
  }, [sessionId]);

  const isBig = sizeBytes !== null && sizeBytes >= THRESHOLD_BYTES;
  const stayed = stayUntil !== null && sizeBytes !== null && sizeBytes < stayUntil;
  return {
    visible: isBig && !stayed,
    sizeBytes,
    thresholdBytes: THRESHOLD_BYTES,
    scaleMaxBytes: STAY_UNTIL_BYTES,
    stay,
    undoStay,
    stayed: isBig && stayed,
  };
}
