import { Button, IconButton, Segmented } from '@/modules/kabina';
import { ChevronIcon, SyncIcon } from '@/modules/kabina-calendar/CalendarIcons';
import { formatAgo, viewHeading } from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarView } from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarSyncStatus } from '@/shared/types';

type CalendarToolbarProps = {
  view: CalendarView;
  anchor: Date;
  nowMs: number;
  sync: CalendarSyncStatus | null;
  isSyncing: boolean;
  onStep: (step: -1 | 1) => void;
  onToday: () => void;
  onView: (view: CalendarView) => void;
  onSync: () => void;
};

const VIEWS: Array<{ value: CalendarView; label: string }> = [
  { value: 'day', label: 'День' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
];

/** The badge text of the Google sync («Google · синхронизировано 2 мин назад»). */
function describeSync(sync: CalendarSyncStatus | null, isSyncing: boolean, nowMs: number): { led: string; main: string; sub: string } {
  if (!sync) return { led: 'kb-led-idle', main: 'Google · проверяю…', sub: 'синхронизация календаря' };
  if (!sync.enabled) return { led: 'kb-led-idle', main: 'Google · не подключён', sub: sync.reason ?? 'синхронизация выключена' };
  const calendar = `календарь «${sync.calendarName ?? sync.calendarId ?? 'Google'}» · в обе стороны`;
  if (isSyncing || sync.state === 'syncing') return { led: 'kb-led-run', main: 'Google · синхронизирую…', sub: calendar };
  if (sync.state === 'error') {
    return { led: 'kb-led-warn', main: `Google · ошибка${sync.lastSuccessAt ? `, удачно ${formatAgo(sync.lastSuccessAt, nowMs)}` : ''}`, sub: sync.lastError ?? calendar };
  }
  if (!sync.lastSuccessAt) return { led: 'kb-led-idle', main: 'Google · ещё не синхронизировано', sub: calendar };
  const pending = sync.pendingPush + sync.pendingDeletes;
  return {
    led: 'kb-led-ok',
    main: `Google · синхронизировано ${formatAgo(sync.lastSuccessAt, nowMs)}`,
    sub: pending ? `${calendar} · ждут отправки: ${pending}` : calendar,
  };
}

/** DarkCalendar's top row: step back/forward, the week title, «Сегодня», День/Неделя/Месяц, Google status. */
export default function CalendarToolbar({ view, anchor, nowMs, sync, isSyncing, onStep, onToday, onView, onSync }: CalendarToolbarProps) {
  const heading = viewHeading(view, anchor);
  const badge = describeSync(sync, isSyncing, nowMs);
  return (
    <section className="kc-toolbar kb-rise" aria-label="Неделя и синхронизация">
      <div className="kc-nav">
        <IconButton aria-label={heading.prevLabel} onClick={() => onStep(-1)}><ChevronIcon direction="left" /></IconButton>
        <IconButton aria-label={heading.nextLabel} onClick={() => onStep(1)}><ChevronIcon direction="right" /></IconButton>
      </div>
      <div className="kc-heading">
        <span className="kb-m kc-eyebrow">{heading.eyebrow}</span>
        <h1 className="kb-t kc-title">{heading.title}</h1>
      </div>
      <Button variant="ghost" className="kc-today" onClick={onToday}>Сегодня</Button>
      <div className="kb-spacer" />
      <div className="kc-views">
        <Segmented ariaLabel="Вид календаря" options={VIEWS} value={view} onChange={onView} />
      </div>
      <div className="kc-sync kb-bz" title={sync?.lastError ?? undefined}>
        <span className={`kb-led ${badge.led}`} aria-hidden="true" />
        <span className="kc-sync-text" aria-live="polite">
          <span className="kc-sync-main">{badge.main}</span>
          <span className="kb-m kc-sync-sub">{badge.sub}</span>
        </span>
        <IconButton
          aria-label="Синхронизировать с Google сейчас"
          aria-busy={isSyncing}
          disabled={!sync?.enabled || isSyncing}
          onClick={onSync}
        >
          <SyncIcon size={15} />
        </IconButton>
      </div>
    </section>
  );
}
