import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

import { VoiceDesktop } from '@/modules/kabina-voice/VoiceDesktop';
import { VoicePhone } from '@/modules/kabina-voice/VoicePhone';
import { useVoiceFlow } from '@/modules/kabina-voice/hooks/useVoiceFlow';
import type { VoiceContext } from '@/modules/kabina-voice/utils/voiceActionPlan';
import { Button, lockPageScroll } from '@/modules/kabina';
import { useEscapeLayer } from '@/shared/hooks/useEscapeLayer';
import { useVoiceHotkey } from '@/shared/hooks/useMirageSettingsView';
import type { KabinaProjectRef } from '@/shared/types';

import '@/modules/kabina-voice/voice.css';

/** Props the Kabina shell passes to its voice overlay slot. */
export type KabinaVoiceOverlayProps = {
  onClose: () => void;
  /** True while ⌥ Space (or the voice button) is held: releasing it sends the phrase. */
  holding: boolean;
  /** Bumped by the shell when the voice button is pressed while the overlay is open. */
  buttonPresses: number;
  isPhone: boolean;
  /** The chat on screen, if any: the default addressee («открыт чат → туда»). */
  activeSessionId: string | null;
  activeProjectId: string | null;
  projects: KabinaProjectRef[];
  /** Tells the shell whether the microphone is live (the floating button glows). */
  onLiveChange?: (live: boolean) => void;
};

/**
 * Used by project-workspace through the Kabina shell's voice slot (`?voice`): voice
 * input from any screen. Opening starts recording; releasing ⌥ Space, «Готово» or the
 * voice button sends it to SpeechKit, the parse becomes action cards, and «Выполнить»
 * writes calendar events and hands tasks to Claude. Esc while recording throws the
 * audio away.
 */
export function KabinaVoiceOverlay({
  onClose,
  holding,
  buttonPresses,
  isPhone,
  activeSessionId,
  activeProjectId,
  projects,
  onLiveChange,
}: KabinaVoiceOverlayProps) {
  // The context is fixed for the life of one overlay: navigating away closes it.
  const context = useMemo<VoiceContext>(() => ({ sessionId: activeSessionId, projectId: activeProjectId }), [activeProjectId, activeSessionId]);
  const flow = useVoiceFlow({ context, projects });
  const { label: hotkeyLabel } = useVoiceHotkey();
  const panelRef = useRef<HTMLElement>(null);
  const { listen, finish, cancel, phase, view, execute } = flow;
  const listening = phase === 'listening';

  // Opening the overlay is the request to listen.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void listen();
  }, [listen]);

  // Releasing the held key or button sends the phrase.
  const wasHoldingRef = useRef(holding);
  // Released while the microphone was still opening: stop as soon as it records.
  const stopOnListenRef = useRef(false);
  useEffect(() => {
    if (wasHoldingRef.current && !holding && listening) void finish();
    if (wasHoldingRef.current && !holding && phase === 'starting') stopOnListenRef.current = true;
    if (holding) stopOnListenRef.current = false;
    // A new hold over the cards or after an error records a new phrase.
    if (!wasHoldingRef.current && holding && !listening && phase !== 'starting' && phase !== 'transcribing' && phase !== 'parsing' && phase !== 'executing') {
      void listen({ confirmable: true });
    }
    wasHoldingRef.current = holding;
  }, [finish, holding, listen, listening, phase]);

  useEffect(() => {
    if (!listening) {
      if (phase !== 'starting') stopOnListenRef.current = false;
      return;
    }
    if (!stopOnListenRef.current) return;
    stopOnListenRef.current = false;
    void finish();
  }, [finish, listening, phase]);

  // A press on the floating voice button while open: stop and send, or record again.
  const pressesRef = useRef(buttonPresses);
  useEffect(() => {
    if (pressesRef.current === buttonPresses) return;
    pressesRef.current = buttonPresses;
    if (listening) void finish();
    else if (phase === 'cancelled' || phase === 'error' || phase === 'parsed' || phase === 'done') void listen({ confirmable: phase === 'parsed' });
  }, [buttonPresses, finish, listen, listening, phase]);

  useEffect(() => {
    onLiveChange?.(listening);
  }, [listening, onLiveChange]);
  useEffect(() => () => onLiveChange?.(false), [onLiveChange]);

  // Esc: drop the recording while listening, otherwise close. Enter runs the cards.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The overlay is an Esc layer: a menu opened over it («Куда: …») takes Esc first.
  const isTopLayer = useEscapeLayer(true);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!isTopLayer()) return;
        event.preventDefault();
        event.stopPropagation();
        if (phase === 'listening' || phase === 'starting') cancel();
        else onCloseRef.current();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && view === 'parsed' && phase === 'parsed') {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
        // Enter on another control («Перезаписать», «Править текстом», «Куда: …») activates that
        // control, not «Выполнить»: running the cards sends messages and writes events.
        if (target instanceof Element && target.closest('button, a[href], select, [role="button"], [role="checkbox"], [role="menuitem"], [contenteditable="true"]')) return;
        event.preventDefault();
        void execute();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [cancel, execute, isTopLayer, phase, view]);

  // The page behind neither scrolls nor jumps; focus comes back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const releaseScroll = lockPageScroll();
    const timer = window.setTimeout(() => panelRef.current?.focus({ preventScroll: true }), 0);
    return () => {
      window.clearTimeout(timer);
      releaseScroll();
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  if (phase === 'cancelled') {
    return createPortal(
      <div className="kb-portal">
        <div className="kb-scrim" aria-hidden="true" onClick={onClose} style={{ background: 'rgba(13,12,10,0.55)' }} />
        <div className="kb-vo-frame" style={{ pointerEvents: 'none' }}>
          <div className="kb-vo-cancelled kb-pop kb-bz" role="status" style={{ pointerEvents: 'auto' }}>
            <span className="kb-led kb-led-idle" />
            <span style={{ fontSize: 14, color: 'var(--kb-text)' }}>Запись отменена — ничего не отправлено.</span>
            {!isPhone && (
              <span style={{ fontSize: 13, color: 'var(--kb-soft)' }}>
                Зажми <span className="kb-m kb-vo-key">{hotkeyLabel}</span> или нажми микрофон
              </span>
            )}
            <Button variant="ghost" onClick={() => void listen()}>Открыть снова</Button>
            <Link className="kb-btn kb-ghost" to="/" onClick={onClose} style={{ borderColor: 'transparent', color: 'var(--kb-soft)' }}>На главный →</Link>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  if (isPhone) {
    return createPortal(
      <div className="kb-portal">
        <VoicePhone flow={flow} context={context} projects={projects} onClose={onClose} />
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="kb-portal">
      <div className="kb-scrim" aria-hidden="true" />
      <div className="kb-vo-frame">
        <section ref={panelRef} className="kb-vo-panel kb-bz kb-pop" role="dialog" aria-modal="true" aria-labelledby="kb-voice-title" tabIndex={-1}>
          <VoiceDesktop flow={flow} context={context} projects={projects} onClose={onClose} />
        </section>
      </div>
    </div>,
    document.body,
  );
}
