import type { CalendarContact, CalendarEventType, CalendarParseResult } from '@/shared/types.js';

import { addLocalDays, toZonedParts, zonedTimeToUtc } from './calendar-time.service.js';
import { toNominativeFullName } from './russian-name-case.service.js';

/**
 * Rule-based reader of quick-add phrases in Russian (DarkCalendar):
 * «завтра в 11 позвонить [имя] про сайт», «в четверг в 16 встреча с Иваном по
 * DemoVilla», «через 2 часа написать @ivan», «каждый день в 9 Claude: сводка».
 *
 * No model is involved: the result must be instant and predictable, and the
 * screen shows what was understood before anything is saved.
 */

/** A project the phrase may name; `names` are display name and folder name. */
type ParserProject = { projectId: string; displayName: string; names: string[] };

type ParseInput = {
  text: string;
  nowMs: number;
  timeZone: string;
  projects: ParserProject[];
};

type Span = { start: number; end: number };

const MINUTE_MS = 60_000;
/** «через N …» further ahead than ten years is not a plan, it is a typo. */
const MAX_RELATIVE_MINUTES = 10 * 366 * 24 * 60;

// JS `\b` is ASCII-only, so word edges are spelled out for Cyrillic.
const WORD_START = '(?<![\\p{L}\\d])';
const WORD_END = '(?![\\p{L}\\d])';

const TYPE_DEFAULTS: Record<Exclude<CalendarEventType, 'server_schedule'>, { durationMin: number; remindBeforeMin: number | null }> = {
  call: { durationMin: 30, remindBeforeMin: 15 },
  message: { durationMin: 15, remindBeforeMin: 10 },
  meeting: { durationMin: 60, remindBeforeMin: 30 },
  agent_task: { durationMin: 30, remindBeforeMin: null },
};

const TYPE_LABELS: Record<CalendarEventType, string> = {
  call: 'Звонок',
  message: 'Сообщение',
  meeting: 'Встреча',
  agent_task: 'Задача Claude',
  server_schedule: 'Расписание сервера',
};

const WEEKDAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

// Stems of weekday names in every case the phrases use (понедельник/-ам, среду/среда/средам …).
const WEEKDAY_PATTERNS: Array<[number, string]> = [
  [0, 'понедельник\\p{L}*|пн'],
  [1, 'вторник\\p{L}*|вт'],
  [2, 'сред[уаы]\\p{L}*|ср'],
  [3, 'четверг\\p{L}*|чт'],
  [4, 'пятниц\\p{L}*|пт'],
  [5, 'суббот\\p{L}*|сб'],
  [6, 'воскресень\\p{L}*|вс'],
];

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

const TYPE_PATTERNS: Array<[Exclude<CalendarEventType, 'server_schedule'>, RegExp]> = [
  ['agent_task', new RegExp(`${WORD_START}(claude|клод\\p{L}*|поручи\\p{L}*)${WORD_END}`, 'iu')],
  ['call', new RegExp(`${WORD_START}(позвон\\p{L}*|перезвон\\p{L}*|созвон\\p{L}*|звон[оке]\\p{L}*|набрать|набери)${WORD_END}`, 'iu')],
  ['meeting', new RegExp(`${WORD_START}(встреч\\p{L}*|встрет\\p{L}*|при[её]м)${WORD_END}`, 'iu')],
  ['message', new RegExp(`${WORD_START}(написать|напиши|написал\\p{L}*|сообщени\\p{L}*|отправ\\p{L}*|ответ\\p{L}*)${WORD_END}`, 'iu')],
];

// Words that can follow a verb but are not a person.
const NOT_A_NAME = new Set([
  'про', 'по', 'насчет', 'о', 'об', 'в', 'во', 'на', 'с', 'со', 'к', 'для', 'и', 'а', 'что', 'чтобы',
  'сегодня', 'завтра', 'послезавтра', 'утром', 'вечером', 'днем', 'клиенту', 'клиента', 'всем',
]);

function normalize(text: string): string {
  // Same length as the input, so match offsets stay valid on the original text.
  return text.toLowerCase().replace(/ё/g, 'е');
}

function overlaps(spans: Span[], candidate: Span): boolean {
  return spans.some((span) => candidate.start < span.end && span.start < candidate.end);
}

