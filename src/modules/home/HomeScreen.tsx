import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

import '@/modules/home/homeScreen.css';
import { useAuth } from '@/modules/auth';
import { EmptyState, LimitWarnings, LoadErrorState, fromPanelWall, toPanelWall, usePanelTimeZone } from '@/modules/kabina';
import { useCalendarEvents } from '@/modules/kabina-calendar';
import HomeActivityList from '@/modules/home/HomeActivityList';
import HomeCalendar from '@/modules/home/HomeCalendar';
import HomeFavorites from '@/modules/home/HomeFavorites';
import HomeLimits from '@/modules/home/HomeLimits';
import HomeLog from '@/modules/home/HomeLog';
import HomeSummary from '@/modules/home/HomeSummary';
import HomeWaitingCard from '@/modules/home/HomeWaitingCard';
import { calendarItemsToHomeEvents } from '@/modules/home/utils/homeCalendarEvents';
import { greetingName } from '@/modules/home/utils/homeFormatting';
import { layoutHomeWidgets } from '@/modules/home/utils/homeWidgets';
import type { HomeWidgetSlot } from '@/modules/home/utils/homeWidgets';
import { useHomeWidgets } from '@/modules/home/hooks/useHomeWidgets';
import { useNow } from '@/modules/home/hooks/useNow';
import { useHomeOverviewFeed } from '@/shared/hooks/useHomeOverviewFeed';
import { isSubscriptionLimitsEnabled, useSubscriptionLimits } from '@/shared/hooks/useSubscriptionLimits';
import { useMirageSettingsView } from '@/shared/hooks/useMirageSettingsView';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { HomeActivityItem, HomeFavoriteProject, HomeScheduledEvent, Project } from '@/shared/types';

/** The home block shows people and Claude, not the server's timers. */
const CALENDAR_TYPES = 'call,message,meeting,agent_task';

type HomeScreenProps = {
  /** The workspace's loaded projects; favourites resolve to these objects. */
  projects: Project[];
  isMobile: boolean;
  /**
   * Classic interface: the screen sits in the authors' layout (no Kabina
   * shell around it), so it brings its own dark background and padding.
   */
  embedded?: boolean;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
  onOpenProject: (project: Project) => void;
  /** Opens the project list (`/projects` in Kabina, the sidebar drawer in classic). */
  onOpenProjectList: () => void;
  /** Kabina only: the search overlay (phone search row). */
  onOpenSearch?: () => void;
  /** Kabina only: the calendar screen («+ Событие», phone events). */
  onOpenCalendar?: () => void;
  /** Kabina only: the agents screen (phone «РАБОТАЮТ» cell). */
  onOpenAgents?: () => void;
  /** Kabina only: «Подробнее →» of the limits block. */
  onOpenLimits?: () => void;
  /** Kabina only: a calendar call, message or meeting opened in the calendar screen. */
  onOpenCalendarEvent?: (eventId: string, startsAt: string) => void;
};

/** A prompt answered from this screen: shown as «разрешено один раз» until the overview catches up. */
type AllowedPrompt = { sessionId: string; projectId: string | null; projectName: string; at: Date };

/**
 * Used by the project-workspace module: the «Кабина» home screen (DarkMain on a
 * desktop, DarkPhoneMain on a phone) on live data — summary board, favourites,
 * what is running, the log, the week and today's events, subscription limits.
 */
