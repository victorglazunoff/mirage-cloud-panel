import type { CSSProperties } from 'react';

import CalendarEventButton from '@/modules/kabina-calendar/CalendarEventButton';
import {
  GRID_END_MIN,
  GRID_HEIGHT_PX,
  GRID_START_MIN,
  HOUR_PX,
  dayPieces,
  formatClock,
  formatDayFull,
  gridOffset,
  isSameDay,
  mondayIndex,
  pad2,
  pieceBand,
  placeDayPieces,
  startOfDay,
  weekdayShort,
} from '@/modules/kabina-calendar/utils/calendarModel';
import type { DayPiece } from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarItem } from '@/shared/types';

type CalendarTimeGridProps = {
  view: 'day' | 'week';
  days: Date[];
  /** Visible items plus the quick-add draft (id `draft`). */
  items: CalendarItem[];
  selectedId: string | null;
  nextId: string | null;
  now: Date;
  zoneLabel: string;
  onPick: (item: CalendarItem) => void;
  onAddDraft: () => void;
  onOpenDay: (day: Date) => void;
};

/** Half heights of the «сейчас» tag and of an hour label, px. */
const NOW_TAG_HALF = 9;
const HOUR_LABEL_HALF = 6;

/**
 * Where an hour label sits: on its line, unless the «сейчас» tag is there —
 * then it moves just above or below the tag, so both stay readable.
 */
function hourLabelTop(hour: number, nowOffset: number | null): number {
  const line = (hour - GRID_START_MIN / 60) * HOUR_PX;
  if (nowOffset === null || Math.abs(line - nowOffset) >= NOW_TAG_HALF + HOUR_LABEL_HALF + 1) return line - HOUR_LABEL_HALF;
  return line >= nowOffset
    ? nowOffset + NOW_TAG_HALF + 1
    : nowOffset - NOW_TAG_HALF - 1 - 2 * HOUR_LABEL_HALF;
}

const HOURS = Array.from({ length: (GRID_END_MIN - GRID_START_MIN) / 60 + 1 }, (_, index) => GRID_START_MIN / 60 + index);

/** The week (or one day) as DarkCalendar draws it: day heads, «до 08», the 08–21 grid with «сейчас», «после 21». */
export default function CalendarTimeGrid({ view, days, items, selectedId, nextId, now, zoneLabel, onPick, onAddDraft, onOpenDay }: CalendarTimeGridProps) {
  const nowMs = now.getTime();
  const nowOffset = gridOffset(now);
  const showNow = nowOffset !== null && days.some((day) => isSameDay(day, now));
  const todayStart = startOfDay(now).getTime();
  const columns = days.map((day) => {
    // Every event touching the day: one that runs over several days is a piece in each of them.
    const mine = dayPieces(items, day);
    return {
      day,
      isToday: isSameDay(day, now),
      // Whole days before today are «прошло» top to bottom.
      isPast: day.getTime() < todayStart,
      isWeekend: mondayIndex(day) > 4,
      people: mine.filter((piece) => piece.item.type !== 'server_schedule' && piece.item.id !== 'draft').length,
      early: mine.filter((piece) => pieceBand(piece) === 'early'),
      late: mine.filter((piece) => pieceBand(piece) === 'late'),
      grid: placeDayPieces(mine.filter((piece) => pieceBand(piece) === 'grid')),
    };
  });
  const rowStyle = { '--kc-cols': days.length, '--kc-grid-h': `${GRID_HEIGHT_PX}px` } as CSSProperties;
  const region = view === 'day'
    ? `День ${formatDayFull(days[0])}`
    : `Неделя ${formatDayFull(days[0])} — ${formatDayFull(days[days.length - 1])}`;

  const renderPill = ({ item, ...piece }: DayPiece) => (
    <CalendarEventButton
      key={item.id}
      item={item}
      piece={{ item, ...piece }}
      mode="pill"
      selected={item.id === selectedId}
      isNext={item.id === nextId}
      isDraft={item.id === 'draft'}
      nowMs={nowMs}
      onPick={item.id === 'draft' ? onAddDraft : () => onPick(item)}
    />
  );

  return (
    <div className="kc-board kb-bz" data-view={view} role="region" aria-label={region} tabIndex={0}>
      <div className="kc-board-inner" style={rowStyle}>
        <div className="kc-row kc-row-head">
          <div className="kb-m kc-zone">{zoneLabel}</div>
          {columns.map((column) => (
            <button
              key={column.day.toISOString()}
              type="button"
              className="kc-dayhead"
              data-today={column.isToday ? '' : undefined}
              data-weekend={column.isWeekend ? '' : undefined}
              aria-label={`${formatDayFull(column.day)}${column.people ? ` · событий с людьми и Claude: ${column.people}` : ''}${view === 'week' ? ' — открыть день' : ''}`}
              onClick={() => onOpenDay(column.day)}
            >
              <span className="kc-dayhead-bar" aria-hidden="true" />
              <span className="kb-m kc-dayhead-w">{weekdayShort(column.day)}</span>
              <span className="kb-t kc-dayhead-n">{pad2(column.day.getDate())}</span>
              <span className="kb-m kc-dayhead-c">{column.people ? String(column.people) : ''}</span>
            </button>
          ))}
        </div>

        <div className="kc-row kc-row-early">
          <div className="kb-m kc-strip-label">до 08</div>
          {columns.map((column) => (
            <div key={column.day.toISOString()} className={`kc-strip${column.isToday ? ' kc-col-today' : ''}`}>
              {column.early.map(renderPill)}
            </div>
          ))}
        </div>

        <div className="kc-row">
          <div className="kc-hours">
            <span className="kc-hours-scale" aria-hidden="true" />
            {HOURS.map((hour) => (
              <span key={hour} className="kb-m kc-hour" style={{ top: hourLabelTop(hour, showNow ? nowOffset : null) }}>
                {pad2(hour)}:00
              </span>
            ))}
            {nowOffset !== null && columns.some((column) => column.isToday) && (
              <span className="kb-m kc-now-label" style={{ top: nowOffset - 9 }}>{formatClock(now)}</span>
            )}
          </div>
          {columns.map((column) => (
            <div key={column.day.toISOString()} className={`kc-col${column.isToday ? ' kc-col-today' : ''}`}>
              {column.isToday && (
                <div className="kc-past" aria-hidden="true" style={{ height: nowOffset ?? (now.getHours() * 60 >= GRID_END_MIN ? GRID_HEIGHT_PX : 0) }} />
              )}
              {column.isPast && <div className="kc-past" aria-hidden="true" style={{ height: GRID_HEIGHT_PX }} />}
              {nowOffset !== null && columns.some((other) => other.isToday) && (
                <div className="kc-nowline" data-today={column.isToday ? '' : undefined} aria-hidden="true" style={{ top: nowOffset - 1 }} />
              )}
              {column.grid.map((placement) => (
                <CalendarEventButton
                  key={placement.item.id}
                  item={placement.item}
                  mode="grid"
                  placement={placement}
                  selected={placement.item.id === selectedId}
                  isNext={placement.item.id === nextId}
                  isDraft={placement.item.id === 'draft'}
                  nowMs={nowMs}
                  onPick={placement.item.id === 'draft' ? onAddDraft : () => onPick(placement.item)}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="kc-row kc-row-late">
          <div className="kb-m kc-strip-label">после 21</div>
          {columns.map((column) => (
            <div key={column.day.toISOString()} className={`kc-strip${column.isToday ? ' kc-col-today' : ''}`}>
              {column.late.map(renderPill)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
