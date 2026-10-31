import { randomBytes } from 'node:crypto';

import type {
  MirageSettings,
  ProviderPermissionDecision,
  ProviderRuntimeEvent,
  TelegramBotApi,
  TelegramInlineButton,
  TelegramTargetChat,
  TelegramUpdate,
} from '@/shared/types.js';

type NotificationSettings = MirageSettings['notifications'];

/** DarkStates N1: «нужно решение — через 2 мин без ответа в панели». */
const DEFAULT_APPROVAL_DELAY_MS = 2 * 60_000;
/** DarkStates N1: «ход закончен — только долгий, дольше 5 мин». */
const DEFAULT_LONG_TURN_MS = 5 * 60_000;
/** The orchestrator can report one stop twice in a row (result + process end). */
const EVENT_DEDUPE_MS = 20_000;
/** Answered approval messages are kept this long so a late button press still gets «уже не актуально». */
const APPROVAL_MEMORY_MS = 24 * 60 * 60_000;
/** Turn lengths waiting for their «run.stopped»; the oldest goes first past this. */
const TURN_DURATION_MEMORY = 200;
const LIMIT_THRESHOLDS = [100, 80] as const;
const MAX_REMEMBERED_LIMIT_ALERTS = 40;
const INPUT_SUMMARY_LENGTH = 300;

/** What the orchestrator's event tap hands over (see notification-orchestrator.service.js). */
type OrchestratorEvent = {
  provider?: string | null;
  sessionId?: string | null;
  code?: string;
  meta?: { stopReason?: string; sessionName?: string | null } & Record<string, unknown>;
};

type LimitWindow = { percent: number; resetsAt: string | null } | null;

/** Where a session lives, for message headers and the «Открыть в панели» link. */
type SessionDescription = { projectName: string; sessionName: string | null; panelPath: string | null };

type TelegramNotifierDependencies = {
  getApi(): TelegramBotApi | null;
  resolveTargetChat(): TelegramTargetChat | null;
  getSettings(): Promise<NotificationSettings>;
  resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void;
  describeSession(sessionId: string): SessionDescription;
  /** Public panel origin (`MIRAGE_PANEL_PUBLIC_URL`) for link buttons; null hides them. */
  panelUrl: string | null;
  timeZone: string;
  now(): number;
  /** setTimeout seam: returns the cancel function. */
  schedule(callback: () => void, delayMs: number): () => void;
  readLimitAlerts(): string[];
  writeLimitAlerts(keys: string[]): void;
  approvalDelayMs?: number;
  longTurnMs?: number;
};

type ApprovalEntry = {
  shortId: string;
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  requestedAt: number;
  cancelTimer: (() => void) | null;
  /** Set once the message is out. */
  sent: { chatId: string; messageId: number; text: string } | null;
  /** Set once the prompt is answered anywhere; the message is final after that. */
  settled: boolean;
  settledAt: number | null;
};

function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function minutesOfDay(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(instantMs));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return read('hour') * 60 + read('minute');
}

/**
 * Whether `instantMs` falls inside the quiet hours (wall clock in `timeZone`).
 * `from > to` wraps past midnight (23:00–08:00); `from === to` is never quiet.
 * Exported for the notifier tests only.
 */
export function isWithinQuietHours(quietHours: NotificationSettings['quietHours'], instantMs: number, timeZone: string): boolean {
  if (!quietHours.enabled) return false;
  const from = parseClock(quietHours.from);
  const to = parseClock(quietHours.to);
  if (from === null || to === null || from === to) return false;
  const now = minutesOfDay(instantMs, timeZone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

function formatClock(instantMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instantMs));
}

function formatReset(resetsAt: string | null, timeZone: string): string | null {
  const ms = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'short' }).format(new Date(ms));
  return `${weekday} ${formatClock(ms, timeZone)}`;
}

