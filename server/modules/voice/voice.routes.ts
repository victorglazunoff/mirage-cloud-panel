import { Readable } from 'node:stream';

import express from 'express';

import type { VoiceRequestOverrides, VoiceService, VoiceServiceResult } from '@/shared/types.js';
import { asyncHandler } from '@/shared/utils.js';

import type { SpeechKitService } from './speechkit.service.js';
import { isKnownTimeZone } from './voice-intent.service.js';
import type { VoiceIntentService } from './voice-intent.service.js';

type VoiceRouterDependencies = {
  voiceService: VoiceService;
  parseAudioUpload: express.RequestHandler;
  /** Yandex SpeechKit transcriber; preferred over the generic backend when it has a key. */
  speechKit: SpeechKitService;
  intentService: VoiceIntentService;
};

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  const trimmedValue = normalizedValue?.trim();
  return trimmedValue || undefined;
}

function parseVoiceOverrides(request: express.Request): VoiceRequestOverrides {
  return {
    apiKey: readHeaderValue(request.headers['x-voice-api-key']),
    sttModel: readHeaderValue(request.headers['x-voice-stt-model']),
    ttsModel: readHeaderValue(request.headers['x-voice-tts-model']),
    ttsVoice: readHeaderValue(request.headers['x-voice-tts-voice']),
    ttsFormat: readHeaderValue(request.headers['x-voice-tts-format']),
  };
}

function sendFailure<TValue>(
  response: express.Response,
  result: VoiceServiceResult<TValue>,
): result is Extract<VoiceServiceResult<TValue>, { ok: false }> {
  if (result.ok) {
    return false;
  }

  response.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  return true;
}

/**
 * Creates the transport-only router used by the Voice composition root. It is
 * exported for Voice route tests; other modules consume only the composed
 * router exposed from the Voice barrel.
 */
export function createVoiceRouter(dependencies: VoiceRouterDependencies): express.Router {
  const router = express.Router();

  router.get('/health', asyncHandler(async (_request, response) => {
    const generic = dependencies.voiceService.getHealth();
    const speechKit = await dependencies.speechKit.isConfigured();
    response.json({ configured: generic.configured || speechKit, speechKit });
  }));

  router.post('/transcribe', (request, response, next) => {
    dependencies.parseAudioUpload(request, response, (uploadError?: unknown) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        response.status(400).json({ error: message });
        return;
      }

      // Multer uses a callback API, so bridge its parsed request into the async
      // service call and forward unexpected rejections to Express middleware.
      void (async () => {
        if (!request.file) {
          response.status(400).json({ error: 'No audio uploaded' });
          return;
        }

        const audio = {
          bytes: request.file.buffer,
          mimeType: request.file.mimetype || 'audio/webm',
          fileName: request.file.originalname || 'recording.webm',
        };
        // SpeechKit wins when a key exists; otherwise the generic OpenAI-style backend
        // answers, and without both the client gets code VOICE_NOT_CONFIGURED.
        const result = await dependencies.speechKit.isConfigured()
          ? await dependencies.speechKit.transcribe(audio)
          : await dependencies.voiceService.transcribe({ audio, overrides: parseVoiceOverrides(request) });

        if (sendFailure(response, result)) {
          return;
        }

        response.json(result.value);
      })().catch(next);
    });
  });

  router.post('/intent', asyncHandler(async (request, response) => {
    const text = request.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
      response.status(400).json({ error: 'text required (up to 4000 characters)' });
      return;
    }
    // The browser's zone, so «завтра в 11» is 11:00 where the user is, not on the server.
    const timeZone = isKnownTimeZone(request.body?.timeZone) ? request.body.timeZone : null;
    response.json(await dependencies.intentService.parse(text.trim(), timeZone));
  }));

  router.post('/tts', asyncHandler(async (request, response) => {
    const text = request.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      response.status(400).json({ error: 'text required' });
      return;
    }

    const result = await dependencies.voiceService.synthesizeSpeech({
      text,
      overrides: parseVoiceOverrides(request),
    });
    if (sendFailure(response, result)) {
      return;
    }

    response.setHeader('Content-Type', result.value.contentType);
    response.setHeader('Cache-Control', 'no-store');
    if (!result.value.body) {
      response.end();
      return;
    }

    Readable.fromWeb(result.value.body).on('error', (error) => response.destroy(error)).pipe(response);
  }));

  return router;
}
