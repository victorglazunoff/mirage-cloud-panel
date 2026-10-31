const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

/** A field being typed in keeps every native gesture: caret drag, text selection, its own scroll. */
function isEditable(element: Element) {
  return element.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/**
 * The scroll box between `target` and `boundary` (exclusive) that can still move its
 * content the way a finger moving by `fingerDeltaY` pushes it: a finger going down
 * (`> 0`) reveals what is above, so the box must not be at its top, and vice versa.
 * `null` — nothing under the finger can scroll that way, the gesture would only pan the page.
 */
export function findScrollerToward(target: Element | null, fingerDeltaY: number, boundary: Element | null): Element | null {
  for (let node = target; node && node !== boundary; node = node.parentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if (!SCROLLABLE_OVERFLOW.has(overflowY)) continue;
    const range = node.scrollHeight - node.clientHeight;
    if (range <= 1) continue;
    if (fingerDeltaY > 0 ? node.scrollTop > 0 : node.scrollTop < range - 1) return node;
  }
  return null;
}

/**
 * Used by useVisualViewportFrame while an on-screen keyboard is up (attached when it opens,
 * removed when it closes, so the rest of the time no listener holds up touch scrolling).
 * iOS then lets a vertical swipe pan the whole page by the keyboard's height; the layers
 * follow the visible area, so the swipe looks like it did nothing, and a swipe started where
 * nothing can scroll (or at the end of the feed) drags the page and the composer with it.
 * A vertical touch move is let through only when a scroll box under the finger can still
 * move that way (the feed scrolls natively, with inertia); otherwise it is cancelled.
 * Pinch, sideways swipes and touches on a field pass untouched. Returns the detach function.
 */
export function attachKeyboardScrollGuard(doc: Document = document): () => void {
  let last: { x: number; y: number } | null = null;

  const onTouchStart = (event: TouchEvent) => {
    last = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1 || last === null) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - last.x;
    const deltaY = touch.clientY - last.y;
    last = { x: touch.clientX, y: touch.clientY };
    // A sideways swipe (a wide code block, a chip row) is never the page pan.
    if (Math.abs(deltaY) <= Math.abs(deltaX) || !event.cancelable) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && isEditable(target)) return;
    if (findScrollerToward(target, deltaY, doc.body)) return;
    event.preventDefault();
  };
  const onTouchEnd = () => {
    last = null;
  };

  doc.addEventListener('touchstart', onTouchStart, { passive: true });
  // Not passive: cancelling is the point.
  doc.addEventListener('touchmove', onTouchMove, { passive: false });
  doc.addEventListener('touchend', onTouchEnd, { passive: true });
  doc.addEventListener('touchcancel', onTouchEnd, { passive: true });
  return () => {
    doc.removeEventListener('touchstart', onTouchStart);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('touchend', onTouchEnd);
    doc.removeEventListener('touchcancel', onTouchEnd);
  };
}
