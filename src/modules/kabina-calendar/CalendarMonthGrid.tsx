import CalendarEventButton from '@/modules/kabina-calendar/CalendarEventButton';
import { dayPieces, formatDayFull, isContinued, isSameDay, plural, startOfDay } from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarItem } from '@/shared/types';

type CalendarMonthGridProps = {
  days: Date[];
  /** The month being shown; days of the neighbouring months are hatched. */
  month: number;
  items: CalendarItem[];
  selectedId: string | null;
  nextId: string | null;
  now: Date;
  isPhone: boolean;
  onPick: (item: CalendarItem) => void;
  onAddDraft: () => void;
  onOpenDay: (day: Date) => void;
};

const WEEKDAYS = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];
/** Pills per cell before «+N ещё». */
const MAX_PILLS = 3;

/** «Месяц»: whole weeks in a 7-column board; a day opens its «День» view, a pill selects the event. */
export default function CalendarMonthGrid({ days, month, items, selectedId, nextId, now, isPhone, onPick, onAddDraft, onOpenDay }: CalendarMonthGridProps) {
  const todayStart = startOfDay(now).getTime();
  return (
    <div className="kc-board kb-bz" data-view="month" role="region" aria-label="Месяц">
      <div className="kc-month">
        {WEEKDAYS.map((weekday) => <div key={weekday} className="kb-m kc-month-w">{weekday}</div>)}
        {days.map((day) => {
          // An event over several days is a bar piece in every cell it touches.
          const mine = dayPieces(items, day);
          // Every event of the day counts, the server's timers too — the number is what the cell holds.
          const total = mine.filter((piece) => piece.item.id !== 'draft').length;
          // Days before today are hatched «прошло», as in the legend.
          const past = day.getTime() < todayStart;
          // The server's nightly timers would fill every cell; people and Claude come first.
          // Multi-day bars lead the cell, so a trip keeps its row from one day to the next.
          const ordered = [
            ...mine.filter((piece) => isContinued(piece)),
            ...mine.filter((piece) => !isContinued(piece) && piece.item.type !== 'server_schedule'),
            ...mine.filter((piece) => !isContinued(piece) && piece.item.type === 'server_schedule'),
          ];
          const shown = ordered.slice(0, MAX_PILLS);
          const hidden = ordered.length - shown.length;
          return (
            <div
              key={day.toISOString()}
              className="kc-month-cell"
              data-today={isSameDay(day, now) ? '' : undefined}
              data-outside={day.getMonth() !== month ? '' : undefined}
              data-past={past ? '' : undefined}
            >
              <button
                type="button"
                className="kc-month-day"
                aria-label={`${formatDayFull(day)} · ${total} ${plural(total, 'событие', 'события', 'событий')} — открыть день`}
                onClick={() => onOpenDay(day)}
              >
                <span className="kb-t kc-month-n">{day.getDate()}</span>
                {!isPhone && total > 0 && <span className="kb-m kc-month-c">{total}</span>}
              </button>
              {isPhone ? (
                mine.length > 0 && (
                  <span className="kc-month-dots" aria-hidden="true">
                    {ordered.slice(0, 6).map((piece) => <span key={piece.item.id} data-type={piece.item.type} />)}
                  </span>
                )
              ) : (
                <>
                  {shown.map((piece) => (
                    <CalendarEventButton
                      key={piece.item.id}
                      item={piece.item}
                      piece={piece}
                      mode="pill"
                      selected={piece.item.id === selectedId}
                      isNext={piece.item.id === nextId}
                      isDraft={piece.item.id === 'draft'}
                      nowMs={now.getTime()}
                      onPick={piece.item.id === 'draft' ? onAddDraft : () => onPick(piece.item)}
                    />
                  ))}
                  {hidden > 0 && (
                    <button type="button" className="kb-m kc-month-more" onClick={() => onOpenDay(day)}>
                      +{hidden} ещё
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
