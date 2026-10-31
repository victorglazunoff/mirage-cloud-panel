import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { HOLD_MS, usePressOrHold } from '@/modules/kabina/hooks/usePressOrHold';
import { applyViewportFrame, computeViewportFrame, useVisualViewportFrame } from '@/modules/kabina/hooks/useVisualViewportFrame';
import { VoiceButton } from '@/modules/kabina/ui/VoiceButton';
import { attachKeyboardScrollGuard, findScrollerToward } from '@/modules/kabina/utils/keyboardScrollGuard';
import { discardPrimedMicrophone, primeMicrophone, takePrimedMicrophone } from '@/modules/kabina/utils/micPrimer';

const trackStop = vi.fn();
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  trackStop.mockClear();
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});

afterEach(() => {
  document.documentElement.removeAttribute('data-kb-keyboard');
  discardPrimedMicrophone();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------ visible area (iOS keyboard)

test('no keyboard: the frame is the whole layout viewport', () => {
  assert.deepEqual(
    computeViewportFrame({ layoutHeight: 844, viewportHeight: 844, viewportTop: 0, scale: 1 }),
    { height: 844, top: 0, keyboard: 0, keyboardOpen: false },
  );
});

test('iOS keyboard: the frame is the visible part, panned down by Safari', () => {
  // Safari keeps innerHeight, shrinks the visual viewport and pans it to the focused field.
  assert.deepEqual(
    computeViewportFrame({ layoutHeight: 844, viewportHeight: 508.4, viewportTop: 336, scale: 1 }),
    { height: 508, top: 336, keyboard: 336, keyboardOpen: true },
  );
});

test('a collapsing toolbar is not a keyboard; pinch zoom keeps the layout viewport', () => {
  assert.equal(computeViewportFrame({ layoutHeight: 844, viewportHeight: 790, viewportTop: 0, scale: 1 }).keyboardOpen, false);
  assert.deepEqual(
    computeViewportFrame({ layoutHeight: 844, viewportHeight: 400, viewportTop: 220, scale: 2.1 }),
    { height: 844, top: 0, keyboard: 0, keyboardOpen: false },
  );
});

test('Android resizes the page itself (interactive-widget): nothing to subtract', () => {
  assert.deepEqual(
    computeViewportFrame({ layoutHeight: 500, viewportHeight: 500, viewportTop: 0, scale: 1 }),
    { height: 500, top: 0, keyboard: 0, keyboardOpen: false },
  );
});

test('the frame lands on <html> as CSS variables and data-kb-keyboard', () => {
  const root = document.createElement('div');
  applyViewportFrame({ height: 508, top: 336, keyboard: 336, keyboardOpen: true }, root);
  assert.equal(root.style.getPropertyValue('--kb-vv-height'), '508px');
  assert.equal(root.style.getPropertyValue('--kb-vv-top'), '336px');
  assert.equal(root.style.getPropertyValue('--kb-keyboard'), '336px');
  assert.equal(root.hasAttribute('data-kb-keyboard'), true);
  applyViewportFrame({ height: 844, top: 0, keyboard: 0, keyboardOpen: false }, root);
  assert.equal(root.hasAttribute('data-kb-keyboard'), false);
});

class FakeVisualViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
  scale = 1;
}

test('the hook follows visualViewport resize and scroll, and cleans up', () => {
  const viewport = new FakeVisualViewport();
  vi.stubGlobal('visualViewport', viewport);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const flush = () => act(() => {
    frames.splice(0).forEach((callback) => callback(0));
  });
  const root = document.documentElement;

  // Safari that keeps its pan whatever the page asks (the frame then follows the pan).
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

  const { unmount } = renderHook(() => useVisualViewportFrame());
  assert.equal(root.style.getPropertyValue('--kb-vv-height'), '844px');
  assert.equal(scrollTo.mock.calls.length, 0, 'no keyboard — the page is left alone');

  // The keyboard opens: Safari shrinks, then pans the visual viewport.
  viewport.height = 508;
  viewport.dispatchEvent(new Event('resize'));
  viewport.offsetTop = 336;
  viewport.dispatchEvent(new Event('scroll'));
  assert.equal(frames.length, 1, 'both events share one frame');
  flush();
  assert.equal(root.style.getPropertyValue('--kb-vv-height'), '508px');
  assert.equal(root.style.getPropertyValue('--kb-vv-top'), '336px');
  assert.equal(root.hasAttribute('data-kb-keyboard'), true);

  viewport.height = 844;
  viewport.offsetTop = 0;
  viewport.dispatchEvent(new Event('resize'));
  flush();
  assert.equal(root.hasAttribute('data-kb-keyboard'), false);

  unmount();
  assert.equal(root.style.getPropertyValue('--kb-vv-height'), '');
});

// ------------------------------------------------------------ swipes with the keyboard up

/** A box with overflow and sizes set by hand (jsdom has no layout). */
function scrollBox(element: HTMLElement, sizes: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  element.style.overflowY = 'auto';
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => sizes.scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => sizes.clientHeight });
  Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => sizes.scrollTop, set: (value: number) => { sizes.scrollTop = value; } });
  return sizes;
}

