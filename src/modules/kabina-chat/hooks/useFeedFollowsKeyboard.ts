import { useEffect } from 'react';
import type { RefObject } from 'react';

/** «At the bottom» tolerance: the last message is in view. */
const STICK_PX = 64;
/** A focus counts as «keyboard about to open» for this long. */
const FOCUS_WINDOW_MS = 1_200;

function distanceToBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

/**
 * The feed's `overflow: hidden` frames (the phone chat, the app shell) never scroll on
 * purpose, but iOS revealing the focused composer can shift them; shifted, they move the
 * feed away from where iOS routes its touches. Put them back at the top.
 */
function unscrollClippedAncestors(element: HTMLElement) {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    if (node.scrollTop === 0) continue;
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === 'hidden' || overflowY === 'clip') node.scrollTop = 0;
  }
}

/**
 * Used by the phone chat (DarkPhoneChat): the feed behaves like a messenger's when the
 * on-screen keyboard opens. The feed box shrinks by the keyboard's height; a feed that
 * was showing its last message keeps showing it instead of the keys covering it, and
 * focusing the composer near the end brings the last message into view.
 */
export function useFeedFollowsKeyboard(scrollRef: RefObject<HTMLElement>, enabled: boolean) {
  useEffect(() => {
    const element = scrollRef.current;
    if (!enabled || !element) return undefined;

    let wasAtBottom = distanceToBottom(element) <= STICK_PX;
    let lastHeight = element.clientHeight;
    let focusUntil = 0;
    const toBottom = () => {
      element.scrollTop = element.scrollHeight;
      wasAtBottom = true;
    };

    const handleScroll = () => {
      wasAtBottom = distanceToBottom(element) <= STICK_PX;
    };
    const handleResize = () => {
      unscrollClippedAncestors(element);
      const height = element.clientHeight;
      const shrank = height < lastHeight;
      lastHeight = height;
      if (!shrank) return;
      // Shrinking does not move scrollTop, so the bottom slid under the composer.
      if (wasAtBottom || performance.now() < focusUntil) toBottom();
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.tagName !== 'TEXTAREA' || !target.closest('.kbc-pcomposer')) return;
      // Reading far back in history: stay there. Near the end: show the latest message.
      if (distanceToBottom(element) > element.clientHeight) return;
      focusUntil = performance.now() + FOCUS_WINDOW_MS;
      toBottom();
    };

    element.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('focusin', handleFocusIn);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleResize);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', handleScroll);
      document.removeEventListener('focusin', handleFocusIn);
      observer?.disconnect();
    };
  }, [enabled, scrollRef]);
}
