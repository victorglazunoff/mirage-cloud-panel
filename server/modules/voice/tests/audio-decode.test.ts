import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AudioTooLongError, audioExtensionFor, decodeAudioToPcm } from '../audio-decode.service.js';
import { createSpeechKitService } from '../speechkit.service.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

/** A 440 Hz tone (one second by default) in the given container, made by ffmpeg itself. */
function makeTone(extension: string, codecArgs: string[], extra: string[] = [], seconds = 1): Buffer {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
  const output = path.join(directory, `tone.${extension}`);
  try {
    const result = spawnSync('ffmpeg', [
      '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ac', '1', ...codecArgs, ...extra, output,
    ]);
    assert.equal(result.status, 0, `ffmpeg could not make a ${extension} sample`);
    return readFileSync(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// One second of 16 kHz mono s16le is 32 000 bytes; encoders pad a little either way.
function assertAboutOneSecond(pcm: Buffer) {
  assert.ok(pcm.length > 28_000 && pcm.length < 40_000, `unexpected PCM length ${pcm.length}`);
}

test('names the input after the browser file name, then after the content type', () => {
  assert.equal(audioExtensionFor({ fileName: 'voice.m4a', mimeType: 'audio/mp4' }), 'm4a');
  assert.equal(audioExtensionFor({ fileName: 'blob', mimeType: 'audio/mp4;codecs=mp4a.40.2' }), 'm4a');
  assert.equal(audioExtensionFor({ fileName: '', mimeType: 'audio/aac' }), 'aac');
  assert.equal(audioExtensionFor({ fileName: 'recording', mimeType: 'audio/ogg;codecs=opus' }), 'ogg');
  assert.equal(audioExtensionFor({ fileName: 'voice.webm', mimeType: 'audio/webm' }), 'webm');
  assert.equal(audioExtensionFor({ fileName: 'x', mimeType: '' }), 'webm');
});

test('decodes iOS Safari MP4/AAC with the index at the end (not readable from a pipe)', { skip: !hasFfmpeg }, async () => {
  // ffmpeg's default MP4 puts moov last; at 40 s that no longer decodes from stdin
  // («partial file»), which is how the old pipe decoder lost iOS phrases.
  const m4a = makeTone('m4a', ['-c:a', 'aac'], [], 40);
  const pcm = await decodeAudioToPcm({ bytes: m4a, mimeType: 'audio/mp4', fileName: 'voice.m4a' });
  assert.ok(pcm.length > 39 * 32_000 && pcm.length < 41 * 32_000, `unexpected PCM length ${pcm.length}`);
});

test('decodes fragmented MP4 as MediaRecorder writes it', { skip: !hasFfmpeg }, async () => {
  const fragmented = makeTone('mp4', ['-c:a', 'aac'], ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']);
  assertAboutOneSecond(await decodeAudioToPcm({ bytes: fragmented, mimeType: 'audio/mp4', fileName: 'blob' }));
});

test('decodes raw AAC (ADTS), webm/opus and ogg/opus', { skip: !hasFfmpeg }, async () => {
  const aac = makeTone('aac', ['-c:a', 'aac']);
  assertAboutOneSecond(await decodeAudioToPcm({ bytes: aac, mimeType: 'audio/aac', fileName: 'voice.aac' }));
  const webm = makeTone('webm', ['-c:a', 'libopus']);
  assertAboutOneSecond(await decodeAudioToPcm({ bytes: webm, mimeType: 'audio/webm;codecs=opus', fileName: 'voice.webm' }));
  const ogg = makeTone('ogg', ['-c:a', 'libopus']);
  assertAboutOneSecond(await decodeAudioToPcm({ bytes: ogg, mimeType: 'audio/ogg', fileName: 'voice.ogg' }));
});

test('rejects bytes that are not audio and leaves no temporary files', { skip: !hasFfmpeg }, async () => {
  const before = new Set(readdirTmp());
  await assert.rejects(decodeAudioToPcm({ bytes: Buffer.from('not audio at all'), mimeType: 'audio/mp4', fileName: 'voice.m4a' }));
  const leftovers = readdirTmp().filter((name) => !before.has(name));
  assert.deepEqual(leftovers, []);
});

test('refuses audio longer than the cap instead of decoding all of it into memory', { skip: !hasFfmpeg }, async () => {
  // A few MB of low-bitrate opus is hours of audio: gigabytes of PCM and hundreds of paid requests.
  const ogg = makeTone('ogg', ['-c:a', 'libopus'], [], 3);
  const before = new Set(readdirTmp());
  await assert.rejects(
    decodeAudioToPcm({ bytes: ogg, mimeType: 'audio/ogg', fileName: 'voice.ogg' }, 'ffmpeg', 32_000),
    (error: unknown) => error instanceof AudioTooLongError,
  );
  assert.deepEqual(readdirTmp().filter((name) => !before.has(name)), []);
  assertAboutOneSecond(await decodeAudioToPcm({ bytes: makeTone('ogg', ['-c:a', 'libopus']), mimeType: 'audio/ogg', fileName: 'v.ogg' }, 'ffmpeg', 64_000));
});

test('SpeechKit answers 413 for a too long recording and never calls the backend', async () => {
  let backendCalls = 0;
  const speechKit = createSpeechKitService({
    loadApiKey: async () => 'test-key',
    convertToPcm: async () => { throw new AudioTooLongError(1_000); },
    fetchBackend: async () => { backendCalls += 1; return new Response('{}'); },
  });
  const result = await speechKit.transcribe({ bytes: Buffer.from('x'), mimeType: 'audio/ogg', fileName: 'v.ogg' });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 413);
  assert.equal(!result.ok && result.code, 'VOICE_TOO_LONG');
  assert.equal(backendCalls, 0);
});

function readdirTmp(): string[] {
  return readdirSync(os.tmpdir()).filter((name) => name.startsWith('mirage-voice-'));
}
