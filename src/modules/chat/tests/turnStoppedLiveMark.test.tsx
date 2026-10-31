import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * Mirage: Stop puts a "stopped" mark in the transcript at once, and the mark
 * the CLI records for the same stop replaces it on the next history load —
 * one stop, one mark.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const row = (id: string, fields: Partial<NormalizedMessage>): NormalizedMessage => ({
  id,
  provider: 'claude',
  sessionId: 'session-1',
  timestamp: `2026-01-01T00:00:0${id}.000Z`,
  ...fields,
} as NormalizedMessage);

const PROMPT = row('1', { kind: 'text', role: 'user', content: 'run four commands' });
const TOOL = row('2', { kind: 'tool_use', toolName: 'Bash', toolId: 'toolu_1' });
const SERVER_STOP = row('3', { kind: 'turn_stopped' });
const NEXT_PROMPT = row('5', { kind: 'text', role: 'user', content: 'say OK' });

const respondWith = (messages: NormalizedMessage[]) => sessionMessages.mockResolvedValueOnce({
  ok: true,
  json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
});

beforeEach(() => {
  sessionMessages.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

const stopMarks = (messages: NormalizedMessage[]) => messages.filter((message) => message.kind === 'turn_stopped');

describe('the live "stopped" mark', () => {
  it('gives way to the mark history recorded for the same turn', async () => {
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { result } = renderHook(() => useSessionStore());
    respondWith([PROMPT, TOOL]);
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    act(() => {
      // The client's clock reads a little after the server's.
      result.current.appendRealtime('session-1', row('4', { id: 'turn_stopped_live', kind: 'turn_stopped' }));
    });
    assert.equal(stopMarks(result.current.getMessages('session-1')).length, 1);

    respondWith([PROMPT, TOOL, SERVER_STOP, NEXT_PROMPT]);
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    const marks = stopMarks(result.current.getMessages('session-1'));
    assert.equal(marks.length, 1);
    assert.equal(marks[0].id, '3');
  });

  it('stays while history has no mark for that turn yet', async () => {
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { result } = renderHook(() => useSessionStore());
    respondWith([PROMPT, TOOL]);
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });
    act(() => {
      result.current.appendRealtime('session-1', row('4', { id: 'turn_stopped_live', kind: 'turn_stopped' }));
    });

    respondWith([PROMPT, TOOL]);
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    assert.deepEqual(stopMarks(result.current.getMessages('session-1')).map((mark) => mark.id), ['turn_stopped_live']);
  });

  it('is never shown twice next to the recorded one', async () => {
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const { result } = renderHook(() => useSessionStore());
    respondWith([PROMPT, TOOL, SERVER_STOP]);
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });
    act(() => {
      result.current.appendRealtime('session-1', row('4', { id: 'turn_stopped_live', kind: 'turn_stopped' }));
    });

    assert.equal(stopMarks(result.current.getMessages('session-1')).length, 1);
  });
});
