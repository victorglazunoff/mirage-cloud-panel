/** Set on `<html>` while a dialog is open: kabina.css freezes the shell's scrolling (`.kb-shell`). */
export const SCROLL_LOCK_ATTRIBUTE = 'data-kb-scroll-lock';

type LockedState = {
  windowY: number;
  bodyOverflow: string;
  scrollers: Array<[HTMLElement, number]>;
};

let depth = 0;
let locked: LockedState | null = null;

/**
 * Used by the Kabina dialogs (Modal, Sheet, search, voice, the classic settings): the page
 * under an open dialog neither scrolls nor moves. The document itself never scrolls
 * (index.css), the Kabina page is the fixed `.kb-shell` box — it gets `overflow: hidden`
 * (keeps its offset, `scrollbar-gutter: stable` keeps its width, so nothing jumps) instead
 * of the `position: fixed` body trick, which would throw the page to the top on iOS.
 * On release every frozen box and the window go back exactly where they were — an iOS pan
 * to a field inside the dialog does not outlive it. Nested dialogs share one lock.
 * Returns the release function (safe to call twice).
 */
export function lockPageScroll(doc: Document = document): () => void {
  depth += 1;
  if (depth === 1) {
    const view = doc.defaultView;
    locked = {
      windowY: view?.scrollY ?? 0,
      bodyOverflow: doc.body.style.overflow,
      scrollers: Array.from(doc.querySelectorAll<HTMLElement>('.kb-shell')).map((element) => [element, element.scrollTop]),
    };
    doc.documentElement.setAttribute(SCROLL_LOCK_ATTRIBUTE, '');
    doc.body.style.overflow = 'hidden';
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    if (depth > 0 || !locked) return;
    const state = locked;
    locked = null;
    doc.documentElement.removeAttribute(SCROLL_LOCK_ATTRIBUTE);
    doc.body.style.overflow = state.bodyOverflow;
    state.scrollers.forEach(([element, top]) => {
      if (element.isConnected && element.scrollTop !== top) element.scrollTop = top;
    });
    const view = doc.defaultView;
    if (view && view.scrollY !== state.windowY) view.scrollTo(0, state.windowY);
  };
}
