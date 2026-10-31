import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import multer from 'multer';

import { projectsDb } from '@/modules/database/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { getPanelTimeZone } from '@/shared/utils.js';

import { decodeAudioToPcm } from './audio-decode.service.js';
import { createSpeechKitService, readSpeechKitApiKey } from './speechkit.service.js';
import { createVoiceIntentService, VOICE_INTENT_SCHEMA, VOICE_INTENT_SYSTEM_PROMPT } from './voice-intent.service.js';
import { createVoiceRouter } from './voice.routes.js';
import { createVoiceService } from './voice.service.js';

const DEFAULT_VOICE_TIMEOUT_MS = 300_000;
const parsedTimeoutMs = Number(process.env.VOICE_TIMEOUT_MS);
const voiceTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
  ? parsedTimeoutMs
  : DEFAULT_VOICE_TIMEOUT_MS;

const INTENT_MODEL_TIMEOUT_MS = 20_000;

async function timedFetch(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'manual',
      ...options,
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

const voiceService = createVoiceService({
  defaults: {
    // The server-controlled URL is intentional: frontend-configured custom
    // backends are called directly by the browser and never become SSRF input.
    baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.VOICE_API_KEY || '',
    sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
    ttsModel: process.env.VOICE_TTS_MODEL || 'tts-1',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
  },
  timeoutMs: voiceTimeoutMs,
  fetchBackend: (url, options) => timedFetch(url, options, voiceTimeoutMs),
});

const speechKit = createSpeechKitService({
  // Off unless YANDEX_SPEECHKIT_API_KEY or YANDEX_SPEECHKIT_API_KEY_FILE is set.
  loadApiKey: () => readSpeechKitApiKey(),
  convertToPcm: (audio) => decodeAudioToPcm(audio),
  fetchBackend: (url, options) => timedFetch(url, options, 60_000),
});

/** Asks Claude (haiku, no tools, no saved session) to parse speech into actions as JSON. */
async function askIntentModel(input: {
  text: string;
  recipients: Array<{ projectId: string; projectName: string }>;
  nowIso: string;
  timeZone: string;
  offsetMinutes: number;
}): Promise<unknown> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), INTENT_MODEL_TIMEOUT_MS);
  try {
    const executable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    const prompt = JSON.stringify({
      now: input.nowIso,
      timeZone: input.timeZone,
      timezoneOffsetMinutes: input.offsetMinutes,
      projects: input.recipients,
      phrase: input.text,
    });
    const run = query({
      prompt,
      options: {
        model: 'haiku',
        systemPrompt: VOICE_INTENT_SYSTEM_PROMPT,
        maxTurns: 2,
        tools: [],
        settingSources: [],
        persistSession: false,
        abortController,
        outputFormat: { type: 'json_schema', schema: VOICE_INTENT_SCHEMA as unknown as Record<string, unknown> },
        env: { ...process.env },
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      },
    });

    for await (const message of run) {
      if (message.type !== 'result' || message.subtype !== 'success') continue;
      const structured = (message as { structured_output?: unknown }).structured_output;
      if (structured) return structured;
      return JSON.parse(message.result);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const intentService = createVoiceIntentService({
  listRecipients: () => projectsDb.getProjectPaths().map((row) => ({
    projectId: row.project_id,
    projectName: row.custom_project_name?.trim() || path.basename(row.project_path),
  })),
  askModel: askIntentModel,
  now: () => new Date(),
  defaultTimeZone: getPanelTimeZone(),
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Voice router assembled for the server entrypoint. */
export const voiceRoutes = createVoiceRouter({
  voiceService,
  parseAudioUpload: audioUpload.single('audio'),
  speechKit,
  intentService,
});
