import { useState } from 'react';

import { CheckIcon, ChevronRightIcon, MeetIcon, MessageIcon, PhoneCallIcon, PlusIcon, SectionRuler, toPanelWall, usePanelTimeZone } from '@/modules/kabina';
import { buildWeek, eventOnLocalDay, formatClock, formatCountdown } from '@/modules/home/utils/homeFormatting';
import type { HomeScheduledEvent } from '@/shared/types';

type HomeCalendarProps = {
  index: string;
  scheduled: HomeScheduledEvent[] | null;
  now: Date;
  isPhone: boolean;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
  /** «+ Событие»: the calendar screen (Kabina only). */
  onAddEvent?: () => void;
  /** A calendar call, message or meeting: opens it in the calendar screen (Kabina only). */
  onOpenEvent?: (event: HomeScheduledEvent) => void;
};

/** "через N" is shown only for what is close enough to plan around. */
const COUNTDOWN_WINDOW_MS = 3 * 60 * 60 * 1000;
const FALLBACK_UPCOMING = 3;
const WEEKDAYS_LOWER = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function formatDayMonth(instant: Date): string {
  const date = toPanelWall(instant);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
}

type CalendarItem = { type: 'now' } | { type: 'event'; event: HomeScheduledEvent; done: boolean };

/**
 * Calendar block (DarkMain 04 / DarkPhoneMain «СЕГОДНЯ»): calls, messages,
 * meetings and Claude's tasks from `/api/calendar/events` (scheduled messages
 * alone if the calendar cannot be read); the "now" line splits past from
 * future; on the phone what is done today folds into one row.
 */
