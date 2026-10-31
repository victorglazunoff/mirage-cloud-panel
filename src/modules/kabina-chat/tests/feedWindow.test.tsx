import assert from 'node:assert/strict';
import { createRef } from 'react';

import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import ChatFeed from '@/modules/kabina-chat/ChatFeed';
import { FEED_WINDOW_STEP, useFeedWindow } from '@/modules/kabina-chat/hooks/useFeedWindow';
import type { FeedItem } from '@/modules/kabina-chat/utils/chatFeed';
import { buildChatFeed } from '@/modules/kabina-chat/utils/chatFeed';
import type { ChatMessage } from '@/shared/types';

/**
 * Mirage: the feed of a dialog with history never reads «пусто» — not while
 * the history loads, not when the loaded rows draw nothing, and «раньше в
 * диалоге» reaches older pages on the server.
 */

afterEach(cleanup);

const EMPTY_HINT = 'В этом диалоге пока пусто.';

function renderFeed(props: Partial<Parameters<typeof ChatFeed>[0]> = {}) {
  return render(
    <ChatFeed
      items={[]}
      isPhone={false}
      scrollRef={createRef<HTMLDivElement>()}
      onScroll={() => undefined}
      hasMore={false}
      isLoadingMore={false}
      onLoadEarlier={() => undefined}
      isLoading={false}
      openArtifactId={null}
      onToggleArtifact={() => undefined}
      decision={null}
      emptyHint={EMPTY_HINT}
      isProcessing={false}
      actions={{ retry: () => undefined, resume: () => undefined, switchToSonnet: null }}
      liveAgents={new Map()}
      now={0}
      {...props}
    />,
  );
}

const userItem = (index: number): FeedItem => ({
  kind: 'user',
  key: `u${index}`,
  message: { type: 'user', content: `m${index}`, timestamp: '2026-10-27T10:00:00.000Z' },
  text: `m${index}`,
  time: '10:00',
  steeredAtStep: null,
});

describe('the empty feed', () => {
  it('says «пусто» only for a loaded dialog with no older history', () => {
    renderFeed();
    assert.ok(screen.getByText(EMPTY_HINT));
  });

  it('is a skeleton while the history loads', async () => {
    renderFeed({ isLoading: true });
    assert.equal(screen.queryByText(EMPTY_HINT), null);
    assert.ok(await screen.findByRole('status', { name: 'Лента загружается' }));
  });

  it('is not «пусто» when older history exists (a running turn over a long dialog)', () => {
    renderFeed({ hasMore: true });
    assert.equal(screen.queryByText(EMPTY_HINT), null);
    assert.ok(screen.getByRole('button', { name: 'раньше в диалоге' }));
  });

  it('offers a retry when the history could not be read', () => {
    const onRetry = vi.fn();
    renderFeed({ loadError: true, onRetry });
    assert.equal(screen.queryByText(EMPTY_HINT), null);
    act(() => screen.getByRole('button', { name: 'повторить' }).click());
    assert.equal(onRetry.mock.calls.length, 1);
  });

  it('draws an agent card when no live snapshot came', () => {
    const agent: ChatMessage = {
      type: 'assistant', isToolUse: true, toolName: 'Agent', toolId: 'toolu_a',
      toolInput: JSON.stringify({ description: 'Обзор', prompt: '…' }), timestamp: '2026-10-27T10:00:00.000Z',
    };
    const feed = buildChatFeed([{ type: 'user', content: 'go', timestamp: '2026-10-27T10:00:00.000Z' }, agent], 0);
    renderFeed({ items: feed.items, isProcessing: true });
    assert.ok(screen.getByText('go'));
    assert.ok(screen.getAllByText(/Обзор/).length > 0);
  });
});

describe('useFeedWindow', () => {
  const base = {
    sessionId: 's1',
    hasMoreOnServer: true,
    isHistoryReady: true,
    isLoadingMore: false,
  };

  it('fetches an older page once every loaded row is on screen', () => {
    const loadOlderPage = vi.fn(async () => true);
    const items = [userItem(1), userItem(2)];
    const { result } = renderHook(() => useFeedWindow({ ...base, items, loadOlderPage }));
    assert.equal(result.current.hasEarlier, true);
    act(() => result.current.loadEarlier());
    assert.equal(loadOlderPage.mock.calls.length, 1);
  });

  it('shows hidden rows before going to the server', () => {
    const loadOlderPage = vi.fn(async () => true);
    const items = Array.from({ length: FEED_WINDOW_STEP + 5 }, (_, index) => userItem(index));
    const { result } = renderHook(() => useFeedWindow({ ...base, hasMoreOnServer: false, items, loadOlderPage }));
    assert.equal(result.current.visibleItems.length, FEED_WINDOW_STEP);
    assert.equal(result.current.hasEarlier, true);
    act(() => result.current.loadEarlier());
    assert.equal(result.current.visibleItems.length, FEED_WINDOW_STEP + 5);
    assert.equal(loadOlderPage.mock.calls.length, 0);
  });

  it('pulls older pages by itself while the loaded rows draw nothing', () => {
    const loadOlderPage = vi.fn(async () => true);
    renderHook(() => useFeedWindow({ ...base, items: [], loadOlderPage }));
    assert.equal(loadOlderPage.mock.calls.length, 1);
  });

  it('waits for the history before pulling anything', () => {
    const loadOlderPage = vi.fn(async () => true);
    renderHook(() => useFeedWindow({ ...base, isHistoryReady: false, items: [], loadOlderPage }));
    assert.equal(loadOlderPage.mock.calls.length, 0);
  });
});
