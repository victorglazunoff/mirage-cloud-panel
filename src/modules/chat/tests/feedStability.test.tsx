import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * Mirage: why a dialog's feed went empty while a turn ran (and how it stays
 * filled now).
 * - The live-agents panel shares the chat socket; its frames have no session
 *   id and no row id, were filed under the viewed dialog and made every later
 *   merge of it throw — the history never reached the screen.
 * - Two dialogs streaming at once shared one text buffer.
 * - A refresh that could not stitch the latest page onto the cached rows kept
 *   the stale rows for good.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const page = (messages: NormalizedMessage[], total: number, hasMore: boolean) => ({
  ok: true,
  json: async () => ({ data: { messages, total, hasMore } }),
});

const row = (id: string, minute: number, role: 'user' | 'assistant' = 'assistant'): NormalizedMessage => ({
  id,
  kind: 'text',
  role,
  provider: 'claude',
  sessionId: 'session-1',
  content: `row ${id}`,
  timestamp: new Date(Date.UTC(2026, 9, 27, 10, minute)).toISOString(),
} as NormalizedMessage);

beforeEach(() => {
  sessionMessages.mockReset();
});

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

async function renderStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  return renderHook(() => useSessionStore());
}

function renderHandlers(store: Partial<SessionStore>) {
  let listener: ((event: ServerEvent) => void) | null = null;
  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed' } as ProjectSession,
    currentSessionId: 'viewed',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    getSessionActivity: () => undefined,
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: () => {},
      getMessages: () => [],
      updateStreaming: () => {},
      finalizeStreaming: () => {},
      ...store,
    } as unknown as SessionStore,
  }));
  return (event: Record<string, unknown>) => listener?.(event as unknown as ServerEvent);
}

describe('frames of the live-agents panel', () => {
  test('are not filed as rows of the viewed dialog', () => {
    const stored: Array<{ sessionId: string; message: NormalizedMessage }> = [];
    const dispatch = renderHandlers({
      appendRealtime: (sessionId: string, message: NormalizedMessage) => { stored.push({ sessionId, message }); },
    });

    dispatch({ kind: 'agents_snapshot', snapshot: { seq: 1, sessions: [] } });
    dispatch({ kind: 'agents_delta', delta: { seq: 2 } });
    dispatch({ kind: 'agents_action_result', action: 'stop', requestKey: 'k1', ok: true, sessionId: 'viewed' });

    assert.deepEqual(stored, []);
  });
});

describe('a live row without an id', () => {
  it('does not keep the history off the screen', async () => {
    sessionMessages.mockResolvedValue(page([row('1', 1, 'user'), row('2', 2)], 2, false));
    const { result } = await renderStore();
    act(() => result.current.setActiveSession('session-1'));

    act(() => {
      result.current.appendRealtime('session-1', {
        kind: 'agents_delta',
        timestamp: new Date(Date.UTC(2026, 9, 27, 10, 3)).toISOString(),
      } as unknown as NormalizedMessage);
    });
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    const ids = result.current.getMessages('session-1').map((message) => message.id);
    assert.deepEqual(ids.slice(0, 2), ['1', '2']);
    assert.equal(result.current.getSessionSlot('session-1')?.status, 'idle');
  });
});

describe('two dialogs streaming at once', () => {
  test('each keeps its own text', () => {
    const streamed = new Map<string, string>();
    const appended: string[] = [];
    const dispatch = renderHandlers({
      appendRealtime: (sessionId: string) => { appended.push(sessionId); },
      updateStreaming: (sessionId: string, text: string) => { streamed.set(sessionId, text); },
    });

    dispatch({ kind: 'stream_delta', sessionId: 'viewed', content: 'Hello ' });
    dispatch({ kind: 'stream_delta', sessionId: 'background', content: 'Мир' });
    dispatch({ kind: 'stream_delta', sessionId: 'viewed', content: 'world' });
    dispatch({ kind: 'stream_end', sessionId: 'viewed' });
    dispatch({ kind: 'stream_end', sessionId: 'background' });

    assert.equal(streamed.get('viewed'), 'Hello world');
    assert.equal(streamed.get('background'), 'Мир');
    // Raw deltas are not rows of their own.
    assert.deepEqual(appended, []);
  });
});

describe('a refresh that cannot stitch onto the cached rows', () => {
  it('replaces them with a fresh window instead of keeping stale ones', async () => {
    const cached = [row('1', 1, 'user'), row('2', 2), row('3', 3)];
    const latest = [row('20', 20, 'user'), row('21', 21), row('22', 22)];
    const fresh = [row('18', 18), row('19', 19), ...latest];
    sessionMessages
      .mockResolvedValueOnce(page(cached, 10, true))
      // The latest page shares no row with the cache…
      .mockResolvedValueOnce(page(latest, 30, true))
      // …and the bridge request finds the transcript grown meanwhile.
      .mockResolvedValueOnce(page([row('17', 17)], 31, true))
      .mockResolvedValueOnce(page(fresh, 31, true));

    const { result } = await renderStore();
    act(() => result.current.setActiveSession('session-1'));
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });
    await act(async () => {
      await result.current.refreshLatestFromServer('session-1', { limit: 20 });
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => message.id),
      fresh.map((message) => message.id),
    );
    const slot = result.current.getSessionSlot('session-1');
    assert.equal(slot?.total, 31);
    assert.equal(slot?.hasMore, true);
  });
});
