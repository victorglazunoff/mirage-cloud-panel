import { readFile } from 'node:fs/promises';

import type { VoiceAudioUpload, VoiceServiceResult } from '@/shared/types.js';

const SPEECHKIT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
const SAMPLE_RATE = 16_000;
// Synchronous recognition accepts at most 30 s per request; 25 s of 16-bit mono PCM per chunk.
const CHUNK_BYTES = 25 * SAMPLE_RATE * 2;

type SpeechKitDependencies = {
  /** Returns the Api-Key of the service account or null when none is configured. */
  loadApiKey(): Promise<string | null>;
  /** Decodes browser audio (webm/ogg/mp4) into raw 16 kHz mono signed 16-bit PCM. */
  convertToPcm(audio: VoiceAudioUpload): Promise<Buffer>;
  fetchBackend(url: string, options: RequestInit): Promise<Response>;
};

/**
 * The SpeechKit Api-Key: `YANDEX_SPEECHKIT_API_KEY`, or the first line of the file
 * named by `YANDEX_SPEECHKIT_API_KEY_FILE` (re-read on every call, so a rotated key
 * applies at once). Neither set — null: SpeechKit is off and the voice screen says
 * how to turn it on. There is no default file. Used by the voice module; exported
 * for the voice tests.
 */
export async function readSpeechKitApiKey(
  env: NodeJS.ProcessEnv = process.env,
  readText: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, 'utf8'),
): Promise<string | null> {
  const fromEnv = env.YANDEX_SPEECHKIT_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = env.YANDEX_SPEECHKIT_API_KEY_FILE?.trim();
  if (!file) return null;
  try {
    return (await readText(file)).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * Creates the Yandex SpeechKit (v1 sync STT) transcriber for `POST /api/voice/transcribe`.
 * Audio is decoded to PCM, cut into 25-second chunks and recognized in Russian; texts are
 * joined. Without a key every call fails with code `VOICE_NOT_CONFIGURED`. The Voice router
 * prefers this service when `isConfigured()` is true. Secrets are never logged or returned.
 */
export function createSpeechKitService(dependencies: SpeechKitDependencies) {
  return {
    async isConfigured(): Promise<boolean> {
      return Boolean(await dependencies.loadApiKey());
    },

    async transcribe(audio: VoiceAudioUpload): Promise<VoiceServiceResult<{ text: string }>> {
      const apiKey = await dependencies.loadApiKey();
      if (!apiKey) {
        return {
          ok: false, status: 503, code: 'VOICE_NOT_CONFIGURED',
          error: 'Распознавание речи не настроено: задай YANDEX_SPEECHKIT_API_KEY или YANDEX_SPEECHKIT_API_KEY_FILE.',
        };
      }

      let pcm: Buffer;
      try {
        pcm = await dependencies.convertToPcm(audio);
      } catch (error) {
        if (error instanceof Error && error.name === 'AudioTooLongError') {
          return { ok: false, status: 413, code: 'VOICE_TOO_LONG', error: 'Запись слишком длинная: распознаю до 30 минут.' };
        }
        return { ok: false, status: 415, code: 'VOICE_BAD_AUDIO', error: 'Не удалось прочитать аудио.' };
      }
      if (pcm.length < SAMPLE_RATE / 5) return { ok: true, value: { text: '' } };

      const parts: string[] = [];
      for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
        let response: Response;
        try {
          response = await dependencies.fetchBackend(
            `${SPEECHKIT_URL}?lang=ru-RU&format=lpcm&sampleRateHertz=${SAMPLE_RATE}&topic=general`,
            {
              method: 'POST',
              headers: { Authorization: `Api-Key ${apiKey}` },
              body: new Uint8Array(pcm.subarray(offset, offset + CHUNK_BYTES)),
            },
          );
        } catch (error) {
          const aborted = error instanceof Error && error.name === 'AbortError';
          return {
            ok: false, status: aborted ? 504 : 502, code: 'VOICE_BACKEND_UNREACHABLE',
            error: aborted ? 'SpeechKit не ответил вовремя.' : 'SpeechKit недоступен.',
          };
        }
        if (!response.ok) {
          const denied = response.status === 401 || response.status === 403;
          return {
            ok: false, status: 502, code: denied ? 'VOICE_KEY_REJECTED' : 'VOICE_BACKEND_ERROR',
            error: denied
              ? 'SpeechKit отклонил ключ: проверьте роль ai.speechkit-stt.user у сервисного аккаунта.'
              : `SpeechKit вернул ошибку ${response.status}.`,
          };
        }
        try {
          const body = await response.json() as { result?: unknown };
          if (typeof body.result === 'string' && body.result.trim()) parts.push(body.result.trim());
        } catch {
          return { ok: false, status: 502, code: 'VOICE_BACKEND_ERROR', error: 'Непонятный ответ SpeechKit.' };
        }
      }
      return { ok: true, value: { text: parts.join(' ') } };
    },
  };
}

/** Service type used by the voice router and module wiring. */
export type SpeechKitService = ReturnType<typeof createSpeechKitService>;
