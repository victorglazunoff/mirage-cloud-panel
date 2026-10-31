import { TelegramApiError } from '@/modules/notifications/services/telegram-bot-api.service.js';
import type { TelegramBotApi, TelegramUpdate } from '@/shared/types.js';

/** Long-poll window: Telegram holds the request open up to this many seconds. */
const LONG_POLL_SEC = 25;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

type TelegramPollerDependencies = {
  api: TelegramBotApi;
  handleUpdate(update: TelegramUpdate): Promise<void>;
  /** Next `update_id` to ask for; persisted so a restart neither replays nor drops updates. */
  readOffset(): number | null;
  writeOffset(offset: number): void;
  /** Abortable wait used for the backoff. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  longPollSec?: number;
};

/** Default abortable sleep for the backoff. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * `getUpdates` long polling (no webhook). Used by the Telegram notifications
 * service when `MIRAGE_TELEGRAM_POLLING=1`, so test stands sharing the token
 * do not steal the live panel's updates.
 *
 * The offset is advanced past an update before it is handled: a handler that
 * throws loses that one update instead of replaying it forever. Network and
 * API failures back off exponentially (Telegram's `retry_after` wins), and
 * `stop()` aborts the in-flight poll and resolves once the loop has exited.
 */
export function createTelegramPoller(dependencies: TelegramPollerDependencies) {
  const longPollSec = dependencies.longPollSec ?? LONG_POLL_SEC;
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  const run = async (signal: AbortSignal) => {
    let backoffMs = BACKOFF_START_MS;
    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await dependencies.api.getUpdates(dependencies.readOffset(), longPollSec, signal);
        backoffMs = BACKOFF_START_MS;
      } catch (error) {
        if (signal.aborted) break;
        const retryAfterMs = error instanceof TelegramApiError && error.retryAfterSec ? error.retryAfterSec * 1000 : null;
        console.warn('[Telegram] getUpdates failed:', error instanceof Error ? error.message : 'unknown error');
        await dependencies.sleep(retryAfterMs ?? backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        continue;
      }
      for (const update of updates) {
        if (signal.aborted) break;
        dependencies.writeOffset(update.update_id + 1);
        try {
          await dependencies.handleUpdate(update);
        } catch (error) {
          console.warn('[Telegram] update handling failed:', error instanceof Error ? error.message : 'unknown error');
        }
      }
    }
  };

  return {
    isRunning(): boolean {
      return loop !== null;
    },

    start(): void {
      if (loop) return;
      controller = new AbortController();
      loop = run(controller.signal).finally(() => {
        loop = null;
        controller = null;
      });
    },

    async stop(): Promise<void> {
      const current = loop;
      controller?.abort();
      await current;
    },
  };
}
