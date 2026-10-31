import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

/** How long the button must be held before the turn is stopped. */
const HOLD_TO_STOP_MS = 1000;
/** How long the hint and its "Stop?" confirmation stay after a plain click or tap. */
const CONFIRM_VISIBLE_MS = 3000;
/** How far (px) a held finger or cursor may drift off the button before the hold is cancelled. */
const HOLD_DRIFT_TOLERANCE_PX = 8;

type HoldToStopButtonProps = {
  onStop: () => void;
  /** Shape of the button (size, border, padding, gap); the fill and hint are added here. */
  className?: string;
};

/**
 * Used by ChatComposer (left of the toolbar, away from Send) as the only way to
 * stop a running turn. The stop must be deliberate: it fires after the button
 * is held for about a second (mouse, finger, or Enter / Space on the keyboard).
 * A plain click or tap — and the activation a screen reader sends, which has no
 * hold — shows a "hold to stop" hint with a small "Stop?" confirmation button
 * for a few seconds, so the stop stays reachable without a hold.
 */
export default function HoldToStopButton({ onStop, className = '' }: HoldToStopButtonProps) {
  const { t } = useTranslation('chat');
  // Drives the fill sweeping across the button while it is held.
  const [isHolding, setIsHolding] = useState(false);
  // The hint + "Stop?" confirmation shown after a click that was not a hold.
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const holdTimerRef = useRef<number | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  // Set when the confirmation was opened without a pointer (keyboard or screen
  // reader): focus then moves to the confirm button so it can be activated.
  const focusConfirmRef = useRef(false);
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current !== null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  const closeConfirm = useCallback(() => {
    clearConfirmTimer();
    setIsConfirmOpen(false);
  }, [clearConfirmTimer]);

  const scheduleConfirmClose = useCallback(() => {
    clearConfirmTimer();
    confirmTimerRef.current = window.setTimeout(() => {
      confirmTimerRef.current = null;
      setIsConfirmOpen(false);
    }, CONFIRM_VISIBLE_MS);
  }, [clearConfirmTimer]);

  const openConfirm = useCallback((moveFocus: boolean) => {
    focusConfirmRef.current = moveFocus;
    setIsConfirmOpen(true);
    scheduleConfirmClose();
  }, [scheduleConfirmClose]);

  const stop = useCallback(() => {
    clearHoldTimer();
    closeConfirm();
    setIsHolding(false);
    onStopRef.current();
  }, [clearHoldTimer, closeConfirm]);

  const startHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      return;
    }
    setIsHolding(true);
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      stop();
    }, HOLD_TO_STOP_MS);
  }, [stop]);

  // Released early: cancel, and offer the hint and the confirmation instead.
  const releaseHold = useCallback((moveFocus: boolean) => {
    if (holdTimerRef.current === null) {
      return;
    }
    clearHoldTimer();
    setIsHolding(false);
    openConfirm(moveFocus);
  }, [clearHoldTimer, openConfirm]);

  // The finger or cursor left the button, or the gesture was taken over: cancel quietly.
  const cancelHold = useCallback(() => {
    clearHoldTimer();
    setIsHolding(false);
  }, [clearHoldTimer]);

  useEffect(() => () => {
    clearHoldTimer();
    clearConfirmTimer();
  }, [clearHoldTimer, clearConfirmTimer]);

  useEffect(() => {
    if (isConfirmOpen && focusConfirmRef.current) {
      confirmButtonRef.current?.focus();
    }
  }, [isConfirmOpen]);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    // Captured so a release outside still ends the hold here; the drift check
    // below is what cancels a hold the finger or cursor slid away from.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startHold();
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (holdTimerRef.current === null) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    // jsdom and some synthetic events report a zero box; never cancel on that.
    if (rect.width === 0 && rect.height === 0) {
      return;
    }
    const isOutside = event.clientX < rect.left - HOLD_DRIFT_TOLERANCE_PX
      || event.clientX > rect.right + HOLD_DRIFT_TOLERANCE_PX
      || event.clientY < rect.top - HOLD_DRIFT_TOLERANCE_PX
      || event.clientY > rect.bottom + HOLD_DRIFT_TOLERANCE_PX;
    if (isOutside) {
      cancelHold();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
      event.preventDefault();
      startHold();
    }
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      releaseHold(true);
    }
  };

  // A real pointer click is already handled by the pointer events above
  // (detail >= 1). A click with no pointer or key before it (detail 0) is what
  // a screen reader sends: it cannot hold, so it gets the confirmation.
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (event.detail === 0 && holdTimerRef.current === null) {
      openConfirm(true);
    }
  };

  const hint = isHolding
    ? t('input.holdStop.holding', { defaultValue: 'Keep holding to stop' })
    : t('input.holdStop.hint', { defaultValue: 'Hold to stop' });
  const label = t('input.holdStop.label', { defaultValue: 'Stop' });

  return (
    <span className="pointer-events-auto relative inline-flex shrink-0">
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={() => releaseHold(false)}
        onPointerLeave={(event) => {
          // A captured pointer does not leave; an uncaptured mouse that does is a cancel.
          if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            cancelHold();
          }
        }}
        onPointerCancel={cancelHold}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={cancelHold}
        onContextMenu={(event) => event.preventDefault()}
        onClick={handleClick}
        style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
        className={`relative inline-flex touch-none select-none items-center justify-center overflow-hidden whitespace-nowrap text-xs text-muted-foreground transition-colors duration-150 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50 ${className}`}
        aria-label={t('input.holdStop.aria', { defaultValue: 'Stop the turn (hold for 1 second)' })}
        aria-expanded={isConfirmOpen}
        title={hint}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 bg-primary/30"
          style={{
            width: isHolding ? '100%' : '0%',
            transition: isHolding ? `width ${HOLD_TO_STOP_MS}ms linear` : 'none',
          }}
        />
        <svg className="relative h-2.5 w-2.5 fill-current" viewBox="0 0 24 24" aria-hidden>
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
        <span className="relative">{label}</span>
      </button>

      {isHolding && !isConfirmOpen && (
        <span
          role="status"
          className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 whitespace-nowrap rounded-md border border-border/60 bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
        >
          {hint}
        </span>
      )}

      {isConfirmOpen && (
        <span
          className="absolute bottom-full left-0 z-20 mb-1.5 flex items-center gap-2 whitespace-nowrap rounded-lg border border-border/60 bg-popover py-1 pl-2.5 pr-1 text-xs text-popover-foreground shadow-md"
          // Kept open while the pointer or focus is on it, so it never closes
          // under a hand reaching for "Stop?".
          onPointerEnter={clearConfirmTimer}
          onPointerLeave={scheduleConfirmClose}
          onFocus={clearConfirmTimer}
          onBlur={scheduleConfirmClose}
        >
          <span role="status" className="text-muted-foreground">
            {t('input.holdStop.hint', { defaultValue: 'Hold to stop' })}
          </span>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={(event) => {
              event.preventDefault();
              stop();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeConfirm();
              }
            }}
            className="rounded-md bg-destructive/10 px-2 py-1 font-medium text-destructive transition-colors duration-150 hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50"
            aria-label={t('input.holdStop.confirmAria', { defaultValue: 'Stop the turn now' })}
          >
            {t('input.holdStop.confirm', { defaultValue: 'Stop?' })}
          </button>
        </span>
      )}
    </span>
  );
}
