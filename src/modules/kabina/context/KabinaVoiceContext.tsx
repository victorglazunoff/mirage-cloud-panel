import { createContext, useContext } from 'react';

/** What a screen's own microphone may ask of the shell's voice overlay. */
export type KabinaVoiceControl = {
  /** Tap: opens voice (recording starts), or stops and sends while it records. */
  press: () => void;
  /** Push-to-talk began: opens voice recording; release sends. */
  holdStart: () => void;
  holdEnd: () => void;
};

/** Provided by KabinaShell, which owns the voice overlay and the «held» state. */
export const KabinaVoiceContext = createContext<KabinaVoiceControl | null>(null);

/**
 * Used by kabina-chat (the phone composer microphone of DarkPhoneChat): the same
 * tap / hold semantics as the floating voice button, so release sends the phrase.
 * Null outside the shell.
 */
export function useKabinaVoiceControl(): KabinaVoiceControl | null {
  return useContext(KabinaVoiceContext);
}