/** One finger: down at `from`, moved to `to`; returns whether the move was cancelled. */
function swipe(target: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  const touchEvent = (type: string, point: { x: number; y: number }) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: [{ clientX: point.x, clientY: point.y }] });
    return event;
  };
  target.dispatchEvent(touchEvent('touchstart', from));
  const move = touchEvent('touchmove', to);
  target.dispatchEvent(move);
  target.dispatchEvent(new Event('touchend', { bubbles: true }));
  return move.defaultPrevented;
}

function phoneChat() {
  document.body.innerHTML = `
    <div class="frame"><header class="head">Панель «Мираж»</header>
      <div class="feed"><p class="msg">Что осталось:</p><pre class="code">long line</pre></div>
      <textarea aria-label="Сообщение Claude"></textarea></div>`;
  const query = (selector: string) => document.querySelector(selector) as HTMLElement;
  return { head: query('.head'), feed: query('.feed'), msg: query('.msg'), field: query('textarea') };
}

test('findScrollerToward: the feed takes a swipe only while it can move that way', () => {
  const { feed, msg } = phoneChat();
  const sizes = scrollBox(feed, { scrollHeight: 3000, clientHeight: 264, scrollTop: 3000 - 264 });
  // At its last message: the finger going down reveals older ones, going up has nothing left.
  assert.equal(findScrollerToward(msg, 12, document.body), feed);
  assert.equal(findScrollerToward(msg, -12, document.body), null);
  sizes.scrollTop = 0;
  assert.equal(findScrollerToward(msg, 12, document.body), null);
  assert.equal(findScrollerToward(msg, -12, document.body), feed);
  // A box with nothing to scroll or clipped is not a scroller.
  sizes.scrollHeight = 264;
  assert.equal(findScrollerToward(msg, -12, document.body), null);
  sizes.scrollHeight = 3000;
  feed.style.overflowY = 'hidden';
  assert.equal(findScrollerToward(msg, -12, document.body), null);
});

test('the keyboard guard: the feed scrolls, the page never pans', () => {
  const { head, feed, msg, field } = phoneChat();
  const sizes = scrollBox(feed, { scrollHeight: 3000, clientHeight: 264, scrollTop: 1200 });
  const detach = attachKeyboardScrollGuard();

  assert.equal(swipe(msg, { x: 100, y: 300 }, { x: 102, y: 340 }), false, 'mid-history: the native, inertial scroll runs');
  assert.equal(swipe(msg, { x: 100, y: 300 }, { x: 100, y: 260 }), false);
  sizes.scrollTop = 0;
  assert.equal(swipe(msg, { x: 100, y: 300 }, { x: 100, y: 360 }), true, 'pulling down at the top drags nothing');
  sizes.scrollTop = 3000 - 264;
  assert.equal(swipe(msg, { x: 100, y: 300 }, { x: 100, y: 240 }), true, 'pushing up at the end drags nothing');
  assert.equal(swipe(head, { x: 100, y: 30 }, { x: 100, y: 90 }), true, 'the header is not a handle for the page');
  assert.equal(swipe(msg, { x: 100, y: 300 }, { x: 160, y: 304 }), false, 'sideways (a wide code block) passes');
  assert.equal(swipe(field, { x: 100, y: 500 }, { x: 100, y: 540 }), false, 'the field keeps its own gestures');

  detach();
  assert.equal(swipe(head, { x: 100, y: 30 }, { x: 100, y: 90 }), false, 'detached: nothing is cancelled');
});

test('keyboard up: the page pan is taken back and the guard is on only while it is up', () => {
  const viewport = new FakeVisualViewport();
  vi.stubGlobal('visualViewport', viewport);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
  // Safari that honours scrollTo: the pan goes back to the top.
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
    viewport.offsetTop = 0;
  });
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const flush = () => act(() => {
    frames.splice(0).forEach((callback) => callback(0));
  });
  const root = document.documentElement;
  const { head } = phoneChat();

  const { unmount } = renderHook(() => useVisualViewportFrame());
  assert.equal(swipe(head, { x: 100, y: 30 }, { x: 100, y: 90 }), false, 'no keyboard — no guard');

  viewport.height = 508;
  viewport.offsetTop = 336;
  viewport.dispatchEvent(new Event('resize'));
  flush();
  assert.equal(scrollTo.mock.calls.length, 1);
  assert.equal(root.style.getPropertyValue('--kb-vv-top'), '0px', 'the layers sit at the top of the unpanned page');
  assert.equal(root.style.getPropertyValue('--kb-vv-height'), '508px');
  assert.equal(swipe(head, { x: 100, y: 30 }, { x: 100, y: 90 }), true);

  viewport.height = 844;
  viewport.dispatchEvent(new Event('resize'));
  flush();
  assert.equal(swipe(head, { x: 100, y: 30 }, { x: 100, y: 90 }), false, 'keyboard closed — guard off');

  viewport.height = 508;
  viewport.dispatchEvent(new Event('resize'));
  flush();
  unmount();
  assert.equal(swipe(head, { x: 100, y: 30 }, { x: 100, y: 90 }), false, 'unmounted with the keyboard up — guard off');
});

