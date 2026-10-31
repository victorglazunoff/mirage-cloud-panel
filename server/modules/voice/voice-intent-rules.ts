import { toNominativeFullName } from '@/modules/calendar/index.js';
import type { VoiceIntentAction, VoiceIntentRecipient } from '@/shared/types.js';

const WEEKDAYS: Array<[RegExp, number]> = [
  [/понедельник/, 1], [/вторник/, 2], [/сред[уы]/, 3], [/четверг/, 4],
  [/пятниц/, 5], [/суббот/, 6], [/воскресень/, 0],
];
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[яй]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const CALENDAR_WORDS = /(встреч|созвон|звонок|позвони|напомни|напоминани|в календарь|назначь|запланируй|записать на)/;
const TASK_WORDS = /(в проект|для проекта|в проекте|задач[уаи]|поставь|пусть клод|попроси клод|пусть claude)/;
const NOT_A_PERSON = new Set(['утра', 'вечера', 'дня', 'ночи', 'завтра', 'сегодня', 'понедельника', 'пятницы']);

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** ISO 8601 with the local UTC offset of `date`, e.g. `2026-10-27T15:00:00+05:00`. */
function toLocalIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Extracts a date and time from Russian speech relative to `now`. Returns the ISO start,
 * the matched phrase and whether a clock time was found. Understands today/tomorrow/day
 * after tomorrow, weekdays, "через N дней/часов/минут", "27 октября", "в 15:00",
 * "в 3 часа дня". Exported for Voice tests.
 */
