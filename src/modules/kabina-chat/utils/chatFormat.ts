import { toPanelWall } from '@/modules/kabina';
import { getServerHomeDir, tildePath } from '@/shared/utils';

/** Number formats of the chat screen: tokens «165k», «1M», sizes «38 МБ», times «06:12», dates «вчера 19:40». */

/** 165000 → «165k», 1000000 → «1M», 2400000 → «2.4M», 800 → «800». */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 || Number.isInteger(millions) ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 100 || Number.isInteger(thousands) ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  return String(Math.round(value));
}

/**
 * Project folder under the project name, short as in the mock-up: «<home>/…/demo-site» →
 * «~/demo-site» (the server user's home); a deep folder outside the home — «…/e2e-project».
 */
export function shortProjectPath(fullPath: string, home: string | null = getServerHomeDir()): string {
  const path = fullPath.replace(/\/+$/, '');
  const tilde = tildePath(path, home);
  if (tilde === '~') return '~';
  const parts = path.split('/').filter(Boolean);
  if (tilde.startsWith('~/')) return `~/${parts[parts.length - 1]}`;
  return parts.length > 2 ? `…/${parts[parts.length - 1]}` : path || '/';
}

/** Percent with one decimal below 10 («9.6%»), whole above («17%»). */
export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '0%';
  return `${value < 10 && decimals ? value.toFixed(decimals) : Math.round(value)}%`;
}

/** Bytes → «38 МБ» / «340 МБ» / «812 КБ». */
export function formatMegabytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} МБ`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** A transcript this big makes every turn slow and expensive: the list says «большая — начни новый». */
export const BIG_SESSION_BYTES = 150 * 1024 * 1024;

/** Elapsed milliseconds → «06:12» (or «1:02:05» past an hour). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours ? `${hours}:${mmss}` : mmss;
}

/** «1 ч 12 мин», «14 мин», «40 с» — the session length in the dialog head. */
export function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.floor(ms / 1000))} с`;
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 48) return `${Math.floor(hours / 24)} дн`;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * «сейчас», «14:32», «вчера 19:40», «18 окт» — the session list's time column, on the
 * panel's wall clock (panelTime), so «вчера» and the hour match the header clock.
 */
export function formatSessionTime(value: string | undefined, now: Date = new Date()): string {
  if (!value) return '';
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const diff = now.getTime() - instant.getTime();
  if (diff >= 0 && diff < 60_000) return 'сейчас';
  const date = toPanelWall(instant);
  const today = toPanelWall(now);
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (date.getTime() >= startOfToday) return hhmm;
  if (date.getTime() >= startOfToday - 86_400_000) return `вчера ${hhmm}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** 1 → «субагент», 2 → «субагента», 5 → «субагентов». */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