function readNumberWord(token: string): number | null {
  const words: Record<string, number> = {
    'один': 1, 'одну': 1, 'два': 2, 'две': 2, 'пару': 2, 'три': 3, 'четыре': 4, 'пять': 5,
    'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10, 'пятнадцать': 15, 'двадцать': 20,
  };
  if (/^\d+$/.test(token)) {
    return Number(token);
  }
  return words[token] ?? null;
}

function unitToMinutes(unit: string): number | null {
  if (/^мин/.test(unit)) return 1;
  if (/^час/.test(unit)) return 60;
  if (/^(дн|день)/.test(unit)) return 24 * 60;
  if (/^недел/.test(unit)) return 7 * 24 * 60;
  return null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Parses one phrase. Times are resolved in `timeZone` relative to `nowMs`; a
 * phrase with neither a date nor a time yields `ok: false`.
 *
 * Used by the calendar service (`POST /api/calendar/parse`).
 */
export function parseCalendarPhrase(input: ParseInput): CalendarParseResult {
  const original = input.text.replace(/\s+/g, ' ').trim();
  const lower = normalize(original);
  const consumed: Span[] = [];
  const take = (match: RegExpExecArray | null, group = 0): RegExpExecArray | null => {
    if (!match) return null;
    const start = match.index + (group === 0 ? 0 : match[0].indexOf(match[group]));
    const span = { start, end: start + match[group].length };
    if (overlaps(consumed, span)) return null;
    consumed.push(span);
    return match;
  };

  const now = toZonedParts(input.nowMs, input.timeZone);
  let dateOffsetDays: number | null = null;
  let explicitDate: { year: number; month: number; day: number } | null = null;
  let weekday: number | null = null;
  let hour: number | null = null;
  let minute = 0;
  let absoluteInstant: number | null = null;
  let durationMin: number | null = null;
  let remindBeforeMin: number | null = null;
  let recurrence: string | null = null;

  // --- Recurrence: «каждый день», «по будням», «каждый понедельник», «по средам».
  const everyDay = take(new RegExp(`${WORD_START}(каждый день|ежедневно)${WORD_END}`, 'iu').exec(lower));
  if (everyDay) {
    recurrence = 'FREQ=DAILY';
  } else if (take(new RegExp(`${WORD_START}(по будням|в будни|каждый будний день)${WORD_END}`, 'iu').exec(lower))) {
    recurrence = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  } else {
    for (const [index, pattern] of WEEKDAY_PATTERNS) {
      const every = take(new RegExp(`${WORD_START}(кажд\\p{L}*|по)\\s+(${pattern})${WORD_END}`, 'iu').exec(lower));
      if (every) {
        recurrence = `FREQ=WEEKLY;BYDAY=${RRULE_DAYS[index]}`;
        weekday = index;
        break;
      }
    }
    if (!recurrence && take(new RegExp(`${WORD_START}(каждую неделю|еженедельно)${WORD_END}`, 'iu').exec(lower))) {
      recurrence = 'FREQ=WEEKLY';
    }
    if (!recurrence && take(new RegExp(`${WORD_START}(каждый месяц|ежемесячно)${WORD_END}`, 'iu').exec(lower))) {
      recurrence = 'FREQ=MONTHLY';
    }
  }

  // --- Reminder: «напомни за 15 минут», «напомнить за час».
  const remind = take(new RegExp(`${WORD_START}напомн\\p{L}*\\s+за\\s+(\\d+|полчаса|час|день)\\s*(минут\\p{L}*|мин|час\\p{L}*|дн\\p{L}*)?${WORD_END}`, 'iu').exec(lower));
  if (remind) {
    if (remind[1] === 'полчаса') remindBeforeMin = 30;
    else if (remind[1] === 'час') remindBeforeMin = 60;
    else if (remind[1] === 'день') remindBeforeMin = 24 * 60;
    else remindBeforeMin = Number(remind[1]) * (unitToMinutes(remind[2] ?? 'мин') ?? 1);
  }

  // --- Relative: «через 2 часа», «через 30 минут», «через час», «через полчаса», «через 3 дня».
  const relative = take(new RegExp(`${WORD_START}через\\s+(?:(полчаса|час|минуту|неделю|день)|(\\d+|\\p{L}+)\\s+(минут\\p{L}*|мин|час\\p{L}*|дн\\p{L}*|день|недел\\p{L}*))${WORD_END}`, 'iu').exec(lower));
  if (relative) {
    let minutes: number | null = null;
    if (relative[1]) {
      minutes = { 'полчаса': 30, 'час': 60, 'минуту': 1, 'неделю': 7 * 24 * 60, 'день': 24 * 60 }[relative[1]] ?? null;
    } else {
      const amount = readNumberWord(relative[2]);
      const unit = unitToMinutes(relative[3]);
      minutes = amount !== null && unit !== null ? amount * unit : null;
      // «через 99999999999 дней» would land past the last valid Date and throw.
      if (minutes !== null && minutes > MAX_RELATIVE_MINUTES) minutes = null;
    }
    if (minutes !== null) {
      if (minutes >= 24 * 60) {
        dateOffsetDays = Math.round(minutes / (24 * 60));
      } else {
        absoluteInstant = input.nowMs + minutes * MINUTE_MS;
      }
    }
  }

  // --- Duration: «на 30 минут», «на час», «на полчаса».
  const duration = take(new RegExp(`${WORD_START}на\\s+(?:(полчаса|час|полтора часа)|(\\d+)\\s*(минут\\p{L}*|мин|час\\p{L}*))${WORD_END}`, 'iu').exec(lower));
  if (duration) {
    durationMin = duration[1]
      ? { 'полчаса': 30, 'час': 60, 'полтора часа': 90 }[duration[1]] ?? null
      : Number(duration[2]) * (unitToMinutes(duration[3]) ?? 1);
  }

  // --- Day words.
  const dayWord = take(new RegExp(`${WORD_START}(сегодня|послезавтра|завтра)${WORD_END}`, 'iu').exec(lower));
  if (dayWord) {
    dateOffsetDays = { 'сегодня': 0, 'завтра': 1, 'послезавтра': 2 }[dayWord[1]] ?? 0;
  }

  // --- Date with a month name: «27 октября», «3 ноября 2027».
  const monthDate = take(new RegExp(`${WORD_START}(\\d{1,2})\\s+(${MONTHS.join('|')})\\p{L}*(?:\\s+(\\d{4}))?${WORD_END}`, 'iu').exec(lower));
  if (monthDate) {
    const monthIndex = MONTHS.findIndex((stem) => new RegExp(`^${stem}`, 'u').test(monthDate[2]));
    explicitDate = { year: monthDate[3] ? Number(monthDate[3]) : now.year, month: monthIndex + 1, day: Number(monthDate[1]) };
  }

  // --- Time: «в 11», «в 15:30», «к 9 утра», «в 7 вечера», «в 11 часов», a bare «15:30».
  const timeMatch = take(new RegExp(`${WORD_START}(?:в|к|около)\\s+(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s*(?:час\\p{L}*))?(?:\\s+(утра|дня|вечера|ночи))?${WORD_END}`, 'iu').exec(lower))
    ?? take(new RegExp(`${WORD_START}(\\d{1,2}):(\\d{2})(?:\\s+(утра|дня|вечера|ночи))?${WORD_END}`, 'iu').exec(lower));
  if (timeMatch) {
    const parsedHour = Number(timeMatch[1]);
    const parsedMinute = timeMatch[2] ? Number(timeMatch[2]) : 0;
    const dayPart = timeMatch[3];
    if (parsedHour <= 23 && parsedMinute <= 59) {
      hour = parsedHour;
      minute = parsedMinute;
      if ((dayPart === 'дня' || dayPart === 'вечера') && hour < 12) {
        hour += 12;
      } else if (dayPart === 'ночи' && hour === 12) {
        hour = 0;
      } else if (!dayPart && hour >= 1 && hour <= 7) {
        // «в 3» in a work calendar means 15:00; «в 3 утра/ночи» says otherwise.
        hour += 12;
      }
    }
  } else {
    const dayTime = take(new RegExp(`${WORD_START}(утром|в полдень|днем|вечером)${WORD_END}`, 'iu').exec(lower));
    if (dayTime) {
      hour = { 'утром': 9, 'в полдень': 12, 'днем': 13, 'вечером': 19 }[dayTime[1]] ?? null;
    }
  }

  // --- Numeric date «30.10» / «30.10.2026», only after the time took «15.30»-like tokens.
  if (!explicitDate) {
    const numericDate = take(new RegExp(`${WORD_START}(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2,4}))?${WORD_END}`, 'iu').exec(lower));
    if (numericDate && Number(numericDate[2]) >= 1 && Number(numericDate[2]) <= 12) {
      const year = numericDate[3] ? Number(numericDate[3].length === 2 ? `20${numericDate[3]}` : numericDate[3]) : now.year;
      explicitDate = { year, month: Number(numericDate[2]), day: Number(numericDate[1]) };
    }
  }

  // --- Weekday: «в четверг», «во вторник», «в пт».
  if (weekday === null) {
    for (const [index, pattern] of WEEKDAY_PATTERNS) {
      const found = take(new RegExp(`${WORD_START}(?:(?:в|во|на)\\s+)?(${pattern})${WORD_END}`, 'iu').exec(lower));
      if (found) {
        weekday = index;
        break;
      }
    }
  }

  // --- Type.
  // Without a verb the type is settled after the contact and the project are read (see below).
  let type: Exclude<CalendarEventType, 'server_schedule'> = 'meeting';
  let typeRecognized = false;
  let verbMatch: RegExpExecArray | null = null;
  for (const [candidateType, pattern] of TYPE_PATTERNS) {
    const found = pattern.exec(lower);
    if (found) {
      type = candidateType;
      typeRecognized = true;
      verbMatch = found;
      break;
    }
  }

  // --- Contact: «@nick», a phone number, a [bracketed] or Capitalised name after the verb or «с».
  const contact: CalendarContact = { name: null, phone: null, telegram: null };
  const telegram = /(?<![\w@])@([A-Za-z0-9_]{4,32})\b/.exec(original);
  if (telegram) contact.telegram = `@${telegram[1]}`;
  const phone = /(?<!\d)(\+?\d[\d\s()-]{8,}\d)(?!\d)/.exec(original);
  if (phone && phone[1].replace(/\D/g, '').length >= 10) {
    contact.phone = phone[1].trim();
    take(phone);
  }
  const nameAnchors: RegExpExecArray[] = [];
  // A task for Claude has no counterpart: «Claude: сводка» must not read «сводка» as a name.
  if (verbMatch && type !== 'agent_task') nameAnchors.push(verbMatch);
  const withMatch = new RegExp(`${WORD_START}(?:с|со)\\s+`, 'iu').exec(lower.slice(verbMatch ? verbMatch.index : 0));
  // «завтра в 11 с [имя]» has no verb, but «с …» still names the person.
  if (withMatch && type !== 'agent_task') {
    withMatch.index += verbMatch ? verbMatch.index : 0;
    nameAnchors.unshift(withMatch);
  }
  for (const anchor of nameAnchors) {
    const after = original.slice(anchor.index + anchor[0].length).replace(/^[\s,:]+/, '');
    const bracketed = /^\[[^\]]{1,40}\]/.exec(after);
    if (bracketed) {
      contact.name = bracketed[0];
      break;
    }
    const words = /^([\p{L}-]+)(?:\s+([\p{Lu}][\p{L}-]+))?/u.exec(after);
    if (words && !NOT_A_NAME.has(normalize(words[1])) && !new RegExp(`^(${WEEKDAY_PATTERNS.map(([, p]) => p).join('|')})$`, 'iu').test(normalize(words[1]))) {
      const isCapitalised = /^\p{Lu}/u.test(words[1]);
      if (isCapitalised || anchor !== withMatch) {
        // Oblique case («Ивану», «с Ольгой») back to the nominative; the title keeps the user wording.
        contact.name = isCapitalised ? toNominativeFullName(words[2] ? `${words[1]} ${words[2]}` : words[1]) : words[1];
        break;
      }
    }
  }
  if (contact.name && /^@/.test(contact.name)) {
    contact.name = null;
  }

  // --- Project: the longest project name mentioned as whole words.
  let project: ParserProject | null = null;
  let projectLength = 0;
  for (const candidate of input.projects) {
    for (const name of candidate.names) {
      const needle = normalize(name.trim());
      if (needle.length < 3 || needle.length <= projectLength) continue;
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`${WORD_START}${escaped}${WORD_END}`, 'iu').test(lower)) {
        project = candidate;
        projectLength = needle.length;
      }
    }
  }

  // --- No verb («завтра в 11 сводка по Сайт клиента»): a project and nobody to meet is a task for Claude
  // in that project; anything else is a meeting. Never a call by default — the preview shows the guess.
  if (!typeRecognized) {
    const hasPerson = Boolean(contact.name || contact.phone || contact.telegram);
    type = project && !hasPerson ? 'agent_task' : 'meeting';
  }

  // --- Resolve the start instant.
  const hasDate = dateOffsetDays !== null || explicitDate !== null || weekday !== null || recurrence !== null;
  const hasTime = hour !== null || absoluteInstant !== null;
  let startsAtMs: number | null = absoluteInstant;
  if (startsAtMs === null && (hasDate || hasTime)) {
    const timeOfDay = { hour: hour ?? 10, minute: hour === null ? 0 : minute };
    let date: { year: number; month: number; day: number };
    if (explicitDate) {
      date = explicitDate;
      const candidate = zonedTimeToUtc({ ...date, ...timeOfDay }, input.timeZone);
      if (candidate < input.nowMs - 24 * 60 * MINUTE_MS && !/\d{4}/.test(original)) {
        date = { ...date, year: date.year + 1 };
      }
    } else if (dateOffsetDays !== null) {
      date = addLocalDays(now, dateOffsetDays);
    } else if (weekday !== null) {
      let delta = (weekday - now.weekday + 7) % 7;
      const todayAtTime = zonedTimeToUtc({ ...now, ...timeOfDay }, input.timeZone);
      if (delta === 0 && todayAtTime <= input.nowMs) {
        delta = 7;
      }
      date = addLocalDays(now, delta);
    } else {
      // Only a time: today if still ahead, otherwise tomorrow.
      const todayAtTime = zonedTimeToUtc({ ...now, ...timeOfDay }, input.timeZone);
      date = todayAtTime > input.nowMs ? now : addLocalDays(now, 1);
    }
    startsAtMs = zonedTimeToUtc({ ...date, ...timeOfDay }, input.timeZone);
    // «каждый день в 9» said at 10:00 starts tomorrow.
    if (recurrence && !explicitDate && dateOffsetDays === null && startsAtMs <= input.nowMs) {
      startsAtMs = zonedTimeToUtc({ ...addLocalDays(date, 1), ...timeOfDay }, input.timeZone);
    }
  }

  // --- Title: the phrase without the date/time/duration/reminder fragments.
  const removable = [...consumed].sort((a, b) => b.start - a.start);
  let title = original;
  for (const span of removable) {
    title = `${title.slice(0, span.start)} ${title.slice(span.end)}`;
  }
  title = title
    .replace(/^\s*(claude|клод\p{L}*)\s*[:,—-]\s*/iu, '')
    .replace(/\s+([,.!?:;])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;—-]+|[\s,;—-]+$/g, '')
    .trim();
  title = title ? title.charAt(0).toUpperCase() + title.slice(1) : TYPE_LABELS[type];

  const recognized = {
    type: typeRecognized,
    date: hasDate || absoluteInstant !== null,
    time: hasTime,
    contact: Boolean(contact.name || contact.phone || contact.telegram),
    project: project !== null,
    recurrence: recurrence !== null,
  };

  const missing: string[] = [];
  if (type === 'call' || type === 'message' || type === 'meeting') {
    if (!contact.name) missing.push('контакт не найден в адресной книге');
    if (type === 'call' && !contact.phone) missing.push('телефон не указан');
    if (type === 'meeting') missing.push('место не указано');
  }
  if (!hasTime) missing.push('время не указано — поставил 10:00');

  if (startsAtMs === null) {
    return { ok: false, draft: null, recognized, missing: ['не нашёл ни дату, ни время'], summary: null, timeZone: input.timeZone };
  }

  const finalDuration = durationMin && durationMin > 0 && durationMin <= 24 * 60 ? durationMin : TYPE_DEFAULTS[type].durationMin;
  const startParts = toZonedParts(startsAtMs, input.timeZone);
  const who = contact.name ?? contact.telegram ?? contact.phone;
  const summary = [
    TYPE_LABELS[type],
    `${WEEKDAY_SHORT[startParts.weekday]} ${pad(startParts.day)}.${pad(startParts.month)} ${pad(startParts.hour)}:${pad(startParts.minute)}`,
    who,
  ].filter(Boolean).join(' · ');

  return {
    ok: true,
    draft: {
      type,
      title,
      startsAt: new Date(startsAtMs).toISOString(),
      endsAt: new Date(startsAtMs + finalDuration * MINUTE_MS).toISOString(),
      durationMin: finalDuration,
      projectId: project?.projectId ?? null,
      projectName: project?.displayName ?? null,
      contact: recognized.contact ? contact : null,
      remindBeforeMin: remindBeforeMin ?? TYPE_DEFAULTS[type].remindBeforeMin,
      recurrence,
      note: null,
    },
    recognized,
    missing,
    summary,
    timeZone: input.timeZone,
  };
}
