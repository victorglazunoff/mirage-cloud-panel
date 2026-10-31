import { toPanelWall } from '@/modules/kabina/ui/panelTime';
import type { KabinaLimitWarning, SubscriptionLimits } from '@/shared/types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WEEKDAYS_UNTIL = ['воскресенья', 'понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** DarkStates L1: the week warns at 80 %, and once more at 90 %. */
const WEEK_THRESHOLDS = [90, 80];
/** DarkStates L3: credits burn in under 48 hours… */
const CREDITS_WINDOW_MS = 48 * HOUR_MS;
/** …and more than a fifth of them is still unspent. */
const CREDITS_UNSPENT_SHARE = 0.2;

function plural(count: number, forms: [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function clock(instant: Date): string {
  const date = toPanelWall(instant);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** «через 2 дн 14 ч», «через 1 ч 12 мин», «через 8 мин». */
function countdown(toMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((toMs - nowMs) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  // No-break spaces: a narrow card never leaves «мин» alone on a line.
  if (days > 0) return `через ${days}\u00a0дн ${hours}\u00a0ч`;
  if (hours > 0) return `через ${hours}\u00a0ч ${rest}\u00a0мин`;
  return `через ${rest}\u00a0мин`;
}

function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

/**
 * A reset moment rounded to the hour, for warning keys. The usage API reports `resetsAt`
 * with a drifting sub-hour part (`…00:00:00.027840`, then `…00:00:00.591007`), so the raw
 * value made the same window look new: the toast came back and «Понятно» was forgotten.
 * Same rule as the Telegram notifier's `resetHourKey`.
 */
function resetKey(resetsAt: string | null | undefined): string {
  if (!resetsAt) return 'unknown';
  const time = Date.parse(resetsAt);
  if (Number.isNaN(time)) return resetsAt;
  return new Date(Math.round(time / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13);
}

function localDayKey(ms: number): string {
  const date = toPanelWall(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function weekWarning(limits: SubscriptionLimits, nowMs: number): KabinaLimitWarning | null {
  const weekly = limits.weekly;
  if (!weekly) return null;
  // 100 % of the week is not drawn in DarkStates; it reads as a stop, in the week's words.
  if (weekly.percent >= 100) return weekExhausted(weekly.percent, weekly.resetsAt, nowMs);
  const threshold = WEEK_THRESHOLDS.find((value) => weekly.percent >= value);
  if (threshold === undefined) return null;

  const resetMs = parseTime(weekly.resetsAt);
  const percent = Math.round(weekly.percent);
  let pace = '';
  let meta = 'время сброса неизвестно';
  if (resetMs !== null) {
    const reset = new Date(resetMs);
    meta = `сброс ${WEEKDAYS_SHORT[toPanelWall(reset).getDay()]} ${clock(reset)} · ${countdown(resetMs, nowMs)}`;
    const elapsed = Math.min(1, Math.max(0, (nowMs - (resetMs - WEEK_MS)) / WEEK_MS));
    const elapsedPercent = Math.round(elapsed * 100);
    if (elapsed > 0) {
      // Linear projection of the current pace: when would the week reach 100 %?
      const exhaustMs = (resetMs - WEEK_MS) + (WEEK_MS * elapsed * 100) / weekly.percent;
      const fast = weekly.percent > elapsed * 100;
      pace = exhaustMs < resetMs
        ? `Прошло ${elapsedPercent} % недели — темп выше обычного. Хватит примерно до ${WEEKDAYS_UNTIL[toPanelWall(exhaustMs).getDay()]}.`
        : `Прошло ${elapsedPercent} % недели — ${fast ? 'темп выше обычного, но' : 'темп ровный,'} до сброса хватит.`;
    }
  }
  return {
    code: 'L1',
    key: `L1:${threshold}:${resetKey(weekly.resetsAt)}`,
    tone: 'warn',
    share: weekly.percent / 100,
    value: `${percent}%`,
    tag: 'НЕДЕЛЯ',
    title: `Израсходовано ${percent} % недели`,
    meta,
    text: `${pace ? `${pace} ` : ''}Тяжёлые фоновые задачи лучше отложить или отдать модели попроще.`,
  };
}

function weekExhausted(percent: number, resetsAt: string | null, nowMs: number): KabinaLimitWarning {
  const resetMs = parseTime(resetsAt);
  const reset = resetMs === null ? null : new Date(resetMs);
  return {
    code: 'L1',
    key: `L1:100:${resetKey(resetsAt)}`,
    tone: 'stop',
    share: 1,
    value: `${Math.round(percent)}%`,
    tag: 'НЕДЕЛЯ',
    title: 'Недельный лимит исчерпан',
    meta: reset && resetMs !== null ? `сброс ${WEEKDAYS_SHORT[toPanelWall(reset).getDay()]} ${clock(reset)} · ${countdown(resetMs, nowMs)}` : 'время сброса неизвестно',
    text: 'Новые ходы пойдут только после сброса недели. Начатые фоновые агенты не потеряны — продолжат с того же шага.',
  };
}

function creditsWarning(limits: SubscriptionLimits, nowMs: number): KabinaLimitWarning | null {
  const credits = limits.credits;
  if (!credits) return null;
  const burnMs = parseTime(credits.resetsAt);
  if (burnMs === null || burnMs <= nowMs || burnMs - nowMs > CREDITS_WINDOW_MS) return null;
  if (credits.limitDollars <= 0 || credits.remainingDollars / credits.limitDollars <= CREDITS_UNSPENT_SHARE) return null;

  const used = Math.max(0, Math.round(credits.limitDollars - credits.remainingDollars));
  const remaining = Math.floor(credits.remainingDollars);
  const hours = Math.max(1, Math.round((burnMs - nowMs) / HOUR_MS));
  const days = Math.round(hours / 24);
  const when = hours < 24 ? `через ${hours} ${plural(hours, ['час', 'часа', 'часов'])}` : `через ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
  const burn = toPanelWall(burnMs);
  const usedShare = used / credits.limitDollars;
  return {
    code: 'L3',
    // Once a day (DarkStates: «раз в день, утром»): the local date is part of the key.
    key: `L3:${resetKey(credits.resetsAt)}:${localDayKey(nowMs)}`,
    tone: 'warn',
    share: Math.min(1, usedShare),
    value: `$${used}`,
    tag: 'КРЕДИТЫ',
    title: `$${remaining} ${plural(remaining, ['сгорит', 'сгорят', 'сгорят'])} ${when}`,
    meta: `облако · $${used} из ${Math.round(credits.limitDollars)} · до ${burn.getDate()} ${MONTHS_SHORT[burn.getMonth()]}`,
    text: `${usedShare < 0.2 ? 'Использовано меньше пятой части.' : `Использовано ${Math.round(usedShare * 100)} %.`} Можно отдать облаку задачи из бэклога, пока кредиты не сгорели.`,
  };
}

/**
 * Used by the Kabina limit warnings (toast once + plaque on the home screen):
 * the DarkStates 04 rules over the subscription limits — L1 when the week
 * crosses 80 % (and again at 90 %), L3 when cloud credits burn in under 48 h
 * with more than 20 % unspent. Missing numbers simply produce no warning.
 * Mirage: no L2 («окно 5 ч») — the plan has no 5-hour window any more, so
 * `limits.session` is ignored even if the upstream ever sends it.
 */
export function computeLimitWarnings(limits: SubscriptionLimits | null, nowMs: number): KabinaLimitWarning[] {
  if (!limits || limits.status === 'unavailable' || limits.status === 'disabled') return [];
  return [weekWarning(limits, nowMs), creditsWarning(limits, nowMs)]
    .filter((warning): warning is KabinaLimitWarning => warning !== null);
}

const STORAGE_PREFIX = 'kb-limit-warning:';

/**
 * Used by the limit-warning toast watcher and the home plaques: whether this
 * browser already did `what` (`toast` shown / `hidden` by the user) for a
 * warning key. Storage can be missing or throw (private mode) — then nothing
 * is remembered and the warning simply shows again.
 */
export function readLimitWarningFlag(what: 'toast' | 'hidden', key: string): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${what}:${key}`) !== null;
  } catch {
    return false;
  }
}

/** Used next to `readLimitWarningFlag`: remembers that `what` happened for a warning key. */
export function writeLimitWarningFlag(what: 'toast' | 'hidden', key: string): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${what}:${key}`, String(Date.now()));
  } catch {
    // No storage: the warning will be shown again next time, which is harmless.
  }
}
