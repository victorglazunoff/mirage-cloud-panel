import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { BackgroundTaskSummary, NormalizedMessage, ProjectSession, ServerEvent, TurnDispatchedAck } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * Mirage: the realtime side of three fixes.
 * - A queued message the server sends opens its turn with `turn_dispatched`:
 *   the tab marks the session busy and hands the message to the composer.
 * - A turn that ends aborted gets a "stopped" mark in the transcript at once.
 * - A foreground command the SDK reports as a task is not background work, so
 *   the turn's end leaves the session idle instead of "background work".
 */

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const stored: NormalizedMessage[] = [];
  const processing: string[] = [];
  const idle: string[] = [];
  const background: Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> = [];
  const dispatched: Array<{ ack: TurnDispatchedAck; seq?: number }> = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing: (sessionId) => { if (sessionId) processing.push(sessionId); },
    onSessionIdle: (sessionId) => { if (sessionId) idle.push(sessionId); },
    onSessionBackground: (sessionId, tasks) => { background.push({ sessionId, tasks }); },
    getSessionActivity: () => undefined,
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: (_sessionId: string, msg: NormalizedMessage) => { stored.push(msg); },
      getMessages: () => stored,
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
    onTurnDispatched: (ack, seq) => { dispatched.push({ ack, seq }); },
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { dispatch, stored, processing, idle, background, dispatched };
};

const event = (fields: Record<string, unknown>): ServerEvent => ({
  id: `event-${Math.random()}`,
  sessionId: 'viewed-session',
  provider: 'claude',
  timestamp: '2026-10-26T05:52:14.000Z',
  ...fields,
} as unknown as ServerEvent);

test('a turn the server started for a queued message shows as this tab\'s own', () => {
  const { dispatch, processing, dispatched, stored } = renderHandlers();

  dispatch(event({
    kind: 'turn_dispatched',
    seq: 12,
    role: 'user',
    content: 'скажи ПОСЛЕ',
    at: '2026-10-26T05:52:14.339Z',
    origin: 'queue',
  }));

  assert.deepEqual(processing, ['viewed-session']);
  assert.deepEqual(dispatched, [{
    ack: { sessionId: 'viewed-session', content: 'скажи ПОСЛЕ', at: '2026-10-26T05:52:14.339Z', origin: 'queue', attachments: undefined },
    seq: 12,
  }]);
  // The composer shows the message; the frame itself is not a transcript row.
  assert.equal(stored.length, 0);
});

test('a turn that ends aborted gets a "stopped" mark at once', () => {
  const { dispatch, stored, idle } = renderHandlers();

  dispatch(event({ kind: 'complete', aborted: true, exitCode: 0 }));

  assert.deepEqual(idle, ['viewed-session']);
  assert.deepEqual(stored.map((message) => message.kind), ['turn_stopped']);
});

test('a turn that ends normally gets no mark', () => {
  const { dispatch, stored } = renderHandlers();
  dispatch(event({ kind: 'complete', success: true, exitCode: 0 }));
  assert.equal(stored.some((message) => message.kind === 'turn_stopped'), false);
});

test('a foreground command reported as a task is not left behind as background work', () => {
  const { dispatch, background } = renderHandlers();

  dispatch(event({ kind: 'tool_use', toolId: 'toolu_sleep', toolName: 'Bash', toolInput: { command: 'sleep 5', description: 'Pause 5 seconds (command 1 of 4)' } }));
  dispatch(event({ kind: 'task_status', event: 'started', taskId: 'b1', toolUseId: 'toolu_sleep', taskType: 'local_bash', description: 'Pause 5 seconds (command 1 of 4)', backgrounded: false }));
  dispatch(event({ kind: 'tool_result', toolId: 'toolu_sleep', content: '' }));
  dispatch(event({ kind: 'complete', success: true, exitCode: 0 }));

  assert.deepEqual(background, [{ sessionId: 'viewed-session', tasks: [] }]);
});
