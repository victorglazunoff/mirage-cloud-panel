/**
 * Pure view model of «Все проекты» (DarkProjects): statuses, groups, counters
 * and wording built from `api.home.projects`. No React here, so every phrase
 * the screen shows is unit-tested.
 */
import { toPanelWall } from '@/modules/kabina';
import type {
  HomeActivityItem,
  HomeBoardProject,
  HomeProjectsBoard,
  KabinaProjectsFilter as ProjectsFilter,
  KabinaProjectsGroup as ProjectsGroup,
  KabinaProjectsSort as ProjectsSort,
  KabinaProjectStatusKind as ProjectStatusKind,
  KabinaProjectView as ProjectView,
} from '@/shared/types';
import { pluralRu, tildePath } from '@/shared/utils';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Not starred and quiet for longer than this → the row is dimmed («тихие дольше недели приглушены»). */
const QUIET_DIM_MS = 7 * DAY_MS;

function formatClock(instant: Date): string {
  const date = toPanelWall(instant);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function startOfDay(ms: number): number {
  const date = toPanelWall(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 'сегодня 09:12', 'вчера 19:40', '24.10' (another year: '24.10.25'). */
export function formatLastActivity(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const instant = new Date(ms);
  const date = toPanelWall(ms);
  const dayDiff = Math.round((startOfDay(nowMs) - startOfDay(ms)) / DAY_MS);
  if (dayDiff <= 0) return `сегодня ${formatClock(instant)}`;
  if (dayDiff === 1) return `вчера ${formatClock(instant)}`;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return date.getFullYear() === toPanelWall(nowMs).getFullYear() ? `${dd}.${mm}` : `${dd}.${mm}.${String(date.getFullYear()).slice(2)}`;
}

/** 'сейчас', '12 мин', '2 ч', '3 ч 10 мин'. */
export function formatMinutesSince(sinceMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - sinceMs) / MINUTE_MS);
  if (minutes < 1) return 'сейчас';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

/** Display path: relative to the projects folder (`Проекты/x`) when inside it, else with `~`. */
export function shortProjectPath(fullPath: string, projectsFolder: string | null): string {
  if (projectsFolder && fullPath.startsWith(`${projectsFolder}/`)) {
    const folderName = projectsFolder.split('/').filter(Boolean).pop() ?? projectsFolder;
    return `${folderName}/${fullPath.slice(projectsFolder.length + 1)}`;
  }
  return tildePath(fullPath);
}

function agentsWord(count: number): string {
  return `${count} ${pluralRu(count, ['агент', 'агента', 'агентов'])}`;
}

/** Status line, sub-line and last column of a project from its live work and stats. */
function describeStatus(project: HomeBoardProject, work: HomeActivityItem[], nowMs: number) {
  const waiting = work.find((item) => item.state === 'waiting');
  if (waiting) {
    const since = Date.parse(waiting.permission?.receivedAt ?? '') || waiting.startedAt;
    const ago = formatMinutesSince(since, nowMs);
    return {
      kind: 'wait' as const,
      status: `Ждёт разрешения · ${ago}`,
      sub: waiting.permission?.summary || waiting.permission?.toolName || waiting.sessionTitle,
      last: ago === 'сейчас' ? 'сейчас' : `${ago} назад`,
      isLive: true,
    };
  }
  if (work.length > 0) {
    const oldest = Math.min(...work.map((item) => item.startedAt));
    const agents = work.reduce((total, item) => total + (item.state === 'background' ? 0 : 1) + item.tasks.length, 0);
    const lead = work.find((item) => item.state === 'running') ?? work[0];
    const what = lead.tasks[0]?.description || lead.sessionTitle;
    return {
      kind: 'run' as const,
      status: `Агент работает · ${formatMinutesSince(oldest, nowMs)}`,
      sub: `${agentsWord(Math.max(1, agents))} · ${what}`,
      last: 'сейчас',
      isLive: true,
    };
  }
  if (project.sessionCount === 0 && !project.isArchived) {
    return { kind: 'new' as const, status: 'Новый · чат не начат', sub: '', last: formatLastActivity(project.lastActivity, nowMs), isLive: false };
  }
  return {
    kind: 'idle' as const,
    status: 'Тихо',
    sub: project.lastSessionTitle ? `последний: ${project.lastSessionTitle}` : '',
    last: formatLastActivity(project.lastActivity, nowMs),
    isLive: false,
  };
}

/** Every project of the board as rows, with live work folded in by project id. */
export function buildProjectViews(board: HomeProjectsBoard, nowMs: number): ProjectView[] {
  const workByProject = new Map<string, HomeActivityItem[]>();
  for (const item of board.activity) {
    if (!item.projectId) continue;
    const list = workByProject.get(item.projectId) ?? [];
    list.push(item);
    workByProject.set(item.projectId, list);
  }
  const folder = board.projectsFolder?.path ?? null;
  const activityPeak = Math.max(0, ...board.projects.flatMap((project) => project.activityByDay));
  return board.projects.map((project) => {
    const state = describeStatus(project, project.isArchived ? [] : workByProject.get(project.projectId) ?? [], nowMs);
    const lastActivityMs = project.lastActivity ? Date.parse(project.lastActivity) || 0 : 0;
    return {
      id: project.projectId,
      name: project.displayName,
      fullPath: project.projectPath,
      shortPath: shortProjectPath(project.projectPath, folder),
      folder: project.projectPath.split('/').filter(Boolean).pop() ?? project.projectPath,
      // An archived project is off the home screen, so it is never shown or counted as a favourite.
      isStarred: project.isStarred && !project.isArchived,
      isArchived: project.isArchived,
      ...state,
      isDim: !project.isStarred && state.kind === 'idle' && nowMs - lastActivityMs > QUIET_DIM_MS,
      sessions: project.sessionCount,
      activityByDay: project.activityByDay,
      activityPeak,
      lastActivityMs,
    };
  });
}

const KIND_RANK: Record<ProjectStatusKind, number> = { wait: 0, run: 1, new: 2, idle: 3 };

/** «по активности»: waiting, running, new, then the most recently touched; «по имени»: alphabetical. */
export function sortProjects(list: ProjectView[], sort: ProjectsSort): ProjectView[] {
  const sorted = [...list];
  if (sort === 'name') return sorted.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return sorted.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.lastActivityMs - a.lastActivityMs);
}

/** Name or folder contains the query (case-insensitive). */
export function matchesQuery(project: ProjectView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || project.name.toLowerCase().includes(needle) || project.fullPath.toLowerCase().includes(needle);
}

export type ProjectsCounts = Record<ProjectsFilter, number>;

export function countProjects(views: ProjectView[]): ProjectsCounts {
  const live = views.filter((view) => !view.isArchived);
  return {
    all: live.length,
    fav: live.filter((view) => view.isStarred).length,
    active: live.filter((view) => view.kind === 'run' || view.kind === 'wait').length,
    archive: views.length - live.length,
  };
}

/** The sections of the list for a filter, as DarkProjects groups them; empty sections are left out. */
export function buildGroups(views: ProjectView[], filter: ProjectsFilter, query: string, sort: ProjectsSort): ProjectsGroup[] {
  const live = views.filter((view) => !view.isArchived);
  const groups: ProjectsGroup[] = [];
  const push = (n: string, title: string, meta: (count: number) => string, list: ProjectView[]) => {
    const items = sortProjects(list.filter((view) => matchesQuery(view, query)), sort);
    if (items.length) groups.push({ n, title, meta: meta(items.length), items });
  };
  if (filter === 'all') {
    push('01', 'ИЗБРАННЫЕ', (k) => `${k} · на главном экране`, live.filter((view) => view.isStarred));
    push('02', 'ОСТАЛЬНЫЕ', (k) => `${k} · тихие дольше недели приглушены`, live.filter((view) => !view.isStarred));
  } else if (filter === 'fav') {
    push('01', 'ИЗБРАННЫЕ', (k) => `${k} · на главном экране`, live.filter((view) => view.isStarred));
  } else if (filter === 'active') {
    push('01', 'В РАБОТЕ', (k) => `${k} · агенты идут или ждут тебя`, live.filter((view) => view.kind === 'run' || view.kind === 'wait'));
  } else {
    push('01', 'АРХИВ', (k) => `${k} · папки и чаты на сервере целы`, views.filter((view) => view.isArchived));
  }
  return groups;
}

/** Captions of the three summary cells (В ПАНЕЛИ / РАБОТАЮТ / ЖДЁТ ТЕБЯ). */
export function buildSummary(views: ProjectView[], board: HomeProjectsBoard) {
  const counts = countProjects(views);
  const live = views.filter((view) => !view.isArchived);
  const running = live.filter((view) => view.kind === 'run');
  const waiting = live.filter((view) => view.kind === 'wait');
  const agents = board.activity
    .filter((item) => item.state !== 'waiting' && running.some((view) => view.id === item.projectId))
    .reduce((total, item) => total + (item.state === 'background' ? 0 : 1) + item.tasks.length, 0);
  const runningAgents = running.length ? Math.max(running.length, agents) : 0;
  return {
    total: counts.all,
    totalLabel: `${pluralRu(counts.all, ['проект', 'проекта', 'проектов'])} · ещё ${counts.archive} в архиве`,
    running: runningAgents,
    runningLabel: running.length
      ? `${pluralRu(runningAgents, ['агент', 'агента', 'агентов'])} · ${running.map((view) => view.name).join(', ')}`
      : 'агентов · сейчас всё тихо',
    waiting: waiting.length,
    waitingLabel: waiting.length
      ? waiting.map((view) => (view.sub ? `${view.name} · ${view.sub}` : view.name)).join(' · ')
      : 'никто не ждёт',
  };
}

/** Sessions on the busiest day that fill the 20 px cell; a quieter board is not blown up past this scale. */
const SPARK_FULL_SCALE_MIN = 5;

/**
 * 14 bars of the activity strip: 3 px for an empty day up to 19 px for the
 * board's busiest one (the mock-up's 3 + 1.8 px a session at its peak of 9);
 * live projects light the last three.
 */
export function sparkBars(values: number[], isLive: boolean, isDim: boolean, peak: number): Array<{ height: number; tone: 'hot' | 'on' | 'dim' | 'off' }> {
  const scale = Math.max(peak, SPARK_FULL_SCALE_MIN);
  return values.map((value, index) => {
    const hot = isLive && index >= values.length - 3;
    const height = 3 + (Math.min(value, scale) / scale) * 16;
    return { height, tone: hot ? 'hot' : value ? (isDim ? 'dim' : 'on') : 'off' };
  });
}
