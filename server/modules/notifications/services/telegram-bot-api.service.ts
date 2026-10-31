import type { TelegramBotApi, TelegramInlineButton, TelegramUpdate } from '@/shared/types.js';

const API_ORIGIN = 'https://api.telegram.org';
/** Ordinary calls; a long poll gets its own timeout on top of the poll window. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Telegram's own limit for a message text. */
const MAX_TEXT_LENGTH = 4096;

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type BotApiEnvelope = { ok?: boolean; result?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };

/**
 * A failed Bot API call. The message is Telegram's `description` or a generic
 * network message — never the request URL, which carries the token.
 */
export class TelegramApiError extends Error {
  readonly status: number;
  readonly retryAfterSec: number | null;

  constructor(message: string, status: number, retryAfterSec: number | null = null) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

function toReplyMarkup(keyboard: TelegramInlineButton[][] | undefined): Record<string, unknown> {
  // An empty keyboard is how an edit removes the buttons of a sent message.
  return {
    inline_keyboard: (keyboard ?? []).map((row) => row.map((button) => (
      button.url ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.callbackData ?? '' }
    ))),
  };
}

function clampText(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

/**
 * Binds the Bot API to one token. Used by the Telegram notifications service
 * (sending, editing, polling) and by its tests with a substituted `fetch`.
 */
export function createTelegramBotApi(token: string, fetchImpl: FetchLike = fetch): TelegramBotApi {
  const call = async (method: string, body: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(`${API_ORIGIN}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (error) {
      // fetch errors may echo the URL in their cause; only a fixed text leaves here.
      const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new TelegramApiError(aborted ? `${method}: request aborted` : `${method}: network error`, 0);
    }
    let envelope: BotApiEnvelope = {};
    try {
      envelope = (await response.json()) as BotApiEnvelope;
    } catch {
      envelope = {};
    }
    if (!response.ok || envelope.ok !== true) {
      const description = typeof envelope.description === 'string' ? envelope.description : `HTTP ${response.status}`;
      const retryAfter = Number(envelope.parameters?.retry_after);
      throw new TelegramApiError(`${method}: ${description}`, response.status, Number.isFinite(retryAfter) ? retryAfter : null);
    }
    return envelope.result;
  };

  return {
    async getMe() {
      const result = (await call('getMe', {})) as { username?: unknown } | null;
      return { username: typeof result?.username === 'string' ? result.username : null };
    },

    async sendMessage(chatId, text, keyboard) {
      const result = (await call('sendMessage', {
        chat_id: chatId,
        text: clampText(text),
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: toReplyMarkup(keyboard) } : {}),
      })) as { message_id?: unknown } | null;
      return { messageId: Number(result?.message_id) };
    },

    async editMessageText(chatId, messageId, text, keyboard) {
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: clampText(text),
        disable_web_page_preview: true,
        reply_markup: toReplyMarkup(keyboard),
      });
    },

    async answerCallbackQuery(callbackQueryId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
    },

    async getUpdates(offset, timeoutSec, signal) {
      const result = await call('getUpdates', {
        ...(offset !== null ? { offset } : {}),
        timeout: timeoutSec,
        allowed_updates: ['message', 'callback_query'],
      }, (timeoutSec * 1000) + REQUEST_TIMEOUT_MS, signal);
      return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
    },
  };
}