// ------------------------------------------------------------ tap or hold

function PressProbe(props: Parameters<typeof usePressOrHold>[0]) {
  const press = usePressOrHold(props);
  return <button type="button" className="kb-press" {...press}>mic</button>;
}

test('a short tap is a tap: the following click is swallowed, the mic is asked inside pointerdown', () => {
  vi.useFakeTimers();
  const onTap = vi.fn();
  const onHoldStart = vi.fn();
  const onPressStart = vi.fn();
  render(<PressProbe onTap={onTap} onHoldStart={onHoldStart} onHoldEnd={vi.fn()} onPressStart={onPressStart} />);
  const button = screen.getByRole('button', { name: 'mic' });

  fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
  assert.equal(onPressStart.mock.calls.length, 1, 'getUserMedia must run in the gesture itself');
  act(() => { vi.advanceTimersByTime(HOLD_MS - 50); });
  fireEvent.pointerUp(button, { pointerId: 1 });
  fireEvent.click(button);
  assert.equal(onTap.mock.calls.length, 1);
  assert.equal(onHoldStart.mock.calls.length, 0);
});

test('held past the threshold it is push-to-talk: start on hold, end on release, no tap', () => {
  vi.useFakeTimers();
  const onTap = vi.fn();
  const onHoldStart = vi.fn();
  const onHoldEnd = vi.fn();
  render(<PressProbe onTap={onTap} onHoldStart={onHoldStart} onHoldEnd={onHoldEnd} />);
  const button = screen.getByRole('button', { name: 'mic' });

  fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
  act(() => { vi.advanceTimersByTime(HOLD_MS + 10); });
  assert.equal(onHoldStart.mock.calls.length, 1);
  fireEvent.pointerUp(button, { pointerId: 1 });
  fireEvent.click(button);
  assert.equal(onHoldEnd.mock.calls.length, 1);
  assert.equal(onTap.mock.calls.length, 0);
});

test('the system taking the touch away ends a hold without a tap', () => {
  vi.useFakeTimers();
  const onTap = vi.fn();
  const onHoldEnd = vi.fn();
  render(<PressProbe onTap={onTap} onHoldStart={vi.fn()} onHoldEnd={onHoldEnd} />);
  const button = screen.getByRole('button', { name: 'mic' });
  fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
  act(() => { vi.advanceTimersByTime(HOLD_MS + 10); });
  fireEvent.pointerCancel(button, { pointerId: 1 });
  assert.equal(onHoldEnd.mock.calls.length, 1);
  assert.equal(onTap.mock.calls.length, 0);
});

test('keyboard activation (a click without pointer events) is a tap; a long touch has no menu', () => {
  const onTap = vi.fn();
  const onPressStart = vi.fn();
  render(<PressProbe onTap={onTap} onPressStart={onPressStart} />);
  const button = screen.getByRole('button', { name: 'mic' });
  fireEvent.click(button);
  assert.equal(onTap.mock.calls.length, 1);
  assert.equal(onPressStart.mock.calls.length, 1);
  const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  button.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true);
});

test('the phone voice button says «нажми или удерживай», asks for the mic in the press, opens on a tap', () => {
  const onActivate = vi.fn();
  const { container } = render(<VoiceButton onActivate={onActivate} onHoldStart={vi.fn()} onHoldEnd={vi.fn()} isPhone />);
  assert.match(container.querySelector('.kb-voice-hint')?.textContent ?? '', /^нажми или удерживай/);
  const button = screen.getByRole('button', { name: 'Сказать Claude голосом — нажми или удерживай кнопку' });
  assert.ok(button.classList.contains('kb-press'));
  fireEvent.pointerDown(button, { button: 0, pointerId: 3 });
  assert.equal(getUserMedia.mock.calls.length, 1);
  fireEvent.pointerUp(button, { pointerId: 3 });
  assert.equal(onActivate.mock.calls.length, 1);
});

// ------------------------------------------------------------ microphone inside the gesture

test('primeMicrophone asks synchronously, once; the recorder takes that very request', async () => {
  primeMicrophone();
  primeMicrophone();
  assert.equal(getUserMedia.mock.calls.length, 1, 'called in the same tick, and reused');
  const primed = takePrimedMicrophone();
  assert.ok(primed);
  assert.equal(await primed.stream, await getUserMedia.mock.results[0].value);
  assert.equal(takePrimedMicrophone(), null, 'handed over only once');
  assert.equal(trackStop.mock.calls.length, 0, 'the taken stream belongs to the recorder now');
});

test('an unclaimed or discarded microphone is released', async () => {
  vi.useFakeTimers();
  primeMicrophone();
  await act(async () => { vi.advanceTimersByTime(9_000); });
  await vi.waitFor(() => assert.equal(trackStop.mock.calls.length, 1, 'expired'));
  assert.equal(takePrimedMicrophone(), null);

  primeMicrophone();
  discardPrimedMicrophone();
  await vi.waitFor(() => assert.equal(trackStop.mock.calls.length, 2, 'discarded'));
});
