import { useEffect, useRef, useState } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';

/** DarkStates C1: a drop shorter than this is not worth a banner. */
const LOST_AFTER_MS = 2_000;
/** The websocket provider retries every 3 s after a close. */
const RETRY_EVERY_MS = 3_000;
/** DarkStates C1: the green "связь восстановлена" stays 4 s. */
const BACK_FOR_MS = 4_000;

type ConnectionWatch =
  | { state: 'ok' }
  | { state: 'lost'; attempt: number; secondsToRetry: number; retryShare: number }
  | { state: 'back'; downForSeconds: number };

/**
 * Used by KabinaShell: turns the websocket's connection status into the
 * DarkStates states — `lost` after 2 s down (with the retry countdown of the
 * provider's 3-second loop) and `back` for 4 s once it reconnects.
 */
export function useConnectionWatch(): ConnectionWatch & { retryNow: () => void } {
  const { connectionStatus, reconnectNow } = useWebSocket();
  // When the socket went down; null while connected or still on the first handshake.
  const [downSince, setDownSince] = useState<number | null>(null);
  // When it came back after a reported loss; drives the 4-second green state.
  const [backAt, setBackAt] = useState<{ at: number; downFor: number } | null>(null);
  // Ticks once a second while down, so the countdown moves.
  const [now, setNow] = useState(() => Date.now());
  const downSinceRef = useRef<number | null>(null);

  useEffect(() => {
    if (connectionStatus === 'disconnected') {
      if (downSinceRef.current === null) {
        downSinceRef.current = Date.now();
        setDownSince(downSinceRef.current);
      }
      return;
    }
    if (connectionStatus === 'connected' && downSinceRef.current !== null) {
      const downForMs = Date.now() - downSinceRef.current;
      downSinceRef.current = null;
      setDownSince(null);
      // Only a loss that was shown gets the green "back" state.
      if (downForMs >= LOST_AFTER_MS) {
        setBackAt({ at: Date.now(), downFor: Math.round(downForMs / 1000) });
      }
    }
  }, [connectionStatus]);

  useEffect(() => {
    if (downSince === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [downSince]);

  useEffect(() => {
    if (!backAt) return undefined;
    const timer = window.setTimeout(() => setBackAt(null), BACK_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [backAt]);

  if (downSince !== null) {
    const elapsed = Math.max(0, now - downSince);
    if (elapsed >= LOST_AFTER_MS) {
      const intoCycle = elapsed % RETRY_EVERY_MS;
      return {
        state: 'lost',
        attempt: Math.floor(elapsed / RETRY_EVERY_MS) + 1,
        secondsToRetry: Math.max(1, Math.ceil((RETRY_EVERY_MS - intoCycle) / 1000)),
        retryShare: intoCycle / RETRY_EVERY_MS,
        retryNow: reconnectNow,
      };
    }
  }
  if (backAt) {
    return { state: 'back', downForSeconds: backAt.downFor, retryNow: reconnectNow };
  }
  return { state: 'ok', retryNow: reconnectNow };
}
