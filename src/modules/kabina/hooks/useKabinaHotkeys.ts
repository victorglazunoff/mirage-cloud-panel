import { useEffect, useRef } from 'react';

import { DEFAULT_VOICE_HOTKEY } from '@/shared/constants';
import { matchesVoiceHotkey, parseVoiceHotkey } from '@/shared/utils';

/** Holding the voice hotkey this long outside a text field starts voice. */
const HOLD_MS = 250;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

type KabinaHotkeyHandlers = {
  onSearch: () => void;
  onVoiceStart: () => void;
  onVoiceEnd: () => void;
  /** Push-to-talk combination from settings (`voice.hotkey`); ⌥ Space by default. */
  voiceHotkey?: string;
};

/**
 * Used by KabinaShell for the global shortcuts:
 * - ⌘K / Ctrl+K opens search from anywhere (also inside fields — it types nothing there);
 * - holding the voice hotkey (settings, ⌥ Space by default) opens voice. Outside
 *   fields it fires after 250 ms; inside a field only key auto-repeat (a real hold)
 *   counts, so a single press still types what the OS types there and normal
 *   typing is never swallowed.
 */
export function useKabinaHotkeys({ onSearch, onVoiceStart, onVoiceEnd, voiceHotkey = DEFAULT_VOICE_HOTKEY }: KabinaHotkeyHandlers) {
  const handlersRef = useRef({ onSearch, onVoiceStart, onVoiceEnd });
  handlersRef.current = { onSearch, onVoiceStart, onVoiceEnd };

  useEffect(() => {
    const chord = parseVoiceHotkey(voiceHotkey);
    // Releasing the main key or any modifier of the chord ends the hold.
    const releaseKeys = new Set<string>([
      ...(chord.alt ? ['Alt'] : []),
      ...(chord.ctrl ? ['Control'] : []),
      ...(chord.meta ? ['Meta'] : []),
      ...(chord.shift ? ['Shift'] : []),
    ]);
    let holdTimer: number | null = null;
    let voiceActive = false;

    const clearHold = () => {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    const startVoice = () => {
      clearHold();
      if (voiceActive) return;
      voiceActive = true;
      handlersRef.current.onVoiceStart();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopPropagation();
        handlersRef.current.onSearch();
        return;
      }

      if (!matchesVoiceHotkey(event, chord)) return;

      if (isEditable(event.target)) {
        // First press belongs to the field; only a held key (auto-repeat) is voice.
        if (!event.repeat) return;
        event.preventDefault();
        startVoice();
        return;
      }

      event.preventDefault();
      if (voiceActive || holdTimer !== null) return;
      holdTimer = window.setTimeout(startVoice, HOLD_MS);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== chord.code && !releaseKeys.has(event.key)) return;
      clearHold();
      if (voiceActive) {
        voiceActive = false;
        handlersRef.current.onVoiceEnd();
      }
    };

    const handleBlur = () => {
      clearHold();
      if (voiceActive) {
        voiceActive = false;
        handlersRef.current.onVoiceEnd();
      }
    };

    // Capture phase: runs before the authors' own ⌘K listener and before fields consume the keys.
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      clearHold();
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [voiceHotkey]);
}
