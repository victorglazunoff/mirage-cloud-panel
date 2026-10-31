import { useCallback, useEffect, useRef, useState } from 'react';

import { VOICE_AUDIO_CONSTRAINTS, takePrimedMicrophone } from '@/modules/kabina';

/** Why the microphone could not start; each maps to its own error card. */
export type VoiceMicError = 'mic-denied' | 'mic-missing' | 'mic-insecure' | 'mic-unsupported' | 'mic-busy' | 'mic-failed';

/** A finished recording ready for `POST /api/voice/transcribe`. */
export type VoiceRecording = { blob: Blob; durationMs: number; fileName: string };

/** Longest phrase: the dial is one minute (DarkVoice «/ 1:00»). */
export const VOICE_MAX_MS = 60_000;
const TICK_MS = 250;
/** Level samples kept for the wave (newest first); one sample per animation frame step. */
const LEVEL_HISTORY = 16;
const LEVEL_SAMPLE_MS = 70;

/**
 * Recording formats, best first. iOS Safari's MediaRecorder writes MP4/AAC only (webm is
 * new and shaky there), so MP4 leads; Chrome writes both, Firefox only webm/ogg. The
 * server decodes any of them with ffmpeg.
 */
const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

/** Picks the first format this browser's MediaRecorder can write ('' — let it choose). */
export function pickMimeType(isTypeSupported: ((type: string) => boolean) | null | undefined): string {
  if (typeof isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  }) ?? '';
}

/** File name and plain content type for the upload: `voice.m4a` + `audio/mp4`, and so on. */
export function recordingFileFor(mimeType: string): { fileName: string; contentType: string } {
  const type = (mimeType.split(';')[0] || '').trim().toLowerCase();
  if (type.includes('ogg')) return { fileName: 'voice.ogg', contentType: 'audio/ogg' };
  if (type === 'audio/aac' || type === 'audio/x-aac') return { fileName: 'voice.aac', contentType: 'audio/aac' };
  if (type.includes('mp4') || type.includes('m4a')) return { fileName: 'voice.m4a', contentType: 'audio/mp4' };
  return { fileName: 'voice.webm', contentType: 'audio/webm' };
}

function classifyMicError(error: unknown): VoiceMicError {
  const name = error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? String((error as { name?: unknown }).name)
    : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'mic-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'mic-missing';
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return 'mic-busy';
  return 'mic-failed';
}

type Session = {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  mimeType: string;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  frame: number | null;
  tick: number | null;
  /** Resolves `stop()` once the recorder has flushed its last chunk. */
  onStopped: ((recording: VoiceRecording | null) => void) | null;
  cancelled: boolean;
};

/**
 * Used by the voice overlay: one MediaRecorder session (MP4/AAC on iOS, webm/opus
 * elsewhere — see pickMimeType), the elapsed time for the dial, and a live microphone level read through an
 * AnalyserNode for the wave. `levels` is a ref (newest first, 0..1) so the wave can
 * animate at frame rate without re-rendering the overlay. Recording stops on its own at
 * one minute and hands the blob to `onLimit`.
 */
