import type {
  VoiceIntentAction,
  VoiceIntentRecipient,
  VoiceIntentResponse,
} from '@/shared/types.js';

import { parseIntentWithRules } from './voice-intent-rules.js';

type VoiceIntentDependencies = {
  listRecipients(): VoiceIntentRecipient[];
  /**
   * Asks the model for a JSON parse; returns null when the model is unavailable or failed.
   * `nowIso` is the user's wall clock with its offset, `offsetMinutes` the offset itself.
   */
  askModel(input: {
    text: string;
    recipients: VoiceIntentRecipient[];
    nowIso: string;
    timeZone: string;
    offsetMinutes: number;
  }): Promise<unknown>;
  now(): Date;
  /** Zone used when the request names none (the panel's: `MIRAGE_TIMEZONE`, else the server's own). */
  defaultTimeZone?: string;
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Minutes east of UTC of `timeZone` at `at`; 0 for an unknown zone. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const wallMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((wallMs - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return 0;
  }
}

function offsetSuffix(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** The user's wall clock at `at` as ISO 8601 with the zone's offset, e.g. `2026-10-26T14:32:00+05:00`. */
function wallClockIso(at: Date, offsetMinutes: number): string {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  return `${shifted.toISOString().slice(0, 19)}${offsetSuffix(offsetMinutes)}`;
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isKnownTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** JSON schema the model must follow; used by the module wiring for structured output. */
export const VOICE_INTENT_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['calendar_event', 'project_task', 'message'] },
          summary: { type: 'string' },
          confidence: { type: 'number' },
          title: { type: 'string' },
          eventType: { type: 'string', enum: ['meeting', 'call', 'task', 'reminder', 'other'] },
          start: { type: ['string', 'null'] },
          end: { type: ['string', 'null'] },
          whenText: { type: ['string', 'null'] },
          who: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          projectId: { type: ['string', 'null'] },
        },
        required: ['kind', 'summary'],
      },
    },
  },
  required: ['actions'],
} as const;

/** Short system prompt for the intent model; used by the module wiring. */
export const VOICE_INTENT_SYSTEM_PROMPT = [
  'Ты разбираешь продиктованную по-русски фразу пользователя в список действий. Отвечай только JSON по схеме.',
  'Виды действий: calendar_event (встреча, созвон, напоминание: title, eventType, start и end в ISO 8601 с',
  'часовым поясом или null, whenText как сказано, who — имена людей), project_task (задача для Claude в проекте:',
  'text и projectId из списка проектов или null), message (обычное сообщение в текущий диалог: text).',
  'Не выдумывай время и проекты: нет данных — null. summary — короткий заголовок карточки по-русски.',
  'Если во фразе несколько независимых действий, верни несколько.',
].join(' ');

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validIso(value: unknown): string | null {
  const text = asString(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function normalizeAction(raw: unknown, index: number, recipients: VoiceIntentRecipient[]): VoiceIntentAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const id = `a${index + 1}`;
  const confidence = typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0.7;
  const summary = asString(item.summary);

  if (item.kind === 'calendar_event') {
    const eventTypes = ['meeting', 'call', 'task', 'reminder', 'other'] as const;
    const eventType = eventTypes.find((type) => type === item.eventType) ?? 'other';
    return {
      id, kind: 'calendar_event', confidence,
      summary: summary ?? 'Событие в календарь',
      title: asString(item.title) ?? summary ?? 'Событие',
      eventType,
      start: validIso(item.start),
      end: validIso(item.end),
      whenText: asString(item.whenText),
      who: Array.isArray(item.who) ? item.who.filter((name): name is string => typeof name === 'string') : [],
    };
  }
  if (item.kind === 'project_task') {
    const projectId = asString(item.projectId);
    const recipient = recipients.find((candidate) => candidate.projectId === projectId) ?? null;
    return {
      id, kind: 'project_task', confidence,
      summary: summary ?? 'Задача Claude',
      text: asString(item.text) ?? '',
      recipient,
      candidates: recipient ? [recipient, ...recipients.filter((c) => c !== recipient).slice(0, 4)] : recipients.slice(0, 5),
    };
  }
  if (item.kind === 'message') {
    return { id, kind: 'message', confidence, summary: summary ?? 'Сообщение в диалог', text: asString(item.text) ?? '' };
  }
  return null;
}

/**
 * Creates the service behind `POST /api/voice/intent`: turns recognized speech into action
 * cards. Tries the model first (haiku, JSON by schema) and falls back to the rule parser
 * when the model fails, answers with garbage, or returns no usable action.
 */
export function createVoiceIntentService(dependencies: VoiceIntentDependencies) {
  return {
    async parse(text: string, requestedTimeZone: string | null = null): Promise<VoiceIntentResponse> {
      const recipients = dependencies.listRecipients();
      const now = dependencies.now();
      const timeZone = requestedTimeZone ?? dependencies.defaultTimeZone ?? null;
      // Without a zone the server's own clock is the user's (tests, single-zone setups).
      const offsetMinutes = timeZone ? zoneOffsetMinutes(timeZone, now) : -now.getTimezoneOffset();

      let modelAnswer: unknown = null;
      try {
        modelAnswer = await dependencies.askModel({
          text, recipients, nowIso: wallClockIso(now, offsetMinutes), timeZone: timeZone ?? 'local', offsetMinutes,
        });
      } catch {
        modelAnswer = null;
      }

      const rawActions = typeof modelAnswer === 'object' && modelAnswer !== null
        ? (modelAnswer as { actions?: unknown }).actions
        : null;
      const modelActions = Array.isArray(rawActions)
        ? rawActions.map((raw, index) => normalizeAction(raw, index, recipients))
          .filter((action): action is VoiceIntentAction => action !== null)
        : [];

      if (modelActions.length > 0) {
        return { text, source: 'claude', actions: modelActions, recipients };
      }
      if (!timeZone || offsetMinutes === -now.getTimezoneOffset()) {
        return { text, source: 'rules', actions: parseIntentWithRules(text, recipients, now), recipients };
      }
      // The rule parser reads local getters: hand it a clock that shows the user's wall time
      // and stamp the user's offset on the times it returns.
      const serverOffset = -now.getTimezoneOffset();
      const userWallClock = new Date(now.getTime() + (offsetMinutes - serverOffset) * 60_000);
      const restamp = (iso: string | null) => (iso ? `${iso.slice(0, 19)}${offsetSuffix(offsetMinutes)}` : iso);
      const actions = parseIntentWithRules(text, recipients, userWallClock).map((action) => (
        action.kind === 'calendar_event' ? { ...action, start: restamp(action.start), end: restamp(action.end) } : action
      ));
      return { text, source: 'rules', actions, recipients };
    },
  };
}

/** Service type used by the voice router and module wiring. */
export type VoiceIntentService = ReturnType<typeof createVoiceIntentService>;