export default function HomeCalendar({ index, scheduled, now, isPhone, onOpenSession, onAddEvent, onOpenEvent }: HomeCalendarProps) {
  usePanelTimeZone();
  // The day picked in the week strip; null follows "today" across midnight.
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  // Phone: whether «Сделано · N» is unfolded.
  const [isDoneOpen, setIsDoneOpen] = useState(false);

  const events = scheduled ?? [];
  // An event running past midnight counts (and is listed) on every day it touches.
  const week = buildWeek(now, events.map((event) => ({ startsAt: event.scheduledFor, endsAt: event.endsAt })));
  const selectedDay = isPhone ? week[0] : week.find((day) => day.key === selectedDayKey) ?? week[0];
  const isToday = selectedDay.isToday;

  let dayEvents = events.filter((event) => eventOnLocalDay(event, selectedDay.date) !== null);
  // An empty today still answers "what is next": the nearest upcoming items, with their dates.
  const showingUpcoming = isToday && dayEvents.length === 0 && events.length > 0;
  if (showingUpcoming) {
    dayEvents = events.slice(0, FALLBACK_UPCOMING);
  }

  const nowMs = now.getTime();
  const nextEventId = events.find((event) => Date.parse(event.scheduledFor) >= nowMs && !event.calendar?.done)?.id ?? null;
  // An event carried over from an earlier day is behind us only once it has ended.
  const isBehind = (event: HomeScheduledEvent) => (eventOnLocalDay(event, selectedDay.date)?.fromPrevDay && event.endsAt
    ? Date.parse(event.endsAt) <= nowMs
    : Date.parse(event.scheduledFor) <= nowMs);
  const doneEvents = isToday && !showingUpcoming
    ? dayEvents.filter((event) => isBehind(event) || Boolean(event.calendar?.done))
    : [];

  const items: CalendarItem[] = [];
  for (const event of dayEvents) {
    const done = doneEvents.includes(event);
    if (done && isPhone && !isDoneOpen) continue;
    items.push({ type: 'event', event, done });
  }
  if (isToday && !showingUpcoming) {
    const firstFuture = items.findIndex((item) => item.type === 'event' && !item.done);
    items.splice(firstFuture === -1 ? items.length : firstFuture, 0, { type: 'now' });
  }

  // «10–12» as in DarkPhoneMain; a single done item shows its own time.
  // An event carried over from yesterday counts at its end (it is «до 06:00» today, not 22:00).
  const shownAt = (event: HomeScheduledEvent) => (eventOnLocalDay(event, selectedDay.date)?.fromPrevDay && event.endsAt
    ? event.endsAt
    : event.scheduledFor);
  const firstDoneHour = doneEvents.length ? toPanelWall(shownAt(doneEvents[0])).getHours() : 0;
  const lastDoneHour = doneEvents.length ? toPanelWall(shownAt(doneEvents[doneEvents.length - 1])).getHours() : 0;
  const doneSpan = !doneEvents.length
    ? ''
    : firstDoneHour === lastDoneHour
      ? formatClock(new Date(shownAt(doneEvents[0])))
      : `${firstDoneHour}–${lastDoneHour}`;

  return (
    <section id="mh-cal" className={`mh-section kb-rise kb-d2${isPhone ? '' : ' mh-cal'}`} aria-labelledby="mh-h-cal">
      <SectionRuler id="mh-h-cal" index={index} title={isPhone ? 'СЕГОДНЯ' : 'КАЛЕНДАРЬ'} scale={isPhone ? 'major' : 'minor'} touch={isPhone}>
        {onAddEvent && (
          <button
            type="button"
            className="kb-btn kb-ghost mh-add-event"
            data-touch={isPhone ? '' : undefined}
            aria-label="Добавить событие"
            onClick={onAddEvent}
          >
            <PlusIcon />
            Событие
          </button>
        )}
      </SectionRuler>

      {!isPhone && (
        <div className="mh-week" role="group" aria-label="Неделя">
          {week.map((day) => (
            <button
              key={day.key}
              type="button"
              className="mh-day kb-day"
              aria-pressed={day.key === selectedDay.key}
              aria-label={`${day.ariaWeekday}, ${day.dayOfMonth} · событий: ${day.count}`}
              data-weekend={day.isWeekend ? '' : undefined}
              onClick={() => setSelectedDayKey(day.isToday ? null : day.key)}
            >
              <span className="mh-day-bar" aria-hidden="true" />
              <span className="kb-m mh-day-w">{day.weekday}</span>
              <span className="kb-t mh-day-n">{day.dayOfMonth}</span>
              <span className="mh-day-dots" aria-hidden="true">
                {Array.from({ length: Math.min(day.count, 4) }, (_, dot) => <span key={dot} />)}
              </span>
            </button>
          ))}
        </div>
      )}

      <ol className="mh-events" aria-label={isToday ? 'Дела на сегодня' : `Дела на ${formatDayMonth(selectedDay.date)}`}>
        {isPhone && doneEvents.length > 0 && (
          <li>
            <button type="button" className="mh-done-row kb-row" aria-expanded={isDoneOpen} onClick={() => setIsDoneOpen((open) => !open)}>
              <span className="kb-m mh-event-time">{doneSpan}</span>
              <CheckIcon size={14} stroke="#9CC49A" />
              <span className="mh-done-label">Сделано · {doneEvents.length}</span>
              <ChevronRightIcon style={{ transform: `rotate(${isDoneOpen ? 90 : 0}deg)`, transition: 'transform .2s ease' }} />
            </button>
          </li>
        )}
        {showingUpcoming && (
          <li className="mh-note">Сегодня ничего не запланировано. Ближайшее:</li>
        )}
        {items.map((item) => {
          if (item.type === 'now') {
            return (
              <li key="now" className="mh-now" aria-label={`Сейчас ${formatClock(now)}`}>
                <span className="kb-m mh-now-time">{formatClock(now)}</span>
                <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden="true"><path d="M0 0l7 5-7 5z" fill="currentColor" /></svg>
                <span className="mh-now-line" aria-hidden="true" />
                <span className="kb-m mh-now-label">СЕЙЧАС</span>
              </li>
            );
          }
          const { event, done } = item;
          const at = new Date(event.scheduledFor);
          const untilMs = at.getTime() - nowMs;
          const isNext = event.id === nextEventId;
          const left = done
            ? 'готово'
            : untilMs > 0 && untilMs <= COUNTDOWN_WINDOW_MS ? formatCountdown(at.getTime(), nowMs) : '';
          // Calendar calls, messages and meetings open in the calendar; Claude's tasks open their dialog.
          const kind = event.calendar?.type ?? 'agent_task';
          const opensDialog = kind === 'agent_task' && Boolean(event.sessionId);
          const isScheduledMessage = !event.calendar || event.id.startsWith('scheduled:');
          const title = isScheduledMessage ? `Сообщение — ${event.sessionTitle}` : event.calendar?.title ?? event.sessionTitle;
          const Icon = kind === 'call' ? PhoneCallIcon : kind === 'meeting' ? MeetIcon : MessageIcon;
          // Carried over from an earlier day: «до 10:00» (or «весь день») and where it began.
          const span = showingUpcoming ? null : eventOnLocalDay(event, selectedDay.date);
          const carried = Boolean(span?.fromPrevDay && event.endsAt);
          const endAt = event.endsAt ? new Date(event.endsAt) : at;
          const timeText = showingUpcoming
            ? formatDayMonth(at)
            : carried ? (span?.toNextDay ? 'весь день' : `до ${formatClock(endAt)}`) : formatClock(at);
          const since = carried ? `с ${WEEKDAYS_LOWER[toPanelWall(at).getDay()]} ${formatClock(at)}` : '';
          return (
            <li key={event.id} className={done && isPhone ? 'kb-fadein' : undefined}>
              <button
                type="button"
                className="mh-event kb-row"
                data-next={isNext ? '' : undefined}
                data-done={done ? '' : undefined}
                onClick={() => (opensDialog || !onOpenEvent ? onOpenSession(event.sessionId, event.projectId) : onOpenEvent(event))}
                aria-label={opensDialog
                  ? `${formatClock(at)} · сообщение в «${event.sessionTitle}», ${event.projectName}. Открыть диалог`
                  : `${carried ? `${timeText}, ${since}` : formatClock(at)} · ${title}, ${event.projectName}. Открыть в календаре`}
              >
                <span className="kb-m mh-event-time" data-carried={carried ? '' : undefined}>{timeText}</span>
                <span className="mh-event-icon"><Icon size={isPhone ? 16 : 14} /></span>
                <span className="mh-event-body">
                  <span className="mh-event-title kb-pretty">{title}</span>
                  <span className="mh-event-sub">
                    {/* Empty parts are skipped, so the line never ends on a bare «·». */}
                    {[showingUpcoming ? formatClock(at) : since, event.projectName, event.preview.trim()].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {left && <span className="kb-m mh-event-left">{left}</span>}
              </button>
            </li>
          );
        })}
        {scheduled !== null && events.length === 0 && (
          <li className="mh-note">
            <span className="mh-note-title">На сегодня ничего</span>
            Добавь звонок или встречу в календаре или отложи сообщение из чата — они появятся здесь событиями дня.
          </li>
        )}
        {scheduled !== null && !isToday && dayEvents.length === 0 && events.length > 0 && (
          <li className="mh-note">На этот день ничего не запланировано.</li>
        )}
      </ol>
    </section>
  );
}
