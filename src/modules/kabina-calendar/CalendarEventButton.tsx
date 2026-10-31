import type { CSSProperties } from 'react';

import { TypeIcon } from '@/modules/kabina-calendar/CalendarIcons';
import {
  TYPE_LABELS,
  formatClock,
  formatCountdown,
  formatDayFull,
  formatSpan,
  isContinued,
  itemShortTitle,
  pieceTimeText,
  RAIL_PX,
  itemSubline,
  toWall,
} from '@/modules/kabina-calendar/utils/calendarModel';
import type { DayPiece, GridPlacement } from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarItem } from '@/shared/types';

type CalendarEventButtonProps = {
  item: CalendarItem;
  /** `grid` — absolutely placed in the 08–21 grid; `pill` — a 24px row in the strips and the month. */
  mode: 'grid' | 'pill';
  placement?: GridPlacement;
  /** The day's piece of an event longer than a day (strips and the month); the grid takes it from `placement`. */
  piece?: DayPiece;
  selected: boolean;
  isNext: boolean;
  isDraft?: boolean;
  nowMs: number;
  onPick: () => void;
};

/** One event in the calendar grids (DarkCalendar `.ev`): shape by type, states by data attributes. */
export default function CalendarEventButton({ item, mode, placement, piece, selected, isNext, isDraft = false, nowMs, onPick }: CalendarEventButtonProps) {
  const start = toWall(item.startsAt);
  const end = toWall(item.endsAt);
  const done = item.status === 'done';
  // A piece of an event longer than a day: the bar is cut flat where it goes on.
  const fromPrevDay = placement?.fromPrevDay ?? piece?.fromPrevDay ?? false;
  const toNextDay = placement?.toNextDay ?? piece?.toNextDay ?? false;
  const continued = isContinued({ fromPrevDay, toNextDay });
  const durationMin = (end.getTime() - start.getTime()) / 60_000;
  const rail = Boolean(placement?.rail);
  const long = mode === 'grid' && !rail && durationMin >= 60 && (!placement || placement.height >= 40);
  const countdown = isNext && !done ? formatCountdown(start.getTime(), nowMs) : '';
  const timeText = piece ? pieceTimeText(piece) : item.allDay ? 'весь день' : formatClock(start);
  const when = continued ? formatSpan(item) : `${formatDayFull(start)} ${timeText}`;
  const aria = isDraft
    ? `Черновик: ${item.title}, ${formatDayFull(start)} ${timeText} — нажми, чтобы добавить`
    : `${TYPE_LABELS[item.type].one}, ${when} — ${item.title}${done ? ' (сделано)' : ''}${fromPrevDay ? ' · продолжение' : ''}`;

  let style: CSSProperties | undefined;
  if (mode === 'grid' && placement?.rail) {
    // A multi-day piece: a narrow rail at the left edge of the column.
    style = { top: placement.top, height: placement.height, left: 3 + placement.lane * RAIL_PX, width: RAIL_PX - 2 };
  } else if (mode === 'grid' && placement) {
    // Overlapping events share the column after the rails; a lone event spans it (3px gutters as in the mock-up).
    const share = `(100% - 6px - ${placement.inset}px) / ${placement.lanes}`;
    style = {
      top: placement.top,
      height: placement.height,
      left: `calc(3px + ${placement.inset}px + ${share} * ${placement.lane})`,
      width: `calc(${share} - ${placement.lanes > 1 ? 2 : 0}px)`,
    };
  }

  return (
    <button
      type="button"
      className={`kc-ev ${mode === 'grid' ? 'kc-ev-grid' : 'kc-ev-pill'}${rail ? ' kc-ev-rail' : ''}`}
      data-type={item.type}
      data-long={long ? '' : undefined}
      data-done={done ? '' : undefined}
      data-next={isNext && !done ? '' : undefined}
      data-draft={isDraft ? '' : undefined}
      data-from-prev={fromPrevDay ? '' : undefined}
      data-to-next={toNextDay ? '' : undefined}
      aria-pressed={selected}
      aria-label={aria}
      title={aria}
      style={style}
      onClick={onPick}
    >
      {mode === 'pill' ? (
        <>
          <span className="kc-ev-ic"><TypeIcon type={item.type} size={11} strokeWidth={1.8} /></span>
          <span className="kb-m kc-ev-time">{timeText}</span>
          <span className="kc-ev-title">{itemShortTitle(item)}</span>
          {item.status === 'no_answer' && <span className="kc-warn" aria-hidden="true" />}
        </>
      ) : rail ? (
        <>
          <span className="kc-ev-ic"><TypeIcon type={item.type} size={12} strokeWidth={1.8} /></span>
          {/* Read top to bottom along the rail: what it is and until when. */}
          <span className="kc-ev-rail-text">
            {item.title}
            <span className="kb-m kc-ev-rail-span">{' · '}{formatSpan(item)}</span>
          </span>
        </>
      ) : (
        <>
          <span className="kc-ev-line">
            <span className="kc-ev-ic"><TypeIcon type={item.type} size={12} strokeWidth={1.8} /></span>
            {long ? (
              <span className="kb-m kc-ev-range">
                {continued ? formatSpan(item) : `${formatClock(start)}–${formatClock(end)}`}{countdown ? ` · ${countdown}` : ''}
              </span>
            ) : (
              <span className="kc-ev-title">{item.title}</span>
            )}
            {item.status === 'no_answer' && <span className="kc-warn" aria-hidden="true" />}
          </span>
          {long && (
            <>
              <span className="kc-ev-big">{item.title}</span>
              <span className="kc-ev-sub">{isDraft ? 'черновик — нажми, чтобы добавить' : itemSubline(item)}</span>
            </>
          )}
        </>
      )}
    </button>
  );
}
