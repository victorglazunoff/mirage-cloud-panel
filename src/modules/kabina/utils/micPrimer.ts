/**
 * Microphone opened inside the user's gesture.
 *
 * iOS Safari wants the microphone (and the AudioContext of the level meter) started
 * from the tap itself; the voice overlay starts recording later, from an effect, after
 * a network check. So the voice buttons call `primeMicrophone()` synchronously in their
 * pointer handler, and the recorder takes the already requested stream with
 * `takePrimedMicrophone()`. An unclaimed stream is released after a few seconds so the
 * microphone indicator never stays on.
 */

/** The constraints every Kabina recording uses. */
export const VOICE_AUDIO_CONSTRAINTS: MediaStreamConstraints = { audio: { echoCancellation: true, noiseSuppression: true } };

/** Unclaimed primed microphone is released after this long. */
const PRIMED_TTL_MS = 8_000;

export type PrimedMicrophone = {
  stream: Promise<MediaStream>;
  /** Created (and resumed) in the gesture, so iOS lets it run; null where unavailable. */
  audioContext: AudioContext | null;
};

let primed: (PrimedMicrophone & { expiry: number }) | null = null;

function stopStream(stream: Promise<MediaStream>) {
  void stream.then((media) => media.getTracks().forEach((track) => track.stop())).catch(() => undefined);
}

function release(entry: PrimedMicrophone & { expiry: number }) {
  window.clearTimeout(entry.expiry);
  stopStream(entry.stream);
  void entry.audioContext?.close().catch(() => undefined);
}

/**
 * Used by the voice buttons (VoiceButton, the phone composer mic, the phone voice
 * screen mic): requests the microphone inside the tap. Safe to call repeatedly — a
 * pending request is reused. Does nothing where capture is impossible (no secure
 * context, no getUserMedia): the recorder reports that case itself.
 */
export function primeMicrophone() {
  if (primed) return;
  if (typeof window === 'undefined' || window.isSecureContext === false) return;
  const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!mediaDevices?.getUserMedia) return;

  let stream: Promise<MediaStream>;
  try {
    stream = mediaDevices.getUserMedia(VOICE_AUDIO_CONSTRAINTS);
  } catch (error) {
    stream = Promise.reject(error);
  }
  // A rejection is read by the recorder; until then it must not surface as unhandled.
  stream.catch(() => undefined);

  let audioContext: AudioContext | null = null;
  try {
    const AudioContextClass = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      audioContext = new AudioContextClass();
      void audioContext.resume?.().catch(() => undefined);
    }
  } catch {
    audioContext = null;
  }

  const entry = { stream, audioContext, expiry: 0 };
  entry.expiry = window.setTimeout(() => {
    if (primed === entry) primed = null;
    release(entry);
  }, PRIMED_TTL_MS);
  primed = entry;
}

/** Used by the voice recorder: hands over the primed microphone (once) or null. */
export function takePrimedMicrophone(): PrimedMicrophone | null {
  const entry = primed;
  if (!entry) return null;
  primed = null;
  window.clearTimeout(entry.expiry);
  return { stream: entry.stream, audioContext: entry.audioContext };
}

/** Used by the voice flow when it will not record after all (voice not configured). */
export function discardPrimedMicrophone() {
  const entry = primed;
  if (!entry) return;
  primed = null;
  release(entry);
}
