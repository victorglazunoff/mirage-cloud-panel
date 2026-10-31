import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type {
  LiveAgentsActionResult,
  LiveAgentsDelta,
  LiveAgentsFeedEvent,
  LiveAgentsSession,
  LiveAgentsSnapshot,
  LiveAgentsStats,
  ServerEvent,
} from '@/shared/types';

/** The screen keeps the newest rows only; the server sends at most 100. */
const FEED_LIMIT = 60;
/** An action that got no `agents_action_result` in this time is reported as lost. */
const ACTION_TIMEOUT_MS = 12_000;
/** While the socket is down the screen falls back to polling the snapshot. */
const OFFLINE_POLL_MS = 15_000;

/** Live state of the «Агенты» screen: the agent trees, feed and counters, plus when each session last changed locally. */
export type AgentsLiveState = {
  sessions: LiveAgentsSession[];
  feed: LiveAgentsFeedEvent[];
  stats: LiveAgentsStats | null;
  /** Local `Date.now()` when each session's numbers were taken; running timers count on from it. */
  receivedAt: Record<string, number>;
  seq: number;
};

const EMPTY_STATE: AgentsLiveState = { sessions: [], feed: [], stats: null, receivedAt: {}, seq: -1 };

function fromSnapshot(snapshot: LiveAgentsSnapshot, now: number): AgentsLiveState {
  const receivedAt: Record<string, number> = {};
  for (const session of snapshot.sessions) receivedAt[session.sessionId] = now;
  return {
    sessions: snapshot.sessions,
    feed: snapshot.feed.slice(0, FEED_LIMIT),
    stats: snapshot.stats,
    receivedAt,
    seq: snapshot.seq,
  };
}

/**
 * Folds an `agents_delta` frame into the state: changed sessions are replaced
 * whole (by id, keeping their place), removed ones dropped, new feed rows go on
 * top. A frame not newer than the state is ignored.
 */
export function applyAgentsDelta(state: AgentsLiveState, delta: LiveAgentsDelta, now: number): AgentsLiveState {
  if (delta.seq <= state.seq) return state;
  const removed = new Set(delta.removedSessionIds);
  const changed = new Map(delta.sessions.map((session) => [session.sessionId, session]));
  const receivedAt = { ...state.receivedAt };
  const sessions: LiveAgentsSession[] = [];
  for (const session of state.sessions) {
    if (removed.has(session.sessionId)) {
      delete receivedAt[session.sessionId];
      continue;
    }
    const next = changed.get(session.sessionId);
    if (next) {
      sessions.push(next);
      receivedAt[session.sessionId] = now;
      changed.delete(session.sessionId);
    } else {
      sessions.push(session);
    }
  }
  for (const session of changed.values()) {
    sessions.push(session);
    receivedAt[session.sessionId] = now;
  }
  const knownIds = new Set(state.feed.map((event) => event.id));
  const freshFeed = delta.feed.filter((event) => !knownIds.has(event.id));
  return {
    sessions,
    feed: [...freshFeed, ...state.feed].slice(0, FEED_LIMIT),
    stats: delta.stats,
    receivedAt,
    seq: delta.seq,
  };
}

type PendingAction = { resolve: (result: LiveAgentsActionResult) => void; timer: number };

type AgentsLive = {
  state: AgentsLiveState;
  /** The first snapshot has arrived (REST or socket). */
  loaded: boolean;
  /** Why the snapshot could not be loaded, while there is nothing to show. */
  error: string | null;
  /** Reads the snapshot again (the screen's «Повторить»). */
  reload: () => Promise<void>;
  /** The socket stream is on (frames arrive as they happen). */
  live: boolean;
  stopAgent: (sessionId: string, agentId: string) => Promise<LiveAgentsActionResult>;
  stopSession: (sessionId: string) => Promise<LiveAgentsActionResult>;
  answerPermission: (requestId: string, allow: boolean) => Promise<LiveAgentsActionResult>;
};

let requestCounter = 0;

/**
 * Loads GET /api/agents/live, then streams `agents_snapshot` / `agents_delta`
 * over the chat websocket (`agents.subscribe`; re-sent after every reconnect)
 * and sends the screen's actions with a request key, resolving each with its
 * `agents_action_result`. Used by the «Агенты» screen and by the kabina-chat screen
 * (subagent cards and the turn line), which passes `enabled` only while its session works.
 */
