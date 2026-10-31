import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import '@/modules/kabina-calendar/kabinaCalendar.css';
import { IconButton, Panel, SectionRuler, Sheet, panelZoneLabel, usePanelTimeZone } from '@/modules/kabina';
import { useTelegramLink } from '@/modules/kabina-notifications';
import CalendarEventPanel from '@/modules/kabina-calendar/CalendarEventPanel';
import CalendarFilters from '@/modules/kabina-calendar/CalendarFilters';
import { CloseIcon, WarnIcon } from '@/modules/kabina-calendar/CalendarIcons';
import CalendarMonthGrid from '@/modules/kabina-calendar/CalendarMonthGrid';
import CalendarQuickAdd from '@/modules/kabina-calendar/CalendarQuickAdd';
import CalendarTimeGrid from '@/modules/kabina-calendar/CalendarTimeGrid';
import CalendarToolbar from '@/modules/kabina-calendar/CalendarToolbar';
import { useCalendarEvents } from '@/modules/kabina-calendar/hooks/useCalendarEvents';
import { useCalendarSync } from '@/modules/kabina-calendar/hooks/useCalendarSync';
import {
  TYPE_ORDER,
  findNextItem,
  formatClock,
  isPersonType,
  isSameDay,
  plural,
  shiftAnchor,
  startOfDay,
  viewRange,
  fromWall,
  toWall,
} from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarView } from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarEventType, CalendarItem, KabinaProjectRef } from '@/shared/types';

type KabinaCalendarScreenProps = {
  isPhone: boolean;
  projects: KabinaProjectRef[];
};

/** «сейчас» moves every half minute. */
const NOW_TICK_MS = 30_000;

