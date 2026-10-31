import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/** Press longer than this is a hold (push-to-talk), shorter is a tap. */
export const HOLD_MS = 300;

type PressOrHoldOptions = {
  /** A short tap (or Enter/Space on the focused button). */
  onTap: () => void;
  /** The finger stayed down HOLD_MS: start push-to-talk. Without it every press is a tap. */
  onHoldStart?: () => void;
  /** The held finger is lifted (or the system took the touch away). */
  onHoldEnd?: () => void;
  /** Synchronously inside pointerdown — the place iOS lets a page open the microphone. */
  onPressStart?: () => void;
  disabled?: boolean;
};

/**
 * Used by VoiceButton and the phone composer microphone: one button that is a toggle
 * on a short tap and push-to-talk while held. Works on pointer events with pointer
 * capture, so a finger sliding off the button does not end the hold, and a tap is
 * decided on pointerup instead of waiting for iOS's delayed click. The click that
 * follows a pointer press is swallowed; a click without one (keyboard) is a tap.
 * Pair with the `.kb-press` class: no touch scrolling, no callout, no text selection.
 */
export function usePressOrHold({ onTap, onHoldStart, onHoldEnd, onPressStart, disabled = false }: PressOrHoldOptions) {
  const timerRef = useRef<number | null>(null);
  const holdingRef = useRef(false);
  const pressedRef = useRef(false);
  const swallowClickRef = useRef(false);
  const callbacksRef = useRef({ onTap, onHoldStart, onHoldEnd, onPressStart });
  callbacksRef.current = { onTap, onHoldStart, onHoldEnd, onPressStart };

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => {
    clearTimer();
    if (holdingRef.current) {
      holdingRef.current = false;
      callbacksRef.current.onHoldEnd?.();
    }
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // Only the primary button (touch and pen report 0); jsdom's synthetic pointers report none.
    if (disabled || event.button > 0 || pressedRef.current) return;
    pressedRef.current = true;
    swallowClickRef.current = true;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is a nicety: without it pointerup still reaches the button in place.
    }
    callbacksRef.current.onPressStart?.();
    if (!callbacksRef.current.onHoldStart) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      holdingRef.current = true;
      callbacksRef.current.onHoldStart?.();
    }, HOLD_MS);
  }, [disabled]);

  const onPointerUp = useCallback(() => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    clearTimer();
    if (holdingRef.current) {
      holdingRef.current = false;
      callbacksRef.current.onHoldEnd?.();
    } else {
      callbacksRef.current.onTap();
    }
    // The click that follows comes at once; never let a stale flag eat a later keyboard press.
    window.setTimeout(() => {
      swallowClickRef.current = false;
    }, 600);
  }, []);

  const onPointerCancel = useCallback(() => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    swallowClickRef.current = false;
    clearTimer();
    if (holdingRef.current) {
      holdingRef.current = false;
      callbacksRef.current.onHoldEnd?.();
    }
  }, []);

  const onClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (swallowClickRef.current) {
      swallowClickRef.current = false;
      return;
    }
    if (disabled) return;
    // Keyboard activation (Enter/Space) or a click without pointer events.
    event.preventDefault();
    callbacksRef.current.onPressStart?.();
    callbacksRef.current.onTap();
  }, [disabled]);

  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    // A long touch would open the system menu instead of recording.
    event.preventDefault();
  }, []);

  return { onPointerDown, onPointerUp, onPointerCancel, onClick, onContextMenu };
}
