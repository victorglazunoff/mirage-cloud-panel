import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { primeMicrophone } from '@/modules/kabina';
import { pickMimeType, recordingFileFor, useVoiceRecorder } from '@/modules/kabina-voice/hooks/useVoiceRecorder';

const SAFARI_TYPES = new Set(['audio/mp4', 'audio/mp4;codecs=mp4a.40.2']);
const FIREFOX_TYPES = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/ogg;codecs=opus']);

test('iOS Safari records MP4/AAC; Firefox webm/opus; an unknown recorder chooses itself', () => {
  assert.equal(pickMimeType((type) => SAFARI_TYPES.has(type)), 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(pickMimeType((type) => type === 'audio/mp4'), 'audio/mp4');
  assert.equal(pickMimeType((type) => FIREFOX_TYPES.has(type)), 'audio/webm;codecs=opus');
  assert.equal(pickMimeType((type) => type === 'audio/ogg;codecs=opus'), 'audio/ogg;codecs=opus');
  assert.equal(pickMimeType(() => false), '');
  assert.equal(pickMimeType(undefined), '');
  assert.equal(pickMimeType(() => {
    throw new Error('old WebKit');
  }), '');
});

test('the upload is named and typed after what was recorded', () => {
  assert.deepEqual(recordingFileFor('audio/mp4;codecs=mp4a.40.2'), { fileName: 'voice.m4a', contentType: 'audio/mp4' });
  assert.deepEqual(recordingFileFor('audio/mp4'), { fileName: 'voice.m4a', contentType: 'audio/mp4' });
  assert.deepEqual(recordingFileFor('audio/aac'), { fileName: 'voice.aac', contentType: 'audio/aac' });
  assert.deepEqual(recordingFileFor('audio/webm;codecs=opus'), { fileName: 'voice.webm', contentType: 'audio/webm' });
  assert.deepEqual(recordingFileFor('audio/ogg;codecs=opus'), { fileName: 'voice.ogg', contentType: 'audio/ogg' });
  assert.deepEqual(recordingFileFor(''), { fileName: 'voice.webm', contentType: 'audio/webm' });
});

/** Safari's MediaRecorder as far as the hook can tell: MP4 only. */
class SafariRecorder {
  static isTypeSupported = (type: string) => SAFARI_TYPES.has(type);
  static last: SafariRecorder | null = null;
  mimeType: string;
  state: 'inactive' | 'recording' = 'inactive';
  timeslice: number | undefined = -1;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? '';
    SafariRecorder.last = this;
  }
  start(timeslice?: number) {
    this.timeslice = timeslice;
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const trackStop = vi.fn();
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', SafariRecorder);
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('on iOS the recorder uses the microphone opened in the tap and hands over voice.m4a', async () => {
  // The voice button's pointerdown: the only getUserMedia call.
  primeMicrophone();
  const { result } = renderHook(() => useVoiceRecorder(() => undefined));
  let error: unknown = 'unset';
  await act(async () => {
    error = await result.current.start();
  });
  assert.equal(error, null);
  assert.equal(getUserMedia.mock.calls.length, 1, 'no second request outside the gesture');
  assert.equal(SafariRecorder.last?.mimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(SafariRecorder.last?.timeslice, undefined, 'MP4 is recorded as one piece');

  let recording: Awaited<ReturnType<typeof result.current.stop>> = null;
  await act(async () => {
    recording = await result.current.stop();
  });
  assert.ok(recording);
  const { fileName, blob } = recording as { fileName: string; blob: Blob };
  assert.equal(fileName, 'voice.m4a');
  assert.equal(blob.type, 'audio/mp4');
  assert.equal(trackStop.mock.calls.length, 1, 'the microphone is released after the phrase');
});
