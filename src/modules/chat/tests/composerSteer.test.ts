import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import { resetUserPreferences } from '@/shared/userSettings';
import type { ChatMessage, LLMProvider, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * Mirage Х1: while a Claude turn runs, Send steers the message into it. Every
 * steer carries its own steerId and is settled only by the answer naming it; a
 * steer that cannot go in (refused, unanswered, or never sent because the
 * socket is down) falls back to the queue, or — when the turn is already over —
 * is sent as an ordinary message. Nothing typed is lost.
 */

type StoredQueued = { content: string; options?: Record<string, unknown>; attachments: unknown[] };

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

let queued: Map<string, StoredQueued>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

// The queued-message endpoints, as the server implements them (append + clear).
const fakeServer = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = String(url);
  const method = init?.method ?? 'GET';
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
  const scope = String(body.scope ?? '');
  if (path.endsWith('/api/user/drafts/queued-message')) {
    if (method === 'POST') {
      const message = body.queuedMessage as StoredQueued;
      const waiting = queued.get(scope);
      const next = waiting
        ? { content: `${waiting.content}\n\n${message.content}`, options: message.options, attachments: [...waiting.attachments, ...(message.attachments ?? [])] }
        : { content: message.content, options: message.options, attachments: message.attachments ?? [] };
      queued.set(scope, next);
      return json({ success: true, queuedMessage: next, appended: Boolean(waiting) });
    }
    if (method === 'DELETE') {
      queued.delete(scope);
      return json({ success: true });
    }
  }
  if (path.endsWith('/api/user/drafts') && method === 'GET') {
    return json({
      success: true,
      drafts: [...queued].map(([scope, queuedMessage]) => ({ scope, text: '', queuedMessage })),
    });
  }
  return json({ success: true });
};

type Props = {
  isLoading: boolean;
  provider: LLMProvider;
  processingSessions?: SessionActivityMap;
  socketOpen: boolean;
};

const running: SessionActivityMap = new Map([['session-1', { statusText: null, canInterrupt: true, startedAt: 1 }]]);

