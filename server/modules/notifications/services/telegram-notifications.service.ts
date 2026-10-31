import path from 'node:path';

import { appConfigDb, projectsDb, sessionsDb, telegramLinkDb } from '@/modules/database/index.js';
import { mirageSettingsService } from '@/modules/mirage-settings/index.js';
import { addNotificationEventTap } from '@/modules/notifications/services/notification-orchestrator.service.js';
import { createCalendarReminderNotifier } from '@/modules/notifications/services/telegram-calendar-reminders.service.js';
import { createTelegramBotApi } from '@/modules/notifications/services/telegram-bot-api.service.js';
import { createTelegramLinkService } from '@/modules/notifications/services/telegram-link.service.js';
import { createTelegramNotifier } from '@/modules/notifications/services/telegram-notifier.service.js';
import { abortableSleep, createTelegramPoller } from '@/modules/notifications/services/telegram-polling.service.js';
import type {
  CalendarItem,
  MirageSettings,
  ProviderPermissionDecision,
  ProviderRuntimeEventListener,
  TelegramBotApi,
  TelegramLinkCode,
  TelegramLinkStatus,
  TelegramUpdate,
} from '@/shared/types.js';
import { AppError, getPanelTimeZone, getPanelTimeZoneLabel } from '@/shared/utils.js';

const OFFSET_KEY = 'mirage_telegram_update_offset';
const LIMIT_ALERTS_KEY = 'mirage_telegram_limit_alerts';
const CALENDAR_REMINDERS_KEY = 'mirage_telegram_calendar_reminders';
/** Calendar reminders are checked once a minute. */
const REMINDER_CHECK_INTERVAL_MS = 60_000;
/** Limits change slowly and the usage endpoint is unofficial: look rarely. */
const LIMIT_CHECK_INTERVAL_MS = 10 * 60_000;

type FetchLike = Parameters<typeof createTelegramBotApi>[1];
type Limits = { status: string; weekly: { percent: number; resetsAt: string | null } | null };

type TelegramNotificationsDependencies = {
  /** Reads MIRAGE_TELEGRAM_BOT_TOKEN, MIRAGE_TELEGRAM_POLLING, MIRAGE_TELEGRAM_CHAT_ID, MIRAGE_PANEL_PUBLIC_URL, MIRAGE_TIMEZONE, MIRAGE_TIMEZONE_LABEL. */
  env: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  linkStore: Parameters<typeof createTelegramLinkService>[0]['store'];
  readConfig(key: string): string | null;
  writeConfig(key: string, value: string): void;
  getSettings(): Promise<MirageSettings['notifications']>;
  getLimits(): Promise<Limits>;
  /** Calendar occurrences with a reminder in `[fromMs, toMs)` (calendar module, bound by the entrypoint). */
  listCalendarReminders(fromMs: number, toMs: number, timeZone: string): Promise<CalendarItem[]> | CalendarItem[];
  resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void;
  subscribeRuntimeEvents(listener: ProviderRuntimeEventListener): () => void;
  addEventTap(listener: (payload: { userId: number | null; event: Record<string, any> }) => void): () => void;
  describeSession(sessionId: string): { projectName: string; sessionName: string | null; panelPath: string | null };
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  approvalDelayMs?: number;
  longPollSec?: number;
};

