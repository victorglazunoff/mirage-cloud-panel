import { Board, SearchIcon, usePanelTimeZone } from '@/modules/kabina';
import {
  formatClock,
  formatCountdown,
  formatEventWhen,
  formatLongDate,
  formatShortLongDate,
  greetingFor,
  isSameLocalDay,
  plural,
} from '@/modules/home/utils/homeFormatting';
import type { HomeActivityItem, HomeScheduledEvent } from '@/shared/types';

type HomeSummaryProps = {
  now: Date;
  userName: string | null;
  activity: HomeActivityItem[] | null;
  scheduled: HomeScheduledEvent[] | null;
  isPhone: boolean;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
  onScrollTo: (elementId: string) => void;
  onOpenSearch?: () => void;
  onOpenAgents?: () => void;
  onOpenCalendar?: () => void;
};

const AGENT_FORMS: [string, string, string] = ['агент', 'агента', 'агентов'];
const NUMBER_WORDS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];

function uniqueNames(items: Array<{ projectName: string }>): string {
  return Array.from(new Set(items.map((item) => item.projectName))).join(', ');
}

/** "два агента", "5 агентов" — small counts read as words, as in the mock-up. */
function countWord(count: number, forms: [string, string, string]): string {
  const word = count < NUMBER_WORDS.length ? NUMBER_WORDS[count] : String(count);
  return `${word} ${plural(count, forms)}`;
}

/** Name of what waits: «Сайт клиента ждёт разрешения на выкладку», «2 диалога ждут ответа». */
function describeWaiting(waiting: HomeActivityItem[]): string | null {
  if (waiting.length === 1) {
    const tool = waiting[0].permission?.toolName;
    return `${waiting[0].projectName} ждёт разрешения${tool ? ` на ${tool}` : ''}.`;
  }
  if (waiting.length > 1) {
    return `${waiting.length} ${plural(waiting.length, ['диалог ждёт', 'диалога ждут', 'диалогов ждут'])} твоего ответа.`;
  }
  return null;
}

/** The greeting's second line, written from live numbers rather than a template of counters. */
function describeSituation(
  now: Date,
  waiting: HomeActivityItem[],
  working: HomeActivityItem[],
  nextEvent: HomeScheduledEvent | null,
): { text: string; eventIn: string | null } {
  const parts: string[] = [];
  const waitText = describeWaiting(waiting);
  if (waitText) parts.push(waitText);

  const workText = working.length ? `${countWord(working.length, AGENT_FORMS)} в работе` : null;
  if (waiting.length) {
    parts.push(workText ? `Остальное идёт само: ${workText}` : 'Остальное тихо');
  } else if (workText) {
    parts.push(`Всё идёт само: ${workText}`);
  } else {
    parts.push('Сейчас тихо: ни один ход не идёт');
  }

  const nextToday = nextEvent && isSameLocalDay(new Date(nextEvent.scheduledFor), now) ? nextEvent : null;
  let eventIn: string | null = null;
  if (nextToday) {
    eventIn = formatCountdown(Date.parse(nextToday.scheduledFor), now.getTime()).replace(/^через /, '');
    const kind = nextToday.calendar?.type ?? 'agent_task';
    const what = kind === 'call' ? `звонка «${nextToday.calendar?.title}»`
      : kind === 'meeting' ? `встречи «${nextToday.calendar?.title}»`
        : kind === 'message' ? `сообщения «${nextToday.calendar?.title}»`
          : `сообщения в «${nextToday.projectName}»`;
    parts[parts.length - 1] += `, до ${what} — `;
  } else {
    parts[parts.length - 1] += '.';
  }
  return { text: parts.join(' '), eventIn };
}

