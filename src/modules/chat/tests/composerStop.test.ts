import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { resetUserPreferences } from '@/shared/userSettings';
import type { LLMProvider, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * Mirage: «Стоп» is never silent. A turn that cannot be stopped from here says
 * why; a stop that hears nothing back is sent once more and then reported.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

type Props = { canAbortSession: boolean; processingSessions: SessionActivityMap; socketOpen: boolean };

const running = (overrides: Record<string, unknown> = {}): SessionActivityMap =>
  new Map([['session-1', { statusText: null, canInterrupt: true, startedAt: 1, ...overrides }]]);

const render = (initialProps: Partial<Props> = {}) => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderHook(
    ({ canAbortSession, processingSessions, socketOpen }: Props) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id ?? null,
      provider: 'claude' as LLMProvider,
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: true,
      processingSessions,
      canAbortSession,
      tokenBudget: null,
      sendMessage: (message) => {
        if (!socketOpen) return false;
        sent.push(message as Record<string, unknown>);
        return true;
      },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { canAbortSession: true, processingSessions: running(), socketOpen: true, ...initialProps } },
  );
  const aborts = () => sent.filter((message) => message.type === 'chat.abort');
  return { view, aborts };
};

beforeEach(() => {
  resetChatDrafts();
  resetUserPreferences();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, drafts: [] }))));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a turn in a terminal the panel does not own: «Стоп» is inactive and says why', () => {
  const { view, aborts } = render({
    canAbortSession: false,
    processingSessions: running({ canInterrupt: false, statusText: 'Running in the Claude CLI' }),
  });

  assert.match(view.result.current.stopUnavailableReason?.text ?? '', /терминале/);
  act(() => { view.result.current.handleAbortSession(); });
  assert.equal(aborts().length, 0);
  assert.match(view.result.current.steerNotice ?? '', /терминале/, 'a press is answered, never ignored');
});

test('a stoppable turn has no reason to show', () => {
  const { view } = render();
  assert.equal(view.result.current.stopUnavailableReason, null);
});

test('a stop that hears nothing is sent once more, then reported', () => {
  vi.useFakeTimers();
  const { view, aborts } = render();

  act(() => { view.result.current.handleAbortSession(); });
  assert.deepEqual(aborts(), [{ type: 'chat.abort', sessionId: 'session-1' }]);

  act(() => { vi.advanceTimersByTime(8_000); });
  assert.equal(aborts().length, 2, 'sent again');
  assert.equal(view.result.current.steerNotice, null);

  act(() => { vi.advanceTimersByTime(8_000); });
  assert.equal(aborts().length, 2);
  assert.match(view.result.current.steerNotice ?? '', /Не удалось остановить ход/);
});

test('a stop the turn answered is not repeated', () => {
  vi.useFakeTimers();
  const { view, aborts } = render();

  act(() => { view.result.current.handleAbortSession(); });
  view.rerender({ canAbortSession: false, processingSessions: new Map(), socketOpen: true });
  act(() => { vi.advanceTimersByTime(20_000); });

  assert.equal(aborts().length, 1);
  assert.equal(view.result.current.steerNotice, null);
});

test('a stop with the socket down says it did not go out', () => {
  const { view, aborts } = render({ socketOpen: false });

  act(() => { view.result.current.handleAbortSession(); });
  assert.equal(aborts().length, 0);
  assert.match(view.result.current.steerNotice ?? '', /Нет связи/);
});