function useNow(): Date {
  // The current time for the «сейчас» line and countdowns.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), NOW_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** `?date=2026-10-27` from the home screen or a link; today otherwise. */
function readAnchor(search: string): Date {
  const raw = new URLSearchParams(search).get('date');
  const match = raw ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null;
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : startOfDay(toWall(Date.now()));
}

/** Used by the Kabina workspace route for `/calendar`: DarkCalendar on `/api/calendar/*`. */
export default function KabinaCalendarScreen({ isPhone, projects }: KabinaCalendarScreenProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const now = useNow();
  const nowMs = now.getTime();
  // The panel zone (the server reports it); the grid re-renders when the answer arrives.
  const panelZone = usePanelTimeZone();
  // The same moment on the panel's wall clock, for the grid.
  const nowWall = useMemo(() => toWall(nowMs), [nowMs, panelZone]);

  // День / Неделя / Месяц; the phone starts on the day (the week grid needs 760px).
  const [view, setView] = useState<CalendarView>(() => {
    const requested = new URLSearchParams(location.search).get('view');
    if (requested === 'day' || requested === 'week' || requested === 'month') return requested;
    return isPhone ? 'day' : 'week';
  });
  // Any date inside the period on screen.
  const [anchor, setAnchor] = useState<Date>(() => readAnchor(location.search));
  // The selected event; kept while it scrolls out of the range so the panel stays put.
  const [selected, setSelected] = useState<CalendarItem | null>(null);
  // `?event=` to select once the listing arrives (from the home screen), or `auto` for «nearest».
  const pendingSelectRef = useRef<string | null>(new URLSearchParams(location.search).get('event') ?? (isPhone ? null : 'auto'));
  // Types switched off in the filter.
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<CalendarEventType>>(() => new Set());
  // `all`, `none` or a project id.
  const [projectFilter, setProjectFilter] = useState('all');
  // The quick-add draft drawn dashed in the grid.
  const [draft, setDraft] = useState<CalendarItem | null>(null);
  const addDraftRef = useRef<() => void>(() => undefined);

  const range = useMemo(() => viewRange(view, anchor), [view, anchor]);
  const rangeFrom = useMemo(() => fromWall(range.from), [range.from]);
  const rangeTo = useMemo(() => fromWall(range.to), [range.to]);
  const { items, error, loadedAt, refresh, replaceItem, removeItem } = useCalendarEvents(rangeFrom, rangeTo);
  const { status: syncStatus, isSyncing, syncNow } = useCalendarSync(refresh);
  const googleEnabled = Boolean(syncStatus?.enabled);
  // Reminders go to Telegram only when the bot has a linked chat.
  const telegramStatus = useTelegramLink().status;
  const telegramLinked = Boolean(telegramStatus?.configured && telegramStatus.linked);

  const allItems = useMemo(() => items ?? [], [items]);

  // Keep the selected copy fresh when the listing changes; select `?event=` / the nearest one once.
  useEffect(() => {
    if (!items) return;
    const pending = pendingSelectRef.current;
    if (pending) {
      pendingSelectRef.current = null;
      const target = pending === 'auto'
        ? findNextItem(items.filter((item) => isPersonType(item.type)), Date.now()) ?? findNextItem(items, Date.now())
        : items.find((item) => item.id === pending || item.occurrenceOf === pending) ?? null;
      if (target) setSelected(target);
      return;
    }
    setSelected((current) => (current ? items.find((item) => item.id === current.id) ?? current : current));
  }, [items]);

  const typeCounts = useMemo(() => {
    const counts = Object.fromEntries(TYPE_ORDER.map((type) => [type, 0])) as Record<CalendarEventType, number>;
    allItems.forEach((item) => {
      counts[item.type] += 1;
    });
    return counts;
  }, [allItems]);

  const projectChips = useMemo(() => {
    const byProject = new Map<string, { id: string; name: string; count: number }>();
    let withoutProject = 0;
    allItems.forEach((item) => {
      if (item.type === 'server_schedule') return;
      if (!item.projectId) {
        withoutProject += 1;
        return;
      }
      const name = item.projectName ?? projects.find((project) => project.projectId === item.projectId)?.displayName ?? item.projectId;
      const entry = byProject.get(item.projectId) ?? { id: item.projectId, name, count: 0 };
      entry.count += 1;
      byProject.set(item.projectId, entry);
    });
    const chips = [...byProject.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')).slice(0, 5);
    if (projectFilter !== 'all' && projectFilter !== 'none' && !chips.some((chip) => chip.id === projectFilter)) {
      const name = projects.find((project) => project.projectId === projectFilter)?.displayName ?? projectFilter;
      chips.push({ id: projectFilter, name, count: 0 });
    }
    const list = chips.map(({ id, name }) => ({ id, name }));
    if (withoutProject > 0 || projectFilter === 'none') list.push({ id: 'none', name: 'Без проекта' });
    return list;
  }, [allItems, projectFilter, projects]);

  const visibleItems = useMemo(() => allItems.filter((item) => {
    if (hiddenTypes.has(item.type)) return false;
    if (projectFilter === 'all') return true;
    if (projectFilter === 'none') return !item.projectId && item.type !== 'server_schedule';
    return item.projectId === projectFilter;
  }), [allItems, hiddenTypes, projectFilter]);

  const gridItems = useMemo(() => (draft ? [...visibleItems, draft] : visibleItems), [draft, visibleItems]);
  const nextItem = useMemo(() => findNextItem(visibleItems, nowMs), [visibleItems, nowMs]);
  const serverCount = visibleItems.filter((item) => item.type === 'server_schedule').length;
  const eventCount = visibleItems.length;

  const pick = useCallback((item: CalendarItem) => setSelected(item), []);
  const openDay = useCallback((day: Date) => {
    setAnchor(startOfDay(day));
    setView('day');
  }, []);
  const handleAdded = useCallback((item: CalendarItem) => {
    setSelected(item);
    const start = toWall(item.startsAt);
    if (!range.days.some((day) => isSameDay(day, start))) setAnchor(startOfDay(start));
    refresh();
  }, [range.days, refresh]);
  const registerAdd = useCallback((add: () => void) => {
    addDraftRef.current = add;
  }, []);
  const openVoice = useCallback(() => {
    // The shell's voice overlay lives in the URL as `?voice` (Back closes it).
    const params = new URLSearchParams(location.search);
    params.delete('search');
    params.delete('voice');
    const rest = params.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}&voice` : '?voice' }, { state: { kabinaOverlay: 'voice' } });
  }, [location.pathname, location.search, navigate]);

  const rulerTitle = view === 'day' ? 'ДЕНЬ' : view === 'week' ? 'НЕДЕЛЯ' : 'МЕСЯЦ';
  const panel = (
    <CalendarEventPanel
      key={selected?.id ?? 'none'}
      item={selected}
      projects={projects}
      isNext={Boolean(selected && nextItem && selected.id === nextItem.id)}
      nowMs={nowMs}
      googleEnabled={googleEnabled}
      telegramLinked={telegramLinked}
      onChanged={(fresh) => {
        replaceItem(fresh);
        setSelected(fresh);
      }}
      onRefresh={refresh}
      onDeleted={(id, onlyThis) => {
        removeItem(id, onlyThis);
        setSelected(null);
        refresh();
      }}
      onNavigate={(to) => navigate(to)}
    />
  );

  return (
    <div className="kc-screen" data-phone={isPhone ? '' : undefined}>
      <CalendarToolbar
        view={view}
        anchor={anchor}
        nowMs={nowMs}
        sync={syncStatus}
        isSyncing={isSyncing}
        onStep={(step) => setAnchor((current) => shiftAnchor(view, current, step))}
        onToday={() => setAnchor(startOfDay(toWall(Date.now())))}
        onView={setView}
        onSync={() => void syncNow()}
      />

      <CalendarQuickAdd
        days={range.days}
        isPhone={isPhone}
        googleEnabled={googleEnabled}
        telegramLinked={telegramLinked}
        onDraft={setDraft}
        onAdded={handleAdded}
        onVoice={openVoice}
        registerAdd={registerAdd}
      />

      <CalendarFilters
        hiddenTypes={hiddenTypes}
        typeCounts={typeCounts}
        projects={projectChips}
        project={projectFilter}
        onToggleType={(type) => setHiddenTypes((current) => {
          const next = new Set(current);
          if (next.has(type)) next.delete(type);
          else next.add(type);
          return next;
        })}
        onProject={setProjectFilter}
      />

      <div className="kc-body">
        <main className="kc-main kb-rise kb-d3" aria-labelledby="kc-h-grid">
          <SectionRuler id="kc-h-grid" index="02" title={rulerTitle}>
            <span className="kb-m kb-ruler-meta">
              {items === null && !error ? 'гружу…' : error && items === null ? 'не загрузилось' : (
                `${eventCount} ${plural(eventCount, 'событие', 'события', 'событий')}${serverCount ? ` · ${serverCount} по расписанию сервера` : ''}`
              )}
            </span>
          </SectionRuler>
          {error && items !== null && (
            // A refresh failed after the grid had loaded: the grid stays, but it may be stale.
            <div className="kc-stale kb-fadein" role="status" aria-live="polite" aria-label="Календарь не обновился">
              <WarnIcon size={16} strokeWidth={1.7} />
              <span className="kc-stale-title">Календарь не обновился</span>
              {loadedAt !== null && (
                <span className="kb-m kc-stale-meta">показываю на {formatClock(toWall(loadedAt))}</span>
              )}
              <span className="kc-stale-text">{error}</span>
              <button type="button" className="kb-btn kb-ghost kc-stale-retry" onClick={refresh}>Повторить</button>
            </div>
          )}
          {error && items === null && (
            <Panel style={{ padding: 18, gap: 10 }}>
              <span className="kc-error-line">Календарь не загрузился: {error}</span>
              <button type="button" className="kb-btn kb-ghost" style={{ alignSelf: 'flex-start' }} onClick={refresh}>Повторить</button>
            </Panel>
          )}
          {view === 'month' ? (
            <CalendarMonthGrid
              days={range.days}
              month={anchor.getMonth()}
              items={gridItems}
              selectedId={selected?.id ?? null}
              nextId={nextItem?.id ?? null}
              now={nowWall}
              isPhone={isPhone}
              onPick={pick}
              onAddDraft={() => addDraftRef.current()}
              onOpenDay={openDay}
            />
          ) : (
            <CalendarTimeGrid
              view={view}
              days={range.days}
              items={gridItems}
              selectedId={selected?.id ?? null}
              nextId={nextItem?.id ?? null}
              now={nowWall}
              zoneLabel={panelZoneLabel(panelZone, now)}
              onPick={pick}
              onAddDraft={() => addDraftRef.current()}
              onOpenDay={(day) => (view === 'week' ? openDay(day) : undefined)}
            />
          )}
          <ul className="kc-legend" aria-label="Как читать сетку">
            <li><span className="kc-swatch" aria-hidden="true" style={{ background: '#1F1D1A', border: '1px solid rgba(255,236,210,0.16)' }} />с людьми — звонок, сообщение, встреча</li>
            <li><span className="kc-swatch" aria-hidden="true" style={{ background: 'rgba(255,106,43,0.08)', border: '1px solid rgba(255,106,43,0.5)' }} />Claude сделает сам</li>
            <li><span className="kc-swatch" aria-hidden="true" style={{ border: '1px dashed rgba(255,236,210,0.3)' }} />сервер по расписанию</li>
            <li><span aria-hidden="true" style={{ width: 7, height: 7, margin: '0 5px', borderRadius: 1, background: '#D9A35B', transform: 'rotate(45deg)' }} />нет ответа</li>
            <li><span className="kc-swatch" aria-hidden="true" style={{ background: 'repeating-linear-gradient(135deg, rgba(255,236,210,0.22) 0 1px, transparent 1px 4px)' }} />прошло</li>
          </ul>
        </main>

        {!isPhone && (
          <aside className="kc-aside kb-rise kb-d4" aria-labelledby="kc-h-sel">
            <SectionRuler id="kc-h-sel" index="03" title="ВЫБРАНО" scale="minor">
              {selected && (
                <IconButton size="sm" aria-label="Снять выбор" onClick={() => setSelected(null)} style={{ color: 'var(--kb-soft)' }}>
                  <CloseIcon size={14} strokeWidth={1.7} />
                </IconButton>
              )}
            </SectionRuler>
            <Panel as="section" className="kc-sel" aria-label="Выбранное событие">
              {panel}
            </Panel>
          </aside>
        )}
      </div>

      {isPhone && (
        <Sheet open={selected !== null} onClose={() => setSelected(null)} title="ВЫБРАНО">
          <div className="kc-sheet-body">{panel}</div>
        </Sheet>
      )}
    </div>
  );
}