const render = (initialProps: Partial<Props> = {}) => {
  const sent: Array<Record<string, unknown>> = [];
  const added: ChatMessage[] = [];
  const view = renderHook(
    ({ isLoading, provider, processingSessions, socketOpen }: Props) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id ?? null,
      provider,
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading,
      processingSessions,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: (message) => {
        if (!socketOpen) {
          return false;
        }
        sent.push(message as Record<string, unknown>);
        return true;
      },
      scrollToBottom: () => undefined,
      addMessage: (message) => { added.push(message); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    {
      initialProps: {
        isLoading: true,
        provider: 'claude' as LLMProvider,
        processingSessions: running,
        socketOpen: true,
        ...initialProps,
      },
    },
  );
  const steers = () => sent.filter((message) => message.type === 'chat.steer');
  const sends = () => sent.filter((message) => message.type === 'chat.send');
  const userBubbles = () => added.filter((message) => message.type === 'user');
  return { view, steers, sends, userBubbles };
};

type View = ReturnType<typeof render>['view'];

const submit = async (view: View, text: string) => {
  await act(async () => {
    view.result.current.setInput(text);
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

beforeEach(() => {
  queued = new Map();
  resetChatDrafts();
  resetUserPreferences();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(fakeServer));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetChatDrafts();
  resetUserPreferences();
  localStorage.clear();
});

test('"Now" steers into the running turn with its own steerId, and the composer empties', async () => {
  const { view, steers } = render();
  await submit(view, 'also check the tests');

  assert.equal(steers().length, 1);
  assert.equal(steers()[0].content, 'also check the tests');
  assert.equal(typeof steers()[0].steerId, 'string');
  assert.ok(String(steers()[0].steerId).length > 0);
  assert.equal(view.result.current.input, '');
  assert.equal(queued.size, 0, 'nothing queued while the steer is pending');
});

test('the answer naming the steerId shows one "steered" bubble, and a replay of it adds nothing', async () => {
  const { view, steers, userBubbles } = render();
  await submit(view, 'one more thing');
  const steerId = String(steers()[0].steerId);

  act(() => {
    view.result.current.handleSteered({ sessionId: 'session-1', content: 'one more thing', steerId });
  });
  act(() => {
    view.result.current.handleSteered({ sessionId: 'session-1', content: 'one more thing', steerId });
  });

  assert.equal(userBubbles().length, 1);
  assert.equal(userBubbles()[0].steered, true);
});

test('a refusal naming one steer queues only that one; the other is still answered', async () => {
  const { view, steers, userBubbles } = render();
  await submit(view, 'first');
  await submit(view, 'second');
  const [first, second] = steers().map((message) => String(message.steerId));

  await act(async () => {
    view.result.current.handleSteerUnavailable('session-1', second);
  });
  await waitFor(() => assert.equal(queued.get('session-1')?.content, 'second'));

  act(() => {
    view.result.current.handleSteered({ sessionId: 'session-1', content: 'first', steerId: first });
  });
  assert.equal(userBubbles().length, 1);
  assert.equal(userBubbles()[0].content, 'first');
  assert.equal(queued.get('session-1')?.content, 'second', 'the steered message is not queued as well');
});

test('with the socket down the steer goes straight to the queue', async () => {
  const { view, steers } = render({ socketOpen: false });
  await submit(view, 'do not lose me');

  assert.equal(steers().length, 0);
  await waitFor(() => assert.equal(queued.get('session-1')?.content, 'do not lose me'));
  assert.ok(view.result.current.steerNotice);
});

test('a steer nobody answers is queued for after the turn', async () => {
  const { view } = render();
  // Only timeouts are faked: the acknowledgement deadline is one.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await submit(view, 'are you there');
  assert.equal(queued.size, 0);

  await act(async () => {
    vi.advanceTimersByTime(8_100);
  });
  vi.useRealTimers();

  await waitFor(() => assert.equal(queued.get('session-1')?.content, 'are you there'));
});

test('a refusal after the turn ended sends the message as an ordinary one at once', async () => {
  const { view, steers, sends } = render();
  await submit(view, 'late but fine');
  const steerId = String(steers()[0].steerId);

  view.rerender({ isLoading: false, provider: 'claude', processingSessions: new Map(), socketOpen: true });
  await act(async () => {
    view.result.current.handleSteerUnavailable('session-1', steerId);
  });

  await waitFor(() => assert.equal(sends().length, 1));
  assert.equal(sends()[0].content, 'late but fine');
  assert.equal(queued.size, 0, 'not queued when it can be sent now');
});

test('an answer without a steerId (older server) still settles the steer by its text', async () => {
  const { view, userBubbles } = render();
  await submit(view, 'legacy');

  act(() => {
    view.result.current.handleSteered({ sessionId: 'session-1', content: 'legacy' });
  });
  assert.equal(userBubbles().length, 1);
});

test('providers other than Claude keep the queue even in "Now"', async () => {
  const { view, steers } = render({ provider: 'codex' });
  await submit(view, 'for codex');

  assert.equal(steers().length, 0);
  await waitFor(() => assert.equal(queued.get('session-1')?.content, 'for codex'));
});

test('"After turn" is remembered as a UI preference', async () => {
  const { view } = render();
  act(() => {
    view.result.current.setSteerMode('after');
  });
  assert.equal(readStoredUiPreferences().steerAfterTurn, true);

  const next = render();
  assert.equal(next.view.result.current.steerMode, 'after');
});

test('a queued message the dispatcher sends shows in the transcript as soon as the turn ends', async () => {
  const { view, userBubbles } = render();
  act(() => {
    view.result.current.setSteerMode('after');
  });
  await submit(view, 'after the turn');
  await waitFor(() => assert.ok(view.result.current.queuedDraft));

  // The turn ends and the server's dispatcher takes the message off the queue.
  queued.delete('session-1');
  view.rerender({ isLoading: false, provider: 'claude', processingSessions: new Map(), socketOpen: true });

  await waitFor(() => assert.equal(view.result.current.queuedDraft, null), { timeout: 3_000 });
  assert.equal(userBubbles().length, 1);
  assert.equal(userBubbles()[0].content, 'after the turn');
});