export function useAgentsLive(enabled = true): AgentsLive {
  const { sendMessage, subscribe, isConnected } = useWebSocket();
  // The folded snapshot; every frame produces a new object so the screen re-renders.
  const [state, setState] = useState<AgentsLiveState>(EMPTY_STATE);
  // Whether any snapshot arrived; the screen shows a skeleton before that.
  const [loaded, setLoaded] = useState(false);
  // The REST load failed and no socket snapshot replaced it yet.
  const [error, setError] = useState<string | null>(null);
  // An `agents_snapshot` came on the current socket, so deltas will follow.
  const [streaming, setStreaming] = useState(false);
  const pendingRef = useRef(new Map<string, PendingAction>());

  const loadSnapshot = useCallback(async () => {
    try {
      const response = await api.agentsLive.snapshot();
      const body = await readApiJson<{ data: LiveAgentsSnapshot }>(response);
      // A socket snapshot that landed meanwhile is at least as fresh.
      setState((current) => (body.data.seq >= current.seq ? fromSnapshot(body.data, Date.now()) : current));
      setLoaded(true);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить агентов');
    }
  }, []);

  // `enabled` off (the chat between turns): no load, no stream — the chat needs the tree only
  // while its turn runs.
  useEffect(() => {
    if (enabled) void loadSnapshot();
  }, [enabled, loadSnapshot]);

  useEffect(() => {
    const pending = pendingRef.current;
    const unsubscribe = subscribe((event: ServerEvent) => {
      switch (event.kind) {
        case 'agents_snapshot': {
          const snapshot = event.snapshot as LiveAgentsSnapshot | undefined;
          if (!snapshot) return;
          setState(fromSnapshot(snapshot, Date.now()));
          setLoaded(true);
          setError(null);
          setStreaming(true);
          return;
        }
        case 'agents_delta': {
          const delta = event.delta as LiveAgentsDelta | undefined;
          if (!delta) return;
          setState((current) => applyAgentsDelta(current, delta, Date.now()));
          return;
        }
        case 'agents_action_result': {
          const key = typeof event.requestKey === 'string' ? event.requestKey : null;
          const entry = key ? pending.get(key) : undefined;
          if (!key || !entry) return;
          window.clearTimeout(entry.timer);
          pending.delete(key);
          entry.resolve({ ok: event.ok === true, error: typeof event.error === 'string' ? event.error : null });
          return;
        }
        default:
      }
    });
    return () => {
      unsubscribe();
    };
  }, [subscribe]);

  // Subscription lives on the socket object: (re)send it whenever a socket comes up.
  useEffect(() => {
    // `live` below already reads false while the socket is down.
    if (!isConnected || !enabled) return undefined;
    sendMessage({ type: 'agents.subscribe' });
    return () => {
      sendMessage({ type: 'agents.unsubscribe' });
    };
  }, [enabled, isConnected, sendMessage]);

  // Without a socket the screen still moves, just slower.
  useEffect(() => {
    if (isConnected || !enabled) return undefined;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadSnapshot();
    }, OFFLINE_POLL_MS);
    return () => window.clearInterval(interval);
  }, [enabled, isConnected, loadSnapshot]);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const entry of pending.values()) window.clearTimeout(entry.timer);
      pending.clear();
    };
  }, []);

  const sendAction = useCallback((frame: Record<string, unknown>): Promise<LiveAgentsActionResult> => {
    requestCounter += 1;
    const requestKey = `agents-${Date.now().toString(36)}-${requestCounter}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingRef.current.delete(requestKey);
        resolve({ ok: false, error: 'Сервер не ответил — проверь связь и повтори.' });
      }, ACTION_TIMEOUT_MS);
      pendingRef.current.set(requestKey, { resolve, timer });
      if (!sendMessage({ ...frame, requestKey })) {
        window.clearTimeout(timer);
        pendingRef.current.delete(requestKey);
        resolve({ ok: false, error: 'Нет связи с сервером.' });
      }
    });
  }, [sendMessage]);

  const stopAgent = useCallback(
    (sessionId: string, agentId: string) => sendAction({ type: 'agents.stop', sessionId, agentId }),
    [sendAction],
  );
  const stopSession = useCallback(
    (sessionId: string) => sendAction({ type: 'agents.stop-session', sessionId }),
    [sendAction],
  );
  const answerPermission = useCallback(
    (requestId: string, allow: boolean) => sendAction({ type: 'agents.permission', requestId, allow }),
    [sendAction],
  );

  return {
    state,
    loaded,
    error: loaded ? null : error,
    reload: loadSnapshot,
    live: isConnected && streaming,
    stopAgent,
    stopSession,
    answerPermission,
  };
}