function minutesText(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} мин`;
}

/** One line on what the tool wants to do: the command, the file, or compact JSON. */
function summarizeToolInput(toolName: string, input: unknown): string {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  const pick = ['command', 'file_path', 'path', 'url', 'pattern', 'description']
    .map((key) => record?.[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  let summary = pick ?? '';
  if (!summary && input !== undefined && input !== null) {
    try {
      summary = typeof input === 'string' ? input : JSON.stringify(input);
    } catch {
      summary = '';
    }
  }
  summary = summary.replace(/\s+/g, ' ').trim();
  if (summary.length > INPUT_SUMMARY_LENGTH) summary = `${summary.slice(0, INPUT_SUMMARY_LENGTH - 1)}…`;
  return summary ? `${toolName}: ${summary}` : toolName;
}

/**
 * Turns panel events into bot messages and the bot's buttons back into
 * permission answers. Used by the Telegram notifications service, which feeds
 * it runtime events, orchestrator events, limits and callback queries.
 *
 * Rules (DarkStates N1, DarkSettings 04):
 * - nothing is sent unless the Telegram channel is on and a chat is known;
 * - each event kind has its own switch in `notifications.events`;
 * - quiet hours mute everything except «нужно подтверждение», which is urgent;
 * - an approval is sent only if it is still unanswered 2 minutes later.
 */
export function createTelegramNotifier(dependencies: TelegramNotifierDependencies) {
  const approvalDelayMs = dependencies.approvalDelayMs ?? DEFAULT_APPROVAL_DELAY_MS;
  const longTurnMs = dependencies.longTurnMs ?? DEFAULT_LONG_TURN_MS;
  const approvalsByRequest = new Map<string, ApprovalEntry>();
  const approvalsByShortId = new Map<string, ApprovalEntry>();
  const lastTurnDurationMs = new Map<string, number>();
  const recentEvents = new Map<string, number>();

  const logFailure = (what: string, error: unknown) => {
    // Bot API errors carry Telegram's description only, never the token.
    console.warn(`[Telegram] ${what} failed:`, error instanceof Error ? error.message : 'unknown error');
  };

  /** Resolves where to send, or null when the channel is off, the bot unconfigured or no chat known. */
  const resolveDelivery = async (kind: keyof NotificationSettings['events']) => {
    const api = dependencies.getApi();
    const chat = dependencies.resolveTargetChat();
    if (!api || !chat) return null;
    const settings = await dependencies.getSettings();
    if (!settings.channels.telegram || !settings.events[kind]) return null;
    if (kind !== 'approvalNeeded' && isWithinQuietHours(settings.quietHours, dependencies.now(), dependencies.timeZone)) {
      return null;
    }
    return { api, chat };
  };

  const panelLink = (path: string | null, text: string): TelegramInlineButton[][] => {
    if (!dependencies.panelUrl || !path) return [];
    return [[{ text, url: `${dependencies.panelUrl.replace(/\/+$/, '')}${path}` }]];
  };

  /**
   * Answered requests are kept for a day (a late button press is told «уже не
   * актуально»); one never settled — its run died without a settlement — is
   * dropped a day after it was asked, so neither kind piles up.
   */
  const forgetOldApprovals = () => {
    const cutoff = dependencies.now() - APPROVAL_MEMORY_MS;
    for (const entry of approvalsByRequest.values()) {
      const stale = entry.settled ? (entry.settledAt ?? 0) < cutoff : entry.requestedAt < cutoff;
      if (stale) {
        entry.cancelTimer?.();
        approvalsByRequest.delete(entry.requestId);
        approvalsByShortId.delete(entry.shortId);
      }
    }
  };

  const sendApproval = async (entry: ApprovalEntry) => {
    entry.cancelTimer = null;
    if (entry.settled) return;
    const delivery = await resolveDelivery('approvalNeeded');
    if (!delivery || entry.settled) return;
    const session = dependencies.describeSession(entry.sessionId);
    const waited = minutesText(dependencies.now() - entry.requestedAt);
    const text = [
      `◆ ${session.projectName} ждёт тебя`,
      summarizeToolInput(entry.toolName, entry.input),
      [session.sessionName, `ждёт ${waited}`].filter(Boolean).join(' · '),
    ].join('\n');
    const keyboard: TelegramInlineButton[][] = [
      [
        { text: 'Разрешить один раз', callbackData: `ok:${entry.shortId}` },
        { text: 'Отклонить', callbackData: `no:${entry.shortId}` },
      ],
      ...panelLink(session.panelPath, 'Открыть в панели'),
    ];
    try {
      const { messageId } = await delivery.api.sendMessage(delivery.chat.chatId, text, keyboard);
      entry.sent = { chatId: delivery.chat.chatId, messageId, text };
      // Answered in the panel while the message was on its way.
      if (entry.settled) await markStale(entry, 'уже не актуально');
    } catch (error) {
      logFailure('approval message', error);
    }
  };

  const markStale = async (entry: ApprovalEntry, note: string) => {
    const api = dependencies.getApi();
    if (!api || !entry.sent) return;
    try {
      await api.editMessageText(entry.sent.chatId, entry.sent.messageId, `${entry.sent.text}\n\n— ${note}`);
    } catch (error) {
      logFailure('approval message edit', error);
    }
  };

  const sendSimple = async (kind: keyof NotificationSettings['events'], text: string, keyboard: TelegramInlineButton[][]) => {
    const delivery = await resolveDelivery(kind);
    if (!delivery) return;
    try {
      await delivery.api.sendMessage(delivery.chat.chatId, text, keyboard.length ? keyboard : undefined);
    } catch (error) {
      logFailure(`${kind} message`, error);
    }
  };

  const isRepeat = (key: string): boolean => {
    const now = dependencies.now();
    for (const [seenKey, at] of recentEvents) {
      if (now - at > EVENT_DEDUPE_MS) recentEvents.delete(seenKey);
    }
    if (recentEvents.has(key)) return true;
    recentEvents.set(key, now);
    return false;
  };

  return {
    /** Runtime tap: permission prompts (with their request ids) and turn durations. */
    handleRuntimeEvent(event: ProviderRuntimeEvent): void {
      if (event.type === 'permission_requested') {
        forgetOldApprovals();
        const entry: ApprovalEntry = {
          shortId: randomBytes(6).toString('base64url'),
          requestId: event.requestId,
          sessionId: event.sessionId,
          toolName: event.toolName,
          input: event.input,
          requestedAt: dependencies.now(),
          cancelTimer: null,
          sent: null,
          settled: false,
          settledAt: null,
        };
        approvalsByRequest.set(entry.requestId, entry);
        approvalsByShortId.set(entry.shortId, entry);
        entry.cancelTimer = dependencies.schedule(() => {
          // A timer callback has no caller to reject to: an unread settings row or
          // a database error here would otherwise take the whole server down.
          void sendApproval(entry).catch((error: unknown) => {
            console.warn('[Telegram] approval message failed:', error instanceof Error ? error.message : 'unknown error');
          });
        }, approvalDelayMs);
        return;
      }
      if (event.type === 'permission_settled') {
        forgetOldApprovals();
        const entry = approvalsByRequest.get(event.requestId);
        if (!entry || entry.settled) return;
        entry.settled = true;
        entry.settledAt = dependencies.now();
        entry.cancelTimer?.();
        entry.cancelTimer = null;
        const note = event.outcome === 'allowed' ? 'разрешено в панели'
          : event.outcome === 'denied' ? 'отклонено в панели' : 'уже не актуально';
        void markStale(entry, note);
        return;
      }
      if (event.type === 'sdk_message' && event.message?.type === 'result') {
        const duration = Number(event.message.duration_ms);
        if (Number.isFinite(duration)) {
          lastTurnDurationMs.delete(event.sessionId);
          lastTurnDurationMs.set(event.sessionId, duration);
          // Read once by the turn's «run.stopped»; a turn that never reports one
          // must not keep its entry for the server's lifetime.
          if (lastTurnDurationMs.size > TURN_DURATION_MEMORY) {
            lastTurnDurationMs.delete(lastTurnDurationMs.keys().next().value as string);
          }
        }
      }
    },

    /** Orchestrator tap: «ход закончен» and «фоновая работа завершена». */
    async handleNotificationEvent(event: OrchestratorEvent): Promise<void> {
      const sessionId = event.sessionId ?? null;
      // The length belongs to the turn that just stopped, whatever the reason:
      // taken here, so a later turn without its own result does not reuse it.
      const duration = event.code === 'run.stopped' && sessionId ? lastTurnDurationMs.get(sessionId) : undefined;
      if (event.code === 'run.stopped' && sessionId) lastTurnDurationMs.delete(sessionId);
      if (event.code === 'run.stopped' && event.meta?.stopReason === 'completed') {
        if (isRepeat(`turn:${sessionId}`)) return;
        // Short turns are not worth a phone buzz; an unknown length is reported.
        if (duration !== undefined && duration < longTurnMs) return;
        const session = sessionId ? dependencies.describeSession(sessionId) : null;
        const headline = `✓ ${session?.projectName ?? 'Claude'} — ход закончен`;
        const detail = [session?.sessionName ?? event.meta?.sessionName ?? null, duration !== undefined ? minutesText(duration) : null]
          .filter(Boolean).join(' · ');
        await sendSimple('turnComplete', detail ? `${headline}\n${detail}` : headline, panelLink(session?.panelPath ?? null, 'Открыть в панели'));
        return;
      }
      if (event.code === 'run.background_completed') {
        if (isRepeat(`background:${sessionId}`)) return;
        const session = sessionId ? dependencies.describeSession(sessionId) : null;
        const detail = ['Фоновая работа завершена', session?.sessionName ?? event.meta?.sessionName ?? null].filter(Boolean).join(' · ');
        await sendSimple('backgroundDone', `✓ ${session?.projectName ?? 'Claude'} — готово\n${detail}`, panelLink(session?.panelPath ?? null, 'Открыть итог'));
      }
    },

    /**
     * Limit check: 80 % and 100 % of the week, once per window (keyed by its
     * reset time) and threshold. Mirage: the 5-hour window is not reported —
     * the plan has none any more (`five_hour: null`). A crossing muted by
     * quiet hours or a disabled switch is not remembered, so it is sent on a
     * later check if it still holds.
     */
    async checkLimits(limits: { weekly: LimitWindow }): Promise<void> {
      const windows = [{ name: 'weekly', label: 'Неделя', window: limits.weekly }];
      const remembered = new Set(dependencies.readLimitAlerts());
      let changed = false;
      for (const { name, label, window } of windows) {
        if (!window) continue;
        const threshold = LIMIT_THRESHOLDS.find((value) => window.percent >= value);
        if (!threshold) continue;
        // The usage API reports resetsAt with a drifting sub-hour part (seconds, milliseconds,
        // sometimes minutes), so the raw value made every check look like a new window and
        // re-sent the same alert every 10 minutes. The window is identified by its reset hour.
        const keyFor = (value: number) => `${name}:${resetHourKey(window.resetsAt)}:${value}`;
        if (remembered.has(keyFor(threshold))) continue;
        const delivery = await resolveDelivery('limit80');
        if (!delivery) return;
        const reset = formatReset(window.resetsAt, dependencies.timeZone);
        const text = [
          threshold >= 100 ? `▲ ${label}: лимит исчерпан` : `▲ ${label}: ${Math.round(window.percent)} % лимита`,
          reset ? `сброс ${reset}` : null,
        ].filter(Boolean).join('\n');
        try {
          await delivery.api.sendMessage(delivery.chat.chatId, text);
        } catch (error) {
          logFailure('limit message', error);
          continue;
        }
        // A higher threshold implies the lower ones for this window.
        for (const value of LIMIT_THRESHOLDS) {
          if (value <= threshold) remembered.add(keyFor(value));
        }
        changed = true;
      }
      if (changed) {
        dependencies.writeLimitAlerts([...remembered].slice(-MAX_REMEMBERED_LIMIT_ALERTS));
      }
    },

    /** Inline buttons: «Разрешить один раз» / «Отклонить», only from the target chat. */
    async handleCallbackQuery(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
      const api = dependencies.getApi();
      if (!api) return;
      const chat = dependencies.resolveTargetChat();
      const fromChatId = query.message ? String(query.message.chat.id) : null;
      const answer = async (text: string) => {
        try {
          await api.answerCallbackQuery(query.id, text);
        } catch (error) {
          logFailure('callback answer', error);
        }
      };
      if (!chat || fromChatId !== chat.chatId) {
        await answer('Нет доступа');
        return;
      }
      const match = /^(ok|no):([\w-]+)$/.exec(query.data ?? '');
      const entry = match ? approvalsByShortId.get(match[2]) : undefined;
      if (!match || !entry || entry.settled) {
        await answer('Уже не актуально');
        if (query.message && !entry) {
          // Unknown id (e.g. the server restarted): drop the dead buttons.
          try {
            await api.editMessageText(chat.chatId, query.message.message_id, 'Уже не актуально — запрос закрыт.');
          } catch (error) {
            logFailure('stale message edit', error);
          }
        }
        return;
      }
      const allow = match[1] === 'ok';
      // Mark first: resolving publishes permission_settled synchronously.
      entry.settled = true;
      entry.settledAt = dependencies.now();
      entry.cancelTimer?.();
      dependencies.resolveToolApproval(entry.requestId, allow
        ? { allow: true }
        : { allow: false, message: 'Отклонено из Telegram' });
      await answer(allow ? 'Разрешено' : 'Отклонено');
      const stamp = formatClock(dependencies.now(), dependencies.timeZone);
      const text = entry.sent?.text ?? summarizeToolInput(entry.toolName, entry.input);
      try {
        await api.editMessageText(chat.chatId, query.message?.message_id ?? entry.sent?.messageId ?? 0,
          `${text}\n\n${allow ? '✓ разрешено из Telegram' : '✕ отклонено из Telegram'} · ${stamp}`);
      } catch (error) {
        logFailure('approval message edit', error);
      }
    },

    /** «Прислать тестовое» (DarkSettings 04): ignores switches and quiet hours on purpose. */
    async sendTest(): Promise<boolean> {
      const api = dependencies.getApi();
      const chat = dependencies.resolveTargetChat();
      if (!api || !chat) return false;
      await api.sendMessage(chat.chatId, '✓ Проверка связи: уведомления панели Mirage приходят сюда.');
      return true;
    },

    /** Cancels pending approval timers (server shutdown). */
    dispose(): void {
      for (const entry of approvalsByRequest.values()) entry.cancelTimer?.();
      approvalsByRequest.clear();
      approvalsByShortId.clear();
    },
  };
}

/** The notifier's shape, for the notifications service that wires it. */
export type TelegramNotifier = ReturnType<typeof createTelegramNotifier>;

/** A reset moment rounded to the hour: stable across the drift of the usage API. */
function resetHourKey(resetsAt: string | null | undefined): string {
  if (!resetsAt) return 'none';
  const time = Date.parse(resetsAt);
  if (Number.isNaN(time)) return resetsAt;
  return new Date(Math.round(time / 3_600_000) * 3_600_000).toISOString().slice(0, 13);
}
