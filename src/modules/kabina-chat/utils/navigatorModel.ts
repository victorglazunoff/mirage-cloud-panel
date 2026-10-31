/**
 * Pure view model of the chat navigator (the dialogs list opened from the header crumbs and
 * the HUD): project rows with their status, and the flat list of rows the keyboard walks
 * (↑↓ ↵ ← →). No React here, so ordering, filtering and the keyboard map are unit-tested.
 */
import { formatSessionTime, plural } from '@/modules/kabina-chat/utils/chatFormat';
import type {
  HomeActivityItem,
  HomeProjectsBoard,
  NavItem,
  NavLiveState,
  NavProject,
  NavSection,
  NavSession,
  NavSessionsPage,
} from '@/shared/types';

const STATUS_RANK: Record<NavLiveState, number> = { wait: 0, run: 1, idle: 2 };

/** Live state of each dialog across the panel, from the board's activity. */
export function liveStatesBySession(activity: HomeActivityItem[]): Map<string, NavLiveState> {
  const states = new Map<string, NavLiveState>();
  for (const item of activity) {
    if (item.state === 'waiting') states.set(item.sessionId, 'wait');
    else if (!states.has(item.sessionId)) states.set(item.sessionId, 'run');
  }
  return states;
}

/**
 * Every project that is not archived: favourites first, inside each group waiting, then
 * running, then the most recently touched.
 */
export function buildNavProjects(board: HomeProjectsBoard, now: Date = new Date()): NavProject[] {
  const workByProject = new Map<string, HomeActivityItem[]>();
  for (const item of board.activity) {
    if (!item.projectId) continue;
    const list = workByProject.get(item.projectId) ?? [];
    list.push(item);
    workByProject.set(item.projectId, list);
  }
  const rows = board.projects
    .filter((project) => !project.isArchived)
    .map<NavProject>((project) => {
      const work = workByProject.get(project.projectId) ?? [];
      const status: NavLiveState = work.some((item) => item.state === 'waiting') ? 'wait' : work.length > 0 ? 'run' : 'idle';
      const statusWord = status === 'wait'
        ? 'ждёт тебя'
        : status === 'run'
          ? 'работает'
          : project.sessionCount === 0 ? 'новый' : 'тихо';
      return {
        id: project.projectId,
        name: project.displayName,
        path: project.projectPath,
        isStarred: project.isStarred,
        status,
        statusWord,
        sessionCount: project.sessionCount,
        lastActivityMs: project.lastActivity ? Date.parse(project.lastActivity) || 0 : 0,
        lastLabel: formatSessionTime(project.lastActivity ?? undefined, now),
        lastSessionId: project.lastSessionId,
      };
    });
  return rows.sort((a, b) => Number(b.isStarred) - Number(a.isStarred)
    || STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || b.lastActivityMs - a.lastActivityMs
    || a.name.localeCompare(b.name, 'ru'));
}