export function HomeScreen({
  projects,
  isMobile,
  embedded = false,
  onOpenSession,
  onOpenProject,
  onOpenProjectList,
  onOpenSearch,
  onOpenCalendar,
  onOpenAgents,
  onOpenLimits,
  onOpenCalendarEvent,
}: HomeScreenProps) {
  const { user } = useAuth();
  const mirageSettings = useMirageSettingsView();
  const now = useNow();
  const { overview, error: overviewError, refresh } = useHomeOverviewFeed();
  // Widget order and switches from the settings (DarkSettings 03).
  const widgetSettings = useHomeWidgets();
  // The week from today (00:00 on the panel's clock) for the calendar block: calls, messages, meetings, Claude's tasks.
  const panelZone = usePanelTimeZone();
  const wallToday = toPanelWall(now, panelZone);
  const dayKey = `${panelZone}|${wallToday.toDateString()}`;
  const calendarFrom = useMemo(() => fromPanelWall(new Date(wallToday.getFullYear(), wallToday.getMonth(), wallToday.getDate()), panelZone), [dayKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const calendarTo = useMemo(() => new Date(calendarFrom.getTime() + 7 * 86_400_000), [calendarFrom]);
  const { items: calendarItems } = useCalendarEvents(calendarFrom, calendarTo, CALENDAR_TYPES);
  const openCalendarEvent = useMemo(
    () => (onOpenCalendarEvent ? (event: HomeScheduledEvent) => onOpenCalendarEvent(event.calendar?.eventId ?? event.id, event.scheduledFor) : undefined),
    [onOpenCalendarEvent],
  );
  const calendarEvents = useMemo(
    () => (calendarItems ? calendarItemsToHomeEvents(calendarItems) : overview?.scheduled ?? null),
    [calendarItems, overview?.scheduled],
  );
  const limits = useSubscriptionLimits();
  const { sendMessage } = useWebSocket();
  // The prompt just allowed from the phone card; replaces the card for a moment.
  const [allowed, setAllowed] = useState<AllowedPrompt | null>(null);
  // Why «Разрешить 1 раз» did not go through (socket down), shown on the card.
  const [allowError, setAllowError] = useState<string | null>(null);

  const projectsById = useMemo(() => new Map(projects.map((project) => [project.projectId, project])), [projects]);

  const handleOpenFavorite = useCallback((favorite: HomeFavoriteProject) => {
    if (favorite.lastSessionId) {
      onOpenSession(favorite.lastSessionId, favorite.projectId);
      return;
    }
    const project = projectsById.get(favorite.projectId);
    if (project) onOpenProject(project);
  }, [onOpenProject, onOpenSession, projectsById]);

  const handleScrollTo = useCallback((elementId: string) => {
    document.getElementById(elementId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleAllowOnce = useCallback((item: HomeActivityItem) => {
    const requestId = item.permission?.requestId;
    if (!requestId) {
      onOpenSession(item.sessionId, item.projectId);
      return;
    }
    const sent = sendMessage({ type: 'chat.permission-response', requestId, allow: true });
    if (!sent) {
      setAllowError('Нет связи с сервером — разрешение не ушло. Попробуй ещё раз через пару секунд.');
      return;
    }
    setAllowError(null);
    setAllowed({ sessionId: item.sessionId, projectId: item.projectId, projectName: item.projectName, at: new Date() });
    window.setTimeout(refresh, 600);
  }, [onOpenSession, refresh, sendMessage]);

  // The «разрешено» row stays a minute, then the screen is back to live data only.
  useEffect(() => {
    if (!allowed) return undefined;
    const timer = window.setTimeout(() => setAllowed(null), 60_000);
    return () => window.clearTimeout(timer);
  }, [allowed]);

  const activity = overview?.activity ?? null;
  const waiting = (activity ?? []).filter((item) => item.state === 'waiting' && item.sessionId !== allowed?.sessionId);
  const userName = greetingName(mirageSettings?.settings.profile?.displayName, user?.username);

  const summary = (
    <HomeSummary
      now={now}
      userName={userName}
      activity={activity}
      scheduled={calendarEvents}
      isPhone={isMobile}
      onOpenSession={onOpenSession}
      onScrollTo={handleScrollTo}
      onOpenSearch={onOpenSearch}
      onOpenAgents={onOpenAgents}
      onOpenCalendar={onOpenCalendar}
    />
  );

  const favorites = (index: string) => (
    <HomeFavorites
      index={index}
      favorites={overview?.favorites ?? null}
      activity={activity ?? []}
      projectCount={overview?.projectCount ?? projects.length}
      now={now}
      isPhone={isMobile}
      onOpenFavorite={handleOpenFavorite}
      onOpenProjectList={onOpenProjectList}
    />
  );

  // DarkSettings 03: which blocks are shown and in which order.
  // Without the server's limits counter the «Лимиты» block is not drawn at all.
  const limitsEnabled = isSubscriptionLimitsEnabled(limits);
  const layout = useMemo(() => layoutHomeWidgets(widgetSettings, isMobile, limitsEnabled), [widgetSettings, isMobile, limitsEnabled]);

  const renderWidget = (slot: HomeWidgetSlot, isPhone: boolean) => {
    switch (slot.id) {
      case 'fav':
        return <Fragment key="fav">{favorites(slot.index)}</Fragment>;
      case 'work':
        return isPhone ? (
          <HomeWaitingCard
            key="work"
            waiting={waiting}
            allowed={allowed}
            allowError={allowError}
            now={now}
            onAllowOnce={handleAllowOnce}
            onOpenSession={onOpenSession}
          />
        ) : (
          <HomeActivityList key="work" index={slot.index} activity={activity} now={now} onOpenSession={onOpenSession} />
        );
      case 'cal':
        return <HomeCalendar key="cal" index={slot.index} scheduled={calendarEvents} now={now} isPhone={isPhone} onOpenSession={onOpenSession} onAddEvent={onOpenCalendar} onOpenEvent={openCalendarEvent} />;
      case 'lim':
        return <HomeLimits key="lim" index={slot.index} limits={limits} now={now} isPhone={isPhone} onOpenDetails={onOpenLimits} />;
      default:
        return null;
    }
  };

  // DarkStates L1–L3: active limits warnings as plaques under the summary.
  const limitWarnings = <LimitWarnings limits={limits} now={now} onOpenDetails={onOpenLimits} />;
  // DarkStates Z1: no projects at all — the home screen shows only this block.
  const hasNoProjects = overview !== null && overview.projectCount === 0 && projects.length === 0;

  let body;
  if (overview === null && overviewError) {
    // The first read failed: say so instead of an endless skeleton (the poll keeps retrying too).
    body = (
      <div className="mh-home" data-phone={isMobile ? '' : undefined}>
        <LoadErrorState title="Сводка не загрузилась" reason={overviewError} onRetry={refresh} className="kb-rise" />
      </div>
    );
  } else if (hasNoProjects) {
    body = (
      <div className="mh-home" data-phone={isMobile ? '' : undefined}>
        <EmptyState variant="projects" headingLevel="h2" actionLabel="Добавить проект" onAction={onOpenProjectList} className="kb-rise" />
      </div>
    );
  } else if (isMobile) {
    // DarkPhoneMain: what needs you first, then the widgets in the order of the settings.
    body = (
      <div className="mh-home" data-phone="">
        {summary}
        {limitWarnings}
        {layout.column.map((slot) => renderWidget(slot, true))}
      </div>
    );
  } else {
    body = (
      <div className="mh-home">
        {summary}
        {limitWarnings}
        <div className="mh-columns">
          <main className="mh-main">
            {layout.main.map((slot) => renderWidget(slot, false))}
            <HomeLog index={layout.logIndex ?? ''} recent={overview?.recent ?? null} now={now} onOpenSession={onOpenSession} onOpenProjectList={onOpenProjectList} />
          </main>
          {layout.aside.length > 0 && (
            <aside className="mh-aside">
              {layout.aside.map((slot) => renderWidget(slot, false))}
            </aside>
          )}
        </div>
      </div>
    );
  }

  if (!embedded) return body;
  return (
    <div className="kb-root mh-embedded" data-phone={isMobile ? '' : undefined}>
      <div className="mh-embedded-inner">{body}</div>
    </div>
  );
}