export function parseSpokenTime(text: string, now: Date): { start: string | null; phrase: string | null } {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  const base = new Date(now);
  const phrases: string[] = [];
  let hasDay = false;
  let hasTime = false;

  const relative = lower.match(/через\s+(\d+|полчаса|час|минут[уы]?)\s*(минут|час|дн|недел)?/);
  if (relative) {
    const amount = /^\d+$/.test(relative[1]) ? Number(relative[1]) : 1;
    const unit = relative[2] ?? (relative[1].startsWith('час') ? 'час' : 'минут');
    const result = new Date(now);
    if (relative[1] === 'полчаса') result.setMinutes(result.getMinutes() + 30);
    else if (unit.startsWith('минут')) result.setMinutes(result.getMinutes() + amount);
    else if (unit.startsWith('час')) result.setHours(result.getHours() + amount);
    else if (unit.startsWith('дн')) { result.setDate(result.getDate() + amount); result.setSeconds(0, 0); }
    else result.setDate(result.getDate() + amount * 7);
    result.setSeconds(0, 0);
    return { start: toLocalIso(result), phrase: relative[0] };
  }

  if (/послезавтра/.test(lower)) { base.setDate(base.getDate() + 2); hasDay = true; phrases.push('послезавтра'); }
  else if (/завтра/.test(lower)) { base.setDate(base.getDate() + 1); hasDay = true; phrases.push('завтра'); }
  else if (/сегодня/.test(lower)) { hasDay = true; phrases.push('сегодня'); }
  else {
    const dateMatch = lower.match(new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})`));
    const dotted = lower.match(/(\d{1,2})\.(\d{2})(?!\d|:)/);
    if (dateMatch) {
      const month = MONTHS.findIndex((pattern) => new RegExp(`^(${pattern})`).test(dateMatch[2]));
      base.setMonth(month, Number(dateMatch[1]));
      if (base.getTime() < now.getTime() - 86_400_000) base.setFullYear(base.getFullYear() + 1);
      hasDay = true; phrases.push(dateMatch[0]);
    } else if (dotted) {
      base.setMonth(Number(dotted[2]) - 1, Number(dotted[1]));
      if (base.getTime() < now.getTime() - 86_400_000) base.setFullYear(base.getFullYear() + 1);
      hasDay = true; phrases.push(dotted[0]);
    } else {
      for (const [pattern, weekday] of WEEKDAYS) {
        const match = lower.match(pattern);
        if (!match) continue;
        const delta = ((weekday - now.getDay() + 7) % 7) || 7;
        base.setDate(base.getDate() + delta);
        hasDay = true; phrases.push(match[0]);
        break;
      }
    }
  }

  const clock = lower.match(/(?:в|к|на)\s+(\d{1,2})(?:[:.\s](\d{2}))?(?!\d)\s*(?:час(?:а|ов)?)?\s*(утра|дня|вечера|ночи)?/);
  if (clock && Number(clock[1]) <= 24) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const period = clock[3];
    if ((period === 'дня' || period === 'вечера') && hour < 12) hour += 12;
    if (period === 'ночи' && hour === 12) hour = 0;
    if (minute < 60) {
      base.setHours(hour % 24, minute, 0, 0);
      hasTime = true; phrases.push(clock[0].trim());
    }
  }

  if (!hasDay && !hasTime) return { start: null, phrase: null };
  if (!hasTime) base.setHours(9, 0, 0, 0);
  else if (!hasDay && base.getTime() <= now.getTime()) base.setDate(base.getDate() + 1);
  base.setSeconds(0, 0);
  return { start: toLocalIso(base), phrase: phrases.join(' ') };
}

function findPeople(text: string, typeIsMeeting: boolean): string[] {
  const people: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)с(?:о)?\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/g)) people.push(toNominativeFullName(match[1]));
  // «позвонить Ивану», «написать Марии», «напомнить Петру»: the addressee in the dative.
  const verbPattern = /(?:^|\s)(?:[Пп]озвони\p{L}*|[Пп]ерезвони\p{L}*|[Нн]абери|[Нн]абрать|[Нн]апиши|[Нн]аписать|[Нн]апомни\p{L}*)\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/gu;
  for (const match of text.matchAll(verbPattern)) {
    const name = toNominativeFullName(match[1]);
    if (!people.includes(name)) people.push(name);
  }
  if (people.length === 0 && typeIsMeeting) {
    const lowercase = text.match(/(?:^|\s)с(?:о)?\s+([а-яё]{3,})/);
    if (lowercase && !NOT_A_PERSON.has(lowercase[1]) && !/^\d/.test(lowercase[1])) people.push(lowercase[1]);
  }
  return people;
}

function matchProjects(text: string, projects: VoiceIntentRecipient[]): VoiceIntentRecipient[] {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  const scored = projects.map((project) => {
    const tokens = project.projectName.toLowerCase().replace(/ё/g, 'е').split(/[\s\-_.]+/).filter((token) => token.length >= 3);
    const score = tokens.reduce((sum, token) => {
      const stem = token.slice(0, Math.max(4, token.length - 2));
      return lower.includes(stem) ? sum + token.length : sum;
    }, 0);
    return { project, score };
  });
  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).map((entry) => entry.project);
}

function cleanTitle(text: string): string {
  const stripped = text.replace(/^(?:пожалуйста[, ]*)?(?:запиши в календарь|добавь в календарь|напомни(?: мне)?|назначь|запланируй)\s*/i, '').trim();
  const title = stripped || text.trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * Rule-based parse of a dictated phrase into one action: calendar event (meeting words
 * plus a time), task for a project (task words or a project name), otherwise a plain
 * message. Fallback of the Voice intent service when Claude is unavailable.
 * Exported for the Voice intent service and its tests.
 */
export function parseIntentWithRules(
  text: string,
  projects: VoiceIntentRecipient[],
  now: Date,
): VoiceIntentAction[] {
  const lower = text.toLowerCase();
  const time = parseSpokenTime(text, now);
  const mentioned = matchProjects(text, projects);

  if (CALENDAR_WORDS.test(lower) && (time.start || /календар/.test(lower))) {
    const eventType = /созвон|звонок|позвони/.test(lower) ? 'call'
      : /напомни|напоминани/.test(lower) ? 'reminder'
        : /встреч/.test(lower) ? 'meeting' : 'other';
    const who = findPeople(text, eventType === 'meeting' || eventType === 'call');
    return [{
      id: 'a1',
      kind: 'calendar_event',
      summary: eventType === 'call' ? 'Созвон в календарь' : eventType === 'reminder' ? 'Напоминание' : 'Событие в календарь',
      confidence: time.start ? 0.7 : 0.45,
      title: cleanTitle(text),
      eventType,
      start: time.start,
      end: null,
      whenText: time.phrase,
      who,
    }];
  }

  if (TASK_WORDS.test(lower) && (mentioned.length > 0 || /задач/.test(lower))) {
    return [{
      id: 'a1',
      kind: 'project_task',
      summary: mentioned[0] ? `Задача Claude в «${mentioned[0].projectName}»` : 'Задача Claude',
      confidence: mentioned.length > 0 ? 0.65 : 0.4,
      text: text.trim(),
      recipient: mentioned[0] ?? null,
      candidates: mentioned.length > 0 ? mentioned.slice(0, 5) : projects.slice(0, 5),
    }];
  }

  return [{ id: 'a1', kind: 'message', summary: 'Сообщение в диалог', confidence: 0.6, text: text.trim() }];
}