/** Lower-cased, single-spaced, «ё» as «е» — so «Общая» and «общая», «ещё» and «еще» match. */
export function normalizeQuery(value: string): string {
  return value.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** The project's name or folder contains the query. */
export function projectMatches(project: NavProject, needle: string): boolean {
  return !needle || normalizeQuery(project.name).includes(needle) || normalizeQuery(project.path).includes(needle);
}

/** The dialog's title contains the query. */
export function sessionMatches(session: NavSession, needle: string): boolean {
  return !needle || normalizeQuery(session.title).includes(needle);
}

/** «9 диалогов». */
export function dialogsWord(count: number): string {
  return `${count} ${plural(count, 'диалог', 'диалога', 'диалогов')}`;
}

/** The unfolded project's rows: its dialogs, «ещё N», «+ Новый диалог». */
function projectChildren(project: NavProject, page: NavSessionsPage | undefined, currentProjectId: string, currentSessions: NavSession[], currentHasMore: boolean): NavItem[] {
  const isCurrent = project.id === currentProjectId;
  const sessions = isCurrent ? currentSessions : page?.sessions ?? [];
  const items: NavItem[] = [{ key: `p:${project.id}:new`, kind: 'new', projectId: project.id, depth: 1 }];
  if (!isCurrent && !page) {
    items.push({ key: `p:${project.id}:loading`, kind: 'loading', projectId: project.id });
    return items;
  }
  for (const session of sessions) {
    items.push({ key: `p:${project.id}:s:${session.id}`, kind: 'session', projectId: project.id, session, depth: 1 });
  }
  if (!isCurrent && page?.loading) items.push({ key: `p:${project.id}:loading`, kind: 'loading', projectId: project.id });
  const hasMore = isCurrent ? currentHasMore : Boolean(page?.hasMore);
  if (hasMore && !(page?.loading && !isCurrent)) {
    const total = isCurrent ? project.sessionCount : page?.total ?? project.sessionCount;
    const remaining = total > sessions.length ? total - sessions.length : null;
    items.push({ key: `p:${project.id}:more`, kind: 'more', projectId: project.id, depth: 1, remaining });
  }
  return items;
}

function projectWithChildren(project: NavProject, expanded: ReadonlySet<string>, pages: ReadonlyMap<string, NavSessionsPage>, currentProjectId: string, currentSessions: NavSession[], currentHasMore: boolean): NavItem[] {
  const isOpen = expanded.has(project.id);
  const row: NavItem = { key: `p:${project.id}`, kind: 'project', project, expanded: isOpen };
  return isOpen ? [row, ...projectChildren(project, pages.get(project.id), currentProjectId, currentSessions, currentHasMore)] : [row];
}

type BuildInput = {
  tab: 'here' | 'all';
  query: string;
  currentProjectId: string;
  /** Dialogs of the open project (the workspace's list — fresh, streamed). */
  currentSessions: NavSession[];
  currentHasMore: boolean;
  projects: NavProject[];
  expanded: ReadonlySet<string>;
  pages: ReadonlyMap<string, NavSessionsPage>;
  /** Archived dialogs of the open project (null until loaded) and whether they are unfolded. */
  archived: NavSession[] | null;
  isArchiveOpen: boolean;
  /** Dialogs of other projects whose title matched on the server (search). */
  titleHits: NavSession[];
};

/**
 * The sections the navigator shows: «Этот проект» (new, dialogs, more, archive), «Все проекты»
 * (favourites, the rest — unfoldable) or, while searching, matches from all three sources.
 */
export function buildNavSections(input: BuildInput): NavSection[] {
  const { tab, currentProjectId, currentSessions, currentHasMore, projects, expanded, pages, archived, isArchiveOpen, titleHits } = input;
  const needle = normalizeQuery(input.query);
  const unfold = (project: NavProject) => projectWithChildren(project, expanded, pages, currentProjectId, currentSessions, currentHasMore);

  if (needle) {
    const sections: NavSection[] = [];
    const here = currentSessions.filter((session) => sessionMatches(session, needle));
    if (here.length > 0) {
      sections.push({
        id: 'here',
        title: 'ЭТОТ ПРОЕКТ',
        count: here.length,
        items: here.map((session) => ({ key: `h:${session.id}`, kind: 'session' as const, projectId: currentProjectId, session, depth: 0 as const })),
      });
    }
    const matchedProjects = projects.filter((project) => projectMatches(project, needle));
    if (matchedProjects.length > 0) {
      sections.push({ id: 'projects', title: 'ПРОЕКТЫ', count: matchedProjects.length, items: matchedProjects.flatMap(unfold) });
    }
    // Other projects' dialogs: what the server found by title, plus unfolded pages already in memory.
    const seen = new Set(here.map((session) => session.id));
    const others: NavSession[] = [];
    const names = new Map(projects.map((project) => [project.id, project.name]));
    const add = (session: NavSession) => {
      if (session.projectId === currentProjectId || seen.has(session.id) || !sessionMatches(session, needle)) return;
      seen.add(session.id);
      others.push({ ...session, projectName: session.projectName ?? names.get(session.projectId) });
    };
    titleHits.forEach(add);
    pages.forEach((page) => page.sessions.forEach(add));
    if (others.length > 0) {
      sections.push({
        id: 'others',
        title: 'ДИАЛОГИ В ДРУГИХ ПРОЕКТАХ',
        count: others.length,
        items: others.map((session) => ({ key: `o:${session.id}`, kind: 'session' as const, projectId: session.projectId, session, depth: 0 as const })),
      });
    }
    return sections;
  }

  if (tab === 'here') {
    const items: NavItem[] = [{ key: 'h:new', kind: 'new', projectId: currentProjectId, depth: 0 }];
    for (const session of currentSessions) {
      items.push({ key: `h:${session.id}`, kind: 'session', projectId: currentProjectId, session, depth: 0 });
    }
    if (currentHasMore) items.push({ key: 'h:more', kind: 'more', projectId: currentProjectId, depth: 0, remaining: null });
    // The archive row shows only when there is something in it.
    if ((archived && archived.length > 0) || isArchiveOpen) {
      items.push({ key: 'h:archive', kind: 'archive', count: archived ? archived.length : null, open: isArchiveOpen });
    }
    if (isArchiveOpen) {
      for (const session of archived ?? []) items.push({ key: `a:${session.id}`, kind: 'archived', session });
    }
    return [{ id: 'here', title: 'ДИАЛОГИ', count: currentSessions.length, items }];
  }

  const starred = projects.filter((project) => project.isStarred);
  const rest = projects.filter((project) => !project.isStarred);
  const sections: NavSection[] = [];
  if (starred.length > 0) sections.push({ id: 'starred', title: 'ИЗБРАННЫЕ', count: starred.length, items: starred.flatMap(unfold) });
  if (rest.length > 0) sections.push({ id: 'rest', title: starred.length > 0 ? 'ОСТАЛЬНЫЕ' : 'ПРОЕКТЫ', count: rest.length, items: rest.flatMap(unfold) });
  return sections;
}

/** Rows that react to the keyboard (spinners do not). */
export function focusableItems(sections: NavSection[]): NavItem[] {
  return sections.flatMap((section) => section.items).filter((item) => item.kind !== 'loading');
}

/** The project row an unfolded child belongs to (for «←»). */
export function parentProjectKey(item: NavItem): string | null {
  if ((item.kind === 'session' || item.kind === 'new' || item.kind === 'more') && item.depth === 1) return `p:${item.projectId}`;
  return null;
}
