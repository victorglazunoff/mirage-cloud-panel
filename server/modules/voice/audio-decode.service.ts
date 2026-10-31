import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { VoiceAudioUpload } from '@/shared/types.js';

const DECODE_TIMEOUT_MS = 60_000;
/**
 * Longest recording decoded: 30 minutes of 16 kHz mono s16le (57.6 MB). The
 * 25 MB upload cap alone does not bound it — low-bitrate opus packs an hour
 * into ~1.4 MB, which would decode to gigabytes of PCM and hundreds of paid
 * SpeechKit requests.
 */
const MAX_PCM_BYTES = 30 * 60 * 16_000 * 2;

/** Thrown by `decodeAudioToPcm` when the audio is longer than the cap; the SpeechKit service answers 413. */
export class AudioTooLongError extends Error {
  constructor(maxBytes: number) {
    super(`Audio is longer than ${Math.round(maxBytes / 32_000)} s`);
    this.name = 'AudioTooLongError';
  }
}

/**
 * File extension ffmpeg should see for an upload. Safari records MP4/AAC
 * (`audio/mp4` → `.m4a`), Chrome and Firefox webm/ogg; the name the browser sent wins
 * when it has a known extension, the content type decides otherwise.
 */
export function audioExtensionFor(audio: Pick<VoiceAudioUpload, 'mimeType' | 'fileName'>): string {
  const fromName = path.extname(audio.fileName || '').slice(1).toLowerCase();
  if (['webm', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'aac', 'wav', 'mp3', 'caf'].includes(fromName)) return fromName;
  const type = (audio.mimeType || '').split(';')[0].trim().toLowerCase();
  if (type.includes('ogg') || type.includes('opus')) return 'ogg';
  if (type === 'audio/aac' || type === 'audio/x-aac') return 'aac';
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg')) return 'mp3';
  return 'webm';
}

/**
 * Decodes browser audio (webm/opus, ogg/opus, MP4/AAC from iOS Safari, raw AAC) into
 * raw 16 kHz mono signed 16-bit PCM with ffmpeg. The bytes go through a temporary file,
 * not a pipe: an MP4 keeps its index (moov) at the end, and ffmpeg can only reach it in
 * a seekable input. Used by the Voice module as SpeechKit's decoder; rejects when ffmpeg
 * cannot read the audio. The temporary directory is always removed.
 */
export async function decodeAudioToPcm(audio: VoiceAudioUpload, ffmpegPath = 'ffmpeg', maxBytes = MAX_PCM_BYTES): Promise<Buffer> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mirage-voice-'));
  const inputPath = path.join(directory, `input.${audioExtensionFor(audio)}`);
  try {
    await writeFile(inputPath, audio.bytes);
    return await new Promise<Buffer>((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-nostdin', '-loglevel', 'error', '-i', inputPath, '-vn', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooLong = false;
      const timer = setTimeout(() => ffmpeg.kill('SIGKILL'), DECODE_TIMEOUT_MS);
      ffmpeg.stdout.on('data', (chunk: Buffer) => {
        if (tooLong) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          // Stop decoding at once and drop what was read: nothing past the cap is kept.
          tooLong = true;
          chunks.length = 0;
          ffmpeg.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      ffmpeg.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ffmpeg.on('close', (code) => {
        clearTimeout(timer);
        if (tooLong) reject(new AudioTooLongError(maxBytes));
        else if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg exited with ${code}`));
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
