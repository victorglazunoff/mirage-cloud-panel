import type { CalendarItem, MirageSettings, TelegramBotApi, TelegramInlineButton, TelegramTargetChat } from '@/shared/types.js';

const MINUTE_MS = 60_000;
/** After a restart or a missed tick, a reminder still goes out if it fell due this recently (and the event has not started). */
const CATCH_UP_MS = 10 * MINUTE_MS;
/** The longest reminder the calendar accepts (7 days), so every due reminder is inside the lookup window. */
const MAX_REMINDER_MS = 7 * 24 * 60 * MINUTE_MS;
/** Sent keys are forgotten a day after their event started. */
const SENT_MEMORY_MS = 24 * 60 * MINUTE_MS;
const MAX_REMEMBERED = 500;

const TYPE_LABELS: Partial<Record<CalendarItem['type'], string>> = {
  call: 'Звонок',
  message: 'Написать',
  meeting: 'Встреча',
  agent_task: 'Задача Claude',
};

type CalendarRemindersDependencies = {
  getApi(): TelegramBotApi | null;
  resolveTargetChat(): TelegramTargetChat | null;
  getSettings(): Promise<MirageSettings['notifications']>;
  /** Occurrences in `[fromMs, toMs)` of planned events with a reminder (calendar module). */
  listReminders(fromMs: number, toMs: number, timeZone: string): Promise<CalendarItem[]> | CalendarItem[];
  /** Keys of reminders already sent, persisted so a restart does not repeat them. */
  readSent(): string[];
  writeSent(keys: string[]): void;
  panelUrl: string | null;
  timeZone: string;
  /** Caption after the time («15:15 ЕКБ», `MIRAGE_TIMEZONE_LABEL`); null — the zone's UTC offset («15:15 UTC+5»). */
  zoneLabel: string | null;
  now(): number;
};

/** «event@2026-10-26T06:00:00.000Z#15» — one reminder of one occurrence; a changed time or lead is a new reminder. */
function reminderKey(item: CalendarItem): string {
  return `${item.id.split('@')[0]}@${item.startsAt}#${item.remindBeforeMin}`;
}

function wallParts(instantMs: number, timeZone: string): { clock: string; date: string } {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', day: '2-digit', month: '2-digit',
  }).formatToParts(new Date(instantMs));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { clock: `${read('hour')}:${read('minute')}`, date: `${read('day')}.${read('month')}` };
}

/** «UTC+5», «UTC−3:30», «UTC» — the caption of a zone that has no `MIRAGE_TIMEZONE_LABEL`. */
function utcOffsetLabel(instantMs: number, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(instantMs))
    .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  return name === 'GMT' || name === 'GMT+0' ? 'UTC' : name.replace(/^GMT/, 'UTC').replace('-', '−');
}

function isoDate(instantMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(instantMs));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function leadText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  if (minutes === 0) return 'Сейчас';
  if (minutes < 60) return `Через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return `Через ${hours} ч${rest ? ` ${rest} мин` : ''}`;
  const days = Math.round(hours / 24);
  return `Через ${days} дн`;
}

/** The bot message for one reminder. Exported for the tests. */
export function formatCalendarReminder(item: CalendarItem, nowMs: number, timeZone: string, zoneLabel: string | null): string {
  const startMs = Date.parse(item.startsAt);
  const when = wallParts(startMs, timeZone);
  const today = isoDate(nowMs, timeZone) === isoDate(startMs, timeZone);
  const contact = item.contact;
  const lines = [
    `⏰ ${leadText(startMs - nowMs)} · ${today ? '' : `${when.date} `}${when.clock} ${zoneLabel ?? utcOffsetLabel(startMs, timeZone)}`,
    `${TYPE_LABELS[item.type] ?? 'Событие'}: ${item.title}`,
    contact ? [contact.name, contact.phone, contact.telegram].filter(Boolean).join(' · ') : null,
    item.location,
    item.projectName ? `проект ${item.projectName}` : null,
  ];
  return lines.filter((line): line is string => Boolean(line && line.trim())).join('\n');
}

/**
 * Telegram reminders of the panel calendar (`remindBeforeMin` of an event):
 * once a minute the bot looks for reminders that fell due and sends each one
 * once — the sent keys survive restarts. Only the Telegram channel switch
 * applies: a reminder is set by hand for one event, so neither the event
 * switches nor the quiet hours mute it (it is an alarm, not a status).
 *
 * Used by the Telegram notifications service, which ticks it every minute.
 */
export function createCalendarReminderNotifier(dependencies: CalendarRemindersDependencies) {
  let running = false;

  const tick = async (): Promise<number> => {
    if (running) return 0;
    const api = dependencies.getApi();
    const chat = dependencies.resolveTargetChat();
    if (!api || !chat) return 0;
    running = true;
    try {
      const settings = await dependencies.getSettings();
      if (!settings.channels.telegram) return 0;
      const nowMs = dependencies.now();
      const items = await dependencies.listReminders(nowMs - CATCH_UP_MS, nowMs + MAX_REMINDER_MS + MINUTE_MS, dependencies.timeZone);
      const sent = new Set(dependencies.readSent());
      let sentCount = 0;
      let changed = false;

      // Forget reminders of events that started more than a day ago.
      for (const key of sent) {
        const startIso = key.slice(key.indexOf('@') + 1, key.lastIndexOf('#'));
        const startMs = Date.parse(startIso);
        if (!Number.isFinite(startMs) || startMs < nowMs - SENT_MEMORY_MS) {
          sent.delete(key);
          changed = true;
        }
      }

      for (const item of items) {
        if (item.remindBeforeMin === null || item.status !== 'planned') continue;
        const startMs = Date.parse(item.startsAt);
        const dueMs = startMs - item.remindBeforeMin * MINUTE_MS;
        // Due now, not long overdue, and the event itself is still ahead (or starting this minute).
        if (dueMs > nowMs || dueMs < nowMs - CATCH_UP_MS || startMs < nowMs - MINUTE_MS) continue;
        const key = reminderKey(item);
        if (sent.has(key)) continue;
        const keyboard: TelegramInlineButton[][] = dependencies.panelUrl
          ? [[{
            text: 'Открыть в календаре',
            url: `${dependencies.panelUrl.replace(/\/+$/, '')}/calendar?event=${encodeURIComponent(item.id)}&date=${isoDate(startMs, dependencies.timeZone)}`,
          }]]
          : [];
        try {
          await api.sendMessage(chat.chatId, formatCalendarReminder(item, nowMs, dependencies.timeZone, dependencies.zoneLabel), keyboard.length ? keyboard : undefined);
        } catch (error) {
          // Not remembered: the next tick tries again while the reminder is still within the catch-up window.
          console.warn('[Telegram] calendar reminder failed:', error instanceof Error ? error.message : 'unknown error');
          continue;
        }
        sent.add(key);
        sentCount += 1;
        changed = true;
      }

      if (changed) dependencies.writeSent([...sent].slice(-MAX_REMEMBERED));
      return sentCount;
    } finally {
      running = false;
    }
  };

  return { tick };
}