function readEnvText(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

/**
 * The Telegram bot of the panel: wiring of the Bot API, chat linking, the
 * notifier and the optional long poll. Without `MIRAGE_TELEGRAM_BOT_TOKEN`
 * every part stays off and the status says «не настроено».
 *
 * Exported for the notifications tests, which build it with fakes; the app
 * uses `telegramNotificationsService` below.
 */
export function createTelegramNotificationsService(dependencies: TelegramNotificationsDependencies) {
  const token = readEnvText(dependencies.env, 'MIRAGE_TELEGRAM_BOT_TOKEN');
  const pollingWanted = dependencies.env.MIRAGE_TELEGRAM_POLLING === '1';
  const api: TelegramBotApi | null = token ? createTelegramBotApi(token, dependencies.fetchImpl) : null;
  let botUsername: string | null = null;
  const unsubscribers: Array<() => void> = [];
  let limitTimer: NodeJS.Timeout | null = null;
  let reminderTimer: NodeJS.Timeout | null = null;
  const timeZone = getPanelTimeZone(dependencies.env);
  const panelUrl = readEnvText(dependencies.env, 'MIRAGE_PANEL_PUBLIC_URL');

  const link = createTelegramLinkService({
    store: dependencies.linkStore,
    fallbackChatId: readEnvText(dependencies.env, 'MIRAGE_TELEGRAM_CHAT_ID'),
    now: dependencies.now,
  });

  const notifier = createTelegramNotifier({
    getApi: () => api,
    resolveTargetChat: link.resolveTargetChat,
    getSettings: dependencies.getSettings,
    resolveToolApproval: dependencies.resolveToolApproval,
    describeSession: dependencies.describeSession,
    panelUrl,
    timeZone,
    now: dependencies.now,
    schedule: dependencies.schedule,
    readLimitAlerts: () => {
      try {
        const parsed = JSON.parse(dependencies.readConfig(LIMIT_ALERTS_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
      } catch {
        return [];
      }
    },
    writeLimitAlerts: (keys) => dependencies.writeConfig(LIMIT_ALERTS_KEY, JSON.stringify(keys)),
    approvalDelayMs: dependencies.approvalDelayMs,
  });

  const calendarReminders = createCalendarReminderNotifier({
    getApi: () => api,
    resolveTargetChat: link.resolveTargetChat,
    getSettings: dependencies.getSettings,
    listReminders: dependencies.listCalendarReminders,
    readSent: () => {
      try {
        const parsed = JSON.parse(dependencies.readConfig(CALENDAR_REMINDERS_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
      } catch {
        return [];
      }
    },
    writeSent: (keys) => dependencies.writeConfig(CALENDAR_REMINDERS_KEY, JSON.stringify(keys)),
    panelUrl,
    timeZone,
    zoneLabel: getPanelTimeZoneLabel(dependencies.env),
    now: dependencies.now,
  });

  const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
    if (!api) return;
    if (update.callback_query) {
      await notifier.handleCallbackQuery(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message) return;
    const reply = link.handleMessage(message.chat, message.text);
    if (reply) {
      await api.sendMessage(String(message.chat.id), reply);
    }
  };

  const poller = api ? createTelegramPoller({
    api,
    handleUpdate,
    readOffset: () => {
      const stored = Number(dependencies.readConfig(OFFSET_KEY));
      return Number.isInteger(stored) && stored > 0 ? stored : null;
    },
    writeOffset: (offset) => dependencies.writeConfig(OFFSET_KEY, String(offset)),
    sleep: dependencies.sleep,
    longPollSec: dependencies.longPollSec,
  }) : null;

  const resolveBotUsername = async (): Promise<string | null> => {
    if (botUsername || !api) return botUsername;
    try {
      botUsername = (await api.getMe()).username;
    } catch (error) {
      console.warn('[Telegram] getMe failed:', error instanceof Error ? error.message : 'unknown error');
    }
    return botUsername;
  };

  const checkLimits = async () => {
    const settings = await dependencies.getSettings();
    // The usage endpoint is only asked when a limit message could go out.
    if (!settings.channels.telegram || !settings.events.limit80 || !link.resolveTargetChat()) return;
    const limits = await dependencies.getLimits();
    // No numbers, or the counter is off (MIRAGE_SUBSCRIPTION_LIMITS): nothing to warn about.
    if (limits.status === 'unavailable' || limits.status === 'disabled') return;
    await notifier.checkLimits({ weekly: limits.weekly });
  };

  return {
    /** Feeds one update as the poller would (used by tests). */
    handleUpdate,

    async getStatus(): Promise<TelegramLinkStatus> {
      const chat = link.resolveTargetChat();
      return {
        configured: Boolean(api),
        polling: Boolean(poller?.isRunning()),
        botUsername: await resolveBotUsername(),
        linked: Boolean(api && chat),
        linkSource: api && chat ? chat.source : null,
        chat: api && chat ? { username: chat.username, title: chat.title } : null,
        linkedAt: api && chat ? chat.linkedAt : null,
      };
    },

    async issueLinkCode(): Promise<TelegramLinkCode> {
      if (!api) {
        throw new AppError('Бот Telegram не настроен на сервере', { code: 'TELEGRAM_NOT_CONFIGURED', statusCode: 503 });
      }
      const username = await resolveBotUsername();
      if (!username) {
        throw new AppError('Telegram не ответил — попробуй ещё раз', { code: 'TELEGRAM_UNAVAILABLE', statusCode: 502 });
      }
      return link.issueCode(username);
    },

    unlink(): boolean {
      return link.unlink();
    },

    async sendTest(): Promise<void> {
      if (!api) {
        throw new AppError('Бот Telegram не настроен на сервере', { code: 'TELEGRAM_NOT_CONFIGURED', statusCode: 503 });
      }
      let sent = false;
      try {
        sent = await notifier.sendTest();
      } catch (error) {
        throw new AppError(error instanceof Error ? error.message : 'Telegram не ответил', { code: 'TELEGRAM_UNAVAILABLE', statusCode: 502 });
      }
      if (!sent) {
        throw new AppError('Telegram не привязан', { code: 'TELEGRAM_NOT_LINKED', statusCode: 409 });
      }
    },

    /** Server start: subscribes to events; polls only with MIRAGE_TELEGRAM_POLLING=1. */
    start(): void {
      if (!api || unsubscribers.length) return;
      unsubscribers.push(dependencies.subscribeRuntimeEvents((event) => notifier.handleRuntimeEvent(event)));
      unsubscribers.push(dependencies.addEventTap(({ event }) => {
        void notifier.handleNotificationEvent(event).catch((error: unknown) => {
          console.warn('[Telegram] event handling failed:', error instanceof Error ? error.message : 'unknown error');
        });
      }));
      limitTimer = setInterval(() => {
        void checkLimits().catch((error: unknown) => {
          console.warn('[Telegram] limit check failed:', error instanceof Error ? error.message : 'unknown error');
        });
      }, LIMIT_CHECK_INTERVAL_MS);
      limitTimer.unref?.();
      reminderTimer = setInterval(() => {
        void calendarReminders.tick().catch((error: unknown) => {
          console.warn('[Telegram] calendar reminders failed:', error instanceof Error ? error.message : 'unknown error');
        });
      }, REMINDER_CHECK_INTERVAL_MS);
      reminderTimer.unref?.();
      if (pollingWanted) poller?.start();
      void resolveBotUsername();
    },

    /** Server shutdown: aborts the long poll and drops subscriptions and timers. */
    async stop(): Promise<void> {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      if (limitTimer) clearInterval(limitTimer);
      limitTimer = null;
      if (reminderTimer) clearInterval(reminderTimer);
      reminderTimer = null;
      notifier.dispose();
      await poller?.stop();
    },

    /** Runs the limit check now (used by tests). */
    checkLimits,

    /** Sends the calendar reminders that are due now (the minute timer; also used by tests). */
    checkCalendarReminders: () => calendarReminders.tick(),
  };
}

function describeSession(sessionId: string) {
  const row = sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
  const project = row?.project_path ? projectsDb.getProjectPath(row.project_path) : null;
  const projectName = project?.custom_project_name?.trim()
    || (row?.project_path ? path.basename(row.project_path) : '')
    || 'Claude';
  const appSessionId = row?.session_id ?? sessionId;
  const panelPath = project
    ? `/p/${encodeURIComponent(project.project_id)}/s/${encodeURIComponent(appSessionId)}`
    : `/session/${encodeURIComponent(appSessionId)}`;
  return { projectName, sessionName: row?.custom_name?.trim() || null, panelPath };
}

/**
 * What the bot needs from the providers and home modules. Handed in by the
 * server entrypoint instead of imported: the providers runtime imports this
 * module's barrel, so importing it back here would be a load-time cycle.
 */
type TelegramRuntimeBindings = {
  subscribeRuntimeEvents(listener: ProviderRuntimeEventListener): () => void;
  resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void;
  getLimits(): Promise<Limits>;
  listCalendarReminders(fromMs: number, toMs: number, timeZone: string): CalendarItem[];
};

// Until the entrypoint binds the runtime (e.g. routes exercised in isolation),
// there are no permission prompts to relay and no limits to read.
let runtimeBindings: TelegramRuntimeBindings = {
  subscribeRuntimeEvents: () => () => {},
  resolveToolApproval: () => {},
  getLimits: async () => ({ status: 'unavailable', weekly: null }),
  listCalendarReminders: () => [],
};

let defaultService: ReturnType<typeof createTelegramNotificationsService> | null = null;

/**
 * The app's Telegram service, built on first use so the environment is read
 * after the server loaded its .env. Used by the Telegram routes and the
 * start/shutdown hooks below.
 */
export function getTelegramNotificationsService(): ReturnType<typeof createTelegramNotificationsService> {
  defaultService ??= createTelegramNotificationsService({
    env: process.env,
    linkStore: telegramLinkDb,
    readConfig: (key) => appConfigDb.get(key),
    writeConfig: (key, value) => appConfigDb.set(key, value),
    getSettings: async () => (await mirageSettingsService.getSettings()).settings.notifications,
    getLimits: () => runtimeBindings.getLimits(),
    listCalendarReminders: (fromMs, toMs, zone) => runtimeBindings.listCalendarReminders(fromMs, toMs, zone),
    resolveToolApproval: (requestId, decision) => runtimeBindings.resolveToolApproval(requestId, decision),
    subscribeRuntimeEvents: (listener) => runtimeBindings.subscribeRuntimeEvents(listener),
    addEventTap: (listener) => addNotificationEventTap(listener),
    describeSession,
    now: () => Date.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    sleep: abortableSleep,
  });
  return defaultService;
}

/**
 * Called by the server entrypoint once the database is ready, with the
 * providers runtime (permission prompts and answers) and the home module's
 * subscription limits, and the calendar's reminders.
 */
export function initializeTelegramNotifications(bindings: TelegramRuntimeBindings): void {
  runtimeBindings = bindings;
  getTelegramNotificationsService().start();
}

/** Called by the server entrypoint on SIGTERM/SIGINT. */
export async function stopTelegramNotifications(): Promise<void> {
  await defaultService?.stop();
}
