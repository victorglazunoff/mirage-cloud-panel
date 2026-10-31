import { useEffect } from 'react';

import { attachKeyboardScrollGuard } from '@/modules/kabina/utils/keyboardScrollGuard';

/** The visible part of the page the Kabina layers are pinned to. */
export type ViewportFrame = {
  /** Height of the visible area, px (shrinks when the on-screen keyboard opens). */
  height: number;
  /** How far iOS has panned the visible area down the page, px. */
  top: number;
  /** Height the on-screen keyboard takes from the page, px (0 when closed). */
  keyboard: number;
  keyboardOpen: boolean;
};

/** Below this the difference is a collapsing toolbar, not a keyboard. */
const KEYBOARD_MIN_PX = 120;

/**
 * Where the visible area is. iOS Safari ignores `interactive-widget=resizes-content`:
 * an open keyboard only shrinks the visual viewport and pans it down the unchanged
 * layout viewport, so `position: fixed; inset: 0` keeps a full-height box whose bottom
 * (the chat composer) hides under the keyboard and whose rest shows as a black gap.
 * Pinned to these numbers, the layers always fill exactly what is visible.
 * Pinch zoom (scale ≠ 1) is not a keyboard: the layers keep the layout viewport.
 */
export function computeViewportFrame(input: {
  layoutHeight: number;
  viewportHeight: number;
  viewportTop: number;
  scale: number;
}): ViewportFrame {
  const { layoutHeight, viewportHeight, viewportTop, scale } = input;
  if (!(viewportHeight > 0) || Math.abs(scale - 1) > 0.01) {
    return { height: layoutHeight, top: 0, keyboard: 0, keyboardOpen: false };
  }
  const keyboard = Math.max(0, Math.round(layoutHeight - viewportHeight));
  return {
    height: Math.round(viewportHeight),
    top: Math.max(0, Math.round(viewportTop)),
    keyboard,
    keyboardOpen: keyboard >= KEYBOARD_MIN_PX,
  };
}

/** Writes the frame to `<html>`: `--kb-vv-height`, `--kb-vv-top`, `--kb-keyboard`, `data-kb-keyboard`. */
export function applyViewportFrame(frame: ViewportFrame, root: HTMLElement = document.documentElement) {
  root.style.setProperty('--kb-vv-height', `${frame.height}px`);
  root.style.setProperty('--kb-vv-top', `${frame.top}px`);
  root.style.setProperty('--kb-keyboard', `${frame.keyboard}px`);
  if (frame.keyboardOpen) root.setAttribute('data-kb-keyboard', '');
  else root.removeAttribute('data-kb-keyboard');
}

function revealFocusedField(frame: ViewportFrame) {
  const field = document.activeElement as HTMLElement | null;
  if (!field || !field.matches('input, textarea, [contenteditable="true"]')) return;
  window.requestAnimationFrame(() => {
    const rect = field.getBoundingClientRect();
    if (rect.bottom > frame.top + frame.height || rect.top < frame.top) field.scrollIntoView({ block: 'nearest' });
  });
}

/**
 * Used by KabinaShell: keeps the CSS variables of the visible area current on every
 * visual-viewport resize and scroll (keyboard, toolbar, rotation), batched per frame.
 * While the keyboard is up the page is kept unpanned and only scroll boxes take swipes
 * (attachKeyboardScrollGuard): the chat feed scrolls under the finger as without it.
 */
export function useVisualViewportFrame() {
  useEffect(() => {
    const viewport = window.visualViewport;
    let frameRequest: number | null = null;

    let wasKeyboardOpen = false;
    let detachScrollGuard: (() => void) | null = null;
    const readFrame = () => computeViewportFrame({
      layoutHeight: window.innerHeight,
      viewportHeight: viewport?.height ?? window.innerHeight,
      viewportTop: viewport?.offsetTop ?? 0,
      scale: viewport?.scale ?? 1,
    });
    const update = () => {
      frameRequest = null;
      let frame = readFrame();
      if (frame.keyboardOpen && (frame.top > 0 || window.scrollY > 0)) {
        // iOS panned the page down to show the field. Take the pan back: the layers already
        // end above the keys, and a fixed layer on a panned page is where iOS loses the
        // feed's own touch scrolling — swipes go to the page instead. Ignored → stay panned.
        window.scrollTo(0, 0);
        frame = readFrame();
      }
      applyViewportFrame(frame);
      if (frame.keyboardOpen && !detachScrollGuard) detachScrollGuard = attachKeyboardScrollGuard();
      if (!frame.keyboardOpen && detachScrollGuard) {
        detachScrollGuard();
        detachScrollGuard = null;
      }
      // The keyboard just came up: the layers shrank, so a field low on a scrolling page may
      // now sit below the visible area — bring it back (only if it is actually hidden).
      if (frame.keyboardOpen && !wasKeyboardOpen) revealFocusedField(frame);
      wasKeyboardOpen = frame.keyboardOpen;
    };
    const schedule = () => {
      if (frameRequest === null) frameRequest = window.requestAnimationFrame(update);
    };

    update();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    return () => {
      if (frameRequest !== null) window.cancelAnimationFrame(frameRequest);
      detachScrollGuard?.();
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      const root = document.documentElement;
      ['--kb-vv-height', '--kb-vv-top', '--kb-keyboard'].forEach((name) => root.style.removeProperty(name));
      root.removeAttribute('data-kb-keyboard');
    };
  }, []);
}