export function useVoiceRecorder(onLimit: (recording: VoiceRecording | null) => void) {
  const sessionRef = useRef<Session | null>(null);
  // A start still waiting for the microphone (permission prompt, slow device). Esc or closing
  // the overlay in that window marks it cancelled, so the stream that arrives late is shut.
  const startingRef = useRef<{ cancelled: boolean } | null>(null);
  const levelsRef = useRef<number[]>(new Array(LEVEL_HISTORY).fill(0));
  const onLimitRef = useRef(onLimit);
  onLimitRef.current = onLimit;
  // Milliseconds recorded so far — drives the timer, the dial arc and the hand.
  const [elapsedMs, setElapsedMs] = useState(0);
  // True between a successful start and stop/cancel — the dial and the FAB look live only then.
  const [isRecording, setIsRecording] = useState(false);

  const release = useCallback((session: Session) => {
    if (session.frame !== null) cancelAnimationFrame(session.frame);
    if (session.tick !== null) window.clearInterval(session.tick);
    session.stream.getTracks().forEach((track) => track.stop());
    void session.audioContext?.close().catch(() => undefined);
    levelsRef.current = new Array(LEVEL_HISTORY).fill(0);
  }, []);

  const finish = useCallback((): Promise<VoiceRecording | null> => {
    const session = sessionRef.current;
    if (!session) return Promise.resolve(null);
    return new Promise((resolve) => {
      session.onStopped = resolve;
      if (session.recorder.state !== 'inactive') {
        try {
          session.recorder.stop();
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
  }, []);

  const start = useCallback(async (): Promise<VoiceMicError | null> => {
    if (sessionRef.current || startingRef.current) return null;
    if (typeof window !== 'undefined' && window.isSecureContext === false) return 'mic-insecure';
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return 'mic-unsupported';

    // A voice button already asked for the microphone inside the tap (iOS); otherwise ask now.
    const primed = takePrimedMicrophone();
    const attempt = { cancelled: false };
    startingRef.current = attempt;
    let stream: MediaStream;
    try {
      stream = await (primed?.stream ?? navigator.mediaDevices.getUserMedia(VOICE_AUDIO_CONSTRAINTS));
    } catch (error) {
      void primed?.audioContext?.close().catch(() => undefined);
      return classifyMicError(error);
    } finally {
      if (startingRef.current === attempt) startingRef.current = null;
    }
    if (attempt.cancelled) {
      // Cancelled while the microphone was opening: never start, free it at once.
      stream.getTracks().forEach((track) => track.stop());
      void primed?.audioContext?.close().catch(() => undefined);
      return null;
    }

    const mimeType = pickMimeType(MediaRecorder.isTypeSupported?.bind(MediaRecorder));
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      void primed?.audioContext?.close().catch(() => undefined);
      return 'mic-unsupported';
    }

    let audioContext: AudioContext | null = primed?.audioContext ?? null;
    let analyser: AnalyserNode | null = null;
    try {
      const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!audioContext && AudioContextClass) audioContext = new AudioContextClass();
      if (audioContext) {
        void audioContext.resume?.().catch(() => undefined);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        audioContext.createMediaStreamSource(stream).connect(analyser);
      }
    } catch {
      void audioContext?.close().catch(() => undefined);
      audioContext = null;
      analyser = null;
    }

    const session: Session = {
      stream, recorder, chunks: [], startedAt: performance.now(), mimeType: recorder.mimeType || mimeType || 'audio/webm',
      audioContext, analyser, frame: null, tick: null, onStopped: null, cancelled: false,
    };
    sessionRef.current = session;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) session.chunks.push(event.data);
    };
    recorder.onstop = () => {
      const durationMs = performance.now() - session.startedAt;
      release(session);
      if (sessionRef.current === session) sessionRef.current = null;
      setIsRecording(false);
      const file = recordingFileFor(session.mimeType);
      const recording = session.cancelled || session.chunks.length === 0
        ? null
        : { blob: new Blob(session.chunks, { type: file.contentType }), durationMs, fileName: file.fileName };
      session.onStopped?.(recording);
    };

    // Level meter: RMS of the time-domain signal, eased, sampled into a short history.
    if (analyser) {
      const buffer = new Uint8Array(analyser.fftSize);
      let smoothed = 0;
      let lastSample = 0;
      const read = (now: number) => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (let index = 0; index < buffer.length; index += 1) {
          const value = (buffer[index] - 128) / 128;
          sum += value * value;
        }
        const level = Math.min(1, Math.sqrt(sum / buffer.length) * 4.2);
        smoothed = level > smoothed ? smoothed * 0.45 + level * 0.55 : smoothed * 0.82 + level * 0.18;
        if (now - lastSample >= LEVEL_SAMPLE_MS) {
          lastSample = now;
          levelsRef.current = [smoothed, ...levelsRef.current.slice(0, LEVEL_HISTORY - 1)];
        } else {
          levelsRef.current[0] = smoothed;
        }
        session.frame = requestAnimationFrame(read);
      };
      session.frame = requestAnimationFrame(read);
    }

    session.tick = window.setInterval(() => {
      const elapsed = performance.now() - session.startedAt;
      setElapsedMs(Math.min(elapsed, VOICE_MAX_MS));
      if (elapsed >= VOICE_MAX_MS && sessionRef.current === session) {
        void finish().then((recording) => onLimitRef.current(recording));
      }
    }, TICK_MS);

    // Safari's MP4 recorder is unreliable with timeslices; one blob on stop is all we need.
    if (session.mimeType.includes('mp4') || session.mimeType.includes('aac')) recorder.start();
    else recorder.start(1000);
    setElapsedMs(0);
    setIsRecording(true);
    return null;
  }, [finish, release]);

  /** Stops and returns the recording (null when nothing was captured). */
  const stop = useCallback(() => finish(), [finish]);

  /** Stops and throws the audio away (Esc). */
  const cancel = useCallback(() => {
    if (startingRef.current) startingRef.current.cancelled = true;
    const session = sessionRef.current;
    if (!session) return;
    session.cancelled = true;
    void finish();
  }, [finish]);

  // Leaving the overlay must always free the microphone.
  useEffect(() => () => {
    if (startingRef.current) startingRef.current.cancelled = true;
    const session = sessionRef.current;
    if (!session) return;
    session.cancelled = true;
    try {
      if (session.recorder.state !== 'inactive') session.recorder.stop();
    } catch {
      // The recorder is already gone; the tracks are released below.
    }
    release(session);
    sessionRef.current = null;
  }, [release]);

  return { start, stop, cancel, elapsedMs, isRecording, levels: levelsRef };
}