/** Greeting, one-line situation report and the РАБОТАЮТ / ЖДЁТ ТЕБЯ / СОБЫТИЯ board (DarkMain, DarkPhoneMain). */
export default function HomeSummary({
  now,
  userName,
  activity,
  scheduled,
  isPhone,
  onOpenSession,
  onScrollTo,
  onOpenSearch,
  onOpenAgents,
  onOpenCalendar,
}: HomeSummaryProps) {
  usePanelTimeZone();
  const isLoaded = activity !== null;
  const waiting = (activity ?? []).filter((item) => item.state === 'waiting');
  const working = (activity ?? []).filter((item) => item.state !== 'waiting');
  const upcoming = (scheduled ?? []).filter((event) => Date.parse(event.scheduledFor) >= now.getTime() - 60_000 && !event.calendar?.done);
  const nextEvent = upcoming[0] ?? null;
  const situation = isLoaded ? describeSituation(now, waiting, working, nextEvent) : null;

  let nextEventLabel = 'впереди пусто';
  if (nextEvent) {
    const at = new Date(nextEvent.scheduledFor);
    // «в 15:00» today, otherwise the short day: «завтра 11:00», «пт 11:00», «03.11 11:00».
    const when = formatEventWhen(at, now);
    if (isSameLocalDay(at, now)) nextEventLabel = isPhone ? `первое ${when}` : `впереди · ближайшее ${when}`;
    else nextEventLabel = isPhone ? when : `впереди · ближайшее ${when}`;
  }

  const workingLabel = working.length
    ? isPhone
      ? `${plural(working.length, AGENT_FORMS)} в фоне`
      : `${plural(working.length, AGENT_FORMS)} · ${uniqueNames(working)}`
    : 'никто не занят';
  const waitingLabel = waiting.length
    ? isPhone
      ? uniqueNames(waiting)
      : `${uniqueNames(waiting)} · ${waiting[0].permission?.toolName ?? 'разрешение'}`
    : 'всё решено';

  const greeting = userName ? `${greetingFor(now)}, ${userName}` : greetingFor(now);

  return (
    <section className="mh-summary kb-rise" aria-label="Сводка">
      <div className="mh-summary-text">
        <span className="kb-m mh-eyebrow">
          {isPhone ? `СВОДКА · ${formatShortLongDate(now)}` : `СВОДКА · ${formatLongDate(now)}`}
        </span>
        <h1 className="kb-t kb-balance mh-h1">{greeting}</h1>
        <p className="kb-pretty mh-lead" aria-live="polite">
          {situation ? situation.text : 'Собираю сводку…'}
          {situation?.eventIn && (
            <>
              <span className="kb-m mh-lead-num">{situation.eventIn}</span>.
            </>
          )}
        </p>
      </div>

      <div className="mh-board">
        <Board
          compact={isPhone}
          loading={!isLoaded}
          ariaLabel="Табло"
          cells={[
            {
              key: 'run',
              status: working.length ? 'run' : 'idle',
              code: 'РАБОТАЮТ',
              value: working.length,
              label: workingLabel,
              ariaLabel: `${working.length} работают — ${isPhone && onOpenAgents ? 'открыть агентов' : 'к списку «В работе»'}`,
              onSelect: () => (isPhone && onOpenAgents ? onOpenAgents() : onScrollTo('mh-run')),
            },
            {
              key: 'wait',
              status: waiting.length ? 'wait' : 'idle',
              code: 'ЖДЁТ ТЕБЯ',
              value: waiting.length,
              label: waitingLabel,
              highlight: waiting.length > 0,
              ariaLabel: waiting.length ? `${waiting.length} ждёт тебя — открыть ${waiting[0].projectName}` : 'Никто не ждёт ответа',
              onSelect: () => (waiting.length ? onOpenSession(waiting[0].sessionId, waiting[0].projectId) : onScrollTo('mh-run')),
            },
            {
              key: 'cal',
              status: 'cal',
              code: 'СОБЫТИЯ',
              value: upcoming.length,
              label: nextEventLabel,
              ariaLabel: `${upcoming.length} событий впереди — ${isPhone && onOpenCalendar ? 'открыть календарь' : 'к календарю'}`,
              onSelect: () => (isPhone && onOpenCalendar ? onOpenCalendar() : onScrollTo('mh-cal')),
            },
          ]}
        />
      </div>

      {isPhone && onOpenSearch && (
        <button type="button" className="mh-search kb-cmd" onClick={onOpenSearch}>
          <SearchIcon size={17} stroke="#B3AA9B" />
          <span className="mh-search-text">Найти диалог, файл или спросить</span>
        </button>
      )}
    </section>
  );
}
