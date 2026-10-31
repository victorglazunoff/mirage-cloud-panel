import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useFeedFollowsKeyboard } from '@/modules/kabina-chat/hooks/useFeedFollowsKeyboard';

let resize: (() => void) | null = null;

class FakeResizeObserver {
  constructor(callback: () => void) {
    resize = callback;
  }
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resize = null;
});

/** A feed box whose sizes the test sets by hand (jsdom has no layout). */
function sizeFeed(element: HTMLElement, sizes: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => sizes.scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => sizes.clientHeight });
  let top = sizes.scrollTop;
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.min(value, sizes.scrollHeight - sizes.clientHeight);
    },
  });
  return sizes;
}

function PhoneChatProbe({ onFeed }: { onFeed: (element: HTMLDivElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFeedFollowsKeyboard(ref, true);
  return (
    <>
      <div ref={(element) => {
        (ref as { current: HTMLDivElement | null }).current = element;
        if (element) onFeed(element);
      }}
      />
      <div className="kbc-pcomposer"><textarea aria-label="Сообщение" /></div>
    </>
  );
}

function mount(sizes: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  let feed: HTMLDivElement | null = null;
  let measured: typeof sizes | null = null;
  const utils = render(<PhoneChatProbe onFeed={(element) => {
    if (feed) return;
    feed = element;
    measured = sizeFeed(element, sizes);
  }}
  />);
  return { ...utils, feed: feed as unknown as HTMLDivElement, sizes: measured as unknown as typeof sizes };
}

test('the keyboard shrinks the feed: a feed at its last message stays at its last message', () => {
  // 600px feed of 3000px, scrolled to the end; the keyboard takes 336px.
  const { feed, sizes } = mount({ scrollHeight: 3000, clientHeight: 600, scrollTop: 2400 });
  sizes.clientHeight = 264;
  act(() => resize?.());
  assert.equal(feed.scrollTop, 3000 - 264, 'the last message sits right above the composer');
});

test('a clipped frame shifted by iOS revealing the composer is put back at the top', () => {
  const { feed, sizes } = mount({ scrollHeight: 3000, clientHeight: 600, scrollTop: 2400 });
  // The phone chat frame: overflow hidden, never scrolled on purpose — iOS nudged it by 80px.
  const frame = feed.parentElement as HTMLElement;
  frame.style.overflowY = 'hidden';
  let frameTop = 80;
  Object.defineProperty(frame, 'scrollTop', { configurable: true, get: () => frameTop, set: (value: number) => { frameTop = value; } });
  sizes.clientHeight = 264;
  act(() => resize?.());
  assert.equal(frameTop, 0);
  assert.equal(feed.scrollTop, 3000 - 264, 'and the feed still keeps its last message');
});

test('reading back in history: the keyboard does not yank the feed', () => {
  const { feed, sizes } = mount({ scrollHeight: 3000, clientHeight: 600, scrollTop: 400 });
  sizes.clientHeight = 264;
  act(() => resize?.());
  assert.equal(feed.scrollTop, 400);
});

test('focusing the composer near the end shows the latest message, before and after the keyboard', () => {
  const { feed, sizes, getByLabelText } = mount({ scrollHeight: 3000, clientHeight: 600, scrollTop: 2000 });
  act(() => {
    getByLabelText('Сообщение').focus();
  });
  assert.equal(feed.scrollTop, 2400);
  // The keyboard animates in a moment later and shrinks the box.
  sizes.clientHeight = 264;
  act(() => resize?.());
  assert.equal(feed.scrollTop, 3000 - 264);
});
