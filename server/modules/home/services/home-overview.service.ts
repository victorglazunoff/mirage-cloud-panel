import path from 'node:path';

import { projectsDb, scheduledMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import type { BackgroundTaskSummary, LLMProvider, ProjectRepositoryRow } from '@/shared/types.js';

/** How many days the favourite-project activity strip covers, oldest first. */
const ACTIVITY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Scheduled messages further out than this are not "events of the week" any more. */
const SCHEDULED_HORIZON_MS = 31 * DAY_MS;
const MAX_SCHEDULED_ITEMS = 40;
const MAX_RECENT_ITEMS = 6;
const MAX_TEXT_PREVIEW = 140;
/** The wizard lists this many recent terminal folders; more rows are scanned since active projects drop out. */
const MAX_TERMINAL_RECENT = 3;
const MAX_TERMINAL_RECENT_SCAN = 40;

/** One busy session, as the home screen's summary and "in progress" list show it. */
type HomeActivityItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectName: string;
  sessionTitle: string;
  /** `waiting` wins over `running`: a turn blocked on a permission prompt needs the user. */
  state: 'waiting' | 'running' | 'background';
  startedAt: number;
  /** Set when the turn runs outside CloudCLI (Claude CLI in a terminal). */
  external: boolean;
  /** `requestId` lets the home screen answer the prompt («Разрешить 1 раз») over `chat.permission-response`. */
  permission: { requestId: string | null; toolName: string; summary: string; receivedAt: string } | null;
  tasks: Array<{ taskId: string; description: string; taskType: string; startedAt: number }>;
};

type HomeFavoriteProject = {
  projectId: string;
  displayName: string;
  projectPath: string;
  lastActivity: string | null;
  lastSessionId: string | null;
  sessionCount: number;
  /** Sessions touched per local day, oldest first, `ACTIVITY_DAYS` long. */
  activityByDay: number[];
};

/** One project row of the projects board: the favourite-tile stats plus its star/archive flags. */
type HomeBoardProject = HomeFavoriteProject & {
  lastSessionTitle: string | null;
  isStarred: boolean;
  isArchived: boolean;
};

type HomeProjectsBoardCore = {
  generatedAt: string;
  projects: HomeBoardProject[];
  activity: HomeActivityItem[];
  /** Folders conversations recently ran in that are not active projects («Недавние в терминале»). */
  terminalRecent: Array<{ path: string; lastActivity: string }>;
};

type HomeScheduledEvent = {
  id: string;
  sessionId: string;
  projectId: string | null;
  projectName: string;
  sessionTitle: string;
  preview: string;
  scheduledFor: string;
};

type HomeRecentSession = {
  sessionId: string;
  projectId: string | null;
  projectName: string;
  sessionTitle: string;
  lastActivity: string | null;
};

type HomeOverview = {
  generatedAt: string;
  activity: HomeActivityItem[];
  favorites: HomeFavoriteProject[];
  projectCount: number;
  scheduled: HomeScheduledEvent[];
  recent: HomeRecentSession[];
};

type RunningSessionLike = {
  sessionId: string;
  provider: LLMProvider;
  startedAt: number;
  background?: true;
  statusText?: string;
  tasks?: BackgroundTaskSummary[];
};

type HomeOverviewDependencies = {
  listRunningSessions(): Promise<RunningSessionLike[]>;
  getPendingApprovals(sessionId: string): unknown[];
  now(): number;
};

const defaultDependencies: HomeOverviewDependencies = {
  listRunningSessions: () => sessionsService.listRunningSessions(),
  getPendingApprovals: (sessionId) => providerRuntimeService.getPendingApprovalsForSession(sessionId),
  now: () => Date.now(),
};

function resolveProjectName(project: ProjectRepositoryRow | null, projectPath: string | null): string {
  const customName = project?.custom_project_name?.trim();
  if (customName) {
    return customName;
  }
  if (!projectPath) {
    return 'Без проекта';
  }
  return path.basename(projectPath) || projectPath;
}

function truncateText(value: string, limit = MAX_TEXT_PREVIEW): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine;
}

/**
 * Picks the one input field that tells the user what a tool wants to do —
 * the shell command, the file, the URL — so "Ответить" is an informed click.
 */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'description', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return truncateText(value);
    }
  }
  return '';
}

function readFirstPendingApproval(pending: unknown[]): HomeActivityItem['permission'] {
  const first = pending.find((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
  if (!first) {
    return null;
  }
  const receivedAt = first.receivedAt instanceof Date
    ? first.receivedAt.toISOString()
    : typeof first.receivedAt === 'string' ? first.receivedAt : new Date().toISOString();
  return {
    requestId: typeof first.requestId === 'string' && first.requestId ? first.requestId : null,
    toolName: typeof first.toolName === 'string' ? first.toolName : 'Tool',
    summary: summarizeToolInput(first.input),
    receivedAt,
  };
}

function toTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * Index of the local day `timestamp` falls into, counting back from today
 * (0 = today). `tzOffsetMinutes` is the browser's `getTimezoneOffset()`, so the
 * strip's days match the user's calendar rather than the server's.
 */
function localDayIndex(timestamp: number, now: number, tzOffsetMinutes: number): number {
  const shift = -tzOffsetMinutes * 60 * 1000;
  const today = Math.floor((now + shift) / DAY_MS);
  const day = Math.floor((timestamp + shift) / DAY_MS);
  return today - day;
}

/**
 * Builds the home screen's read model from the live run registry, pending
 * permission prompts, starred projects, scheduled messages and recent sessions.
 *
 * Dependencies are injectable so tests can describe busy sessions without a
 * real provider runtime.
 */
export function createHomeOverviewService(overrides: Partial<HomeOverviewDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const projectByPath = new Map<string, ProjectRepositoryRow | null>();

  const lookupProject = (projectPath: string | null): ProjectRepositoryRow | null => {
    if (!projectPath) {
      return null;
    }
    if (!projectByPath.has(projectPath)) {
      projectByPath.set(projectPath, projectsDb.getProjectPath(projectPath));
    }
    return projectByPath.get(projectPath) ?? null;
  };

  const describeSession = (sessionId: string) => {
    const session = sessionsDb.getSessionById(sessionId);
    const projectPath = session?.project_path?.trim() ? session.project_path : null;
    const project = lookupProject(projectPath);
    return {
      projectId: project?.project_id ?? null,
      projectName: resolveProjectName(project, projectPath),
      sessionTitle: session?.custom_name?.trim() || 'Без названия',
    };
  };

  const buildActivity = async (): Promise<HomeActivityItem[]> => {
    const running = await dependencies.listRunningSessions();
    const items = running.map((entry): HomeActivityItem => {
      const permission = readFirstPendingApproval(dependencies.getPendingApprovals(entry.sessionId));
      // Nested tasks belong to a subagent's transcript; they are still work in
      // flight, so they are listed, but they never make a session "running".
      const tasks = (entry.tasks ?? []).map((task) => ({
        taskId: task.taskId,
        description: truncateText(task.workflowName || task.description || task.taskType),
        taskType: task.taskType,
        startedAt: task.startedAt,
      }));
      return {
        sessionId: entry.sessionId,
        provider: entry.provider,
        ...describeSession(entry.sessionId),
        state: permission ? 'waiting' : entry.background ? 'background' : 'running',
        startedAt: entry.startedAt,
        external: Boolean(entry.statusText),
        permission,
        tasks,
      };
    });
    // Waiting first (it needs the user), then the longest-running work.
    const rank = { waiting: 0, running: 1, background: 2 } as const;
    return items.sort((a, b) => rank[a.state] - rank[b.state] || a.startedAt - b.startedAt);
  };

  /** Session count, last touch and the 14-day strip of one project (favourite tiles and the projects board). */
  const describeProjectActivity = (project: ProjectRepositoryRow, tzOffsetMinutes: number) => {
    const now = dependencies.now();
    const sessions = sessionsDb.getSessionsByProjectPath(project.project_path);
    const activityByDay = new Array<number>(ACTIVITY_DAYS).fill(0);
    let lastActivity: number | null = null;
    let lastSessionId: string | null = null;
    let lastSessionTitle: string | null = null;

    for (const session of sessions) {
      const updated = toTimestamp(session.updated_at) ?? toTimestamp(session.created_at);
      if (updated !== null && (lastActivity === null || updated > lastActivity)) {
        lastActivity = updated;
        lastSessionId = session.session_id;
        lastSessionTitle = session.custom_name?.trim() || null;
      }
      // A session counts once per day it was started or last touched.
      const days = new Set<number>();
      for (const mark of [toTimestamp(session.created_at), updated]) {
        if (mark === null) continue;
        const index = localDayIndex(mark, now, tzOffsetMinutes);
        if (index >= 0 && index < ACTIVITY_DAYS) days.add(index);
      }
      for (const index of days) {
        activityByDay[ACTIVITY_DAYS - 1 - index] += 1;
      }
    }

    return {
      projectId: project.project_id,
      displayName: resolveProjectName(project, project.project_path),
      projectPath: project.project_path,
      lastActivity: lastActivity === null ? null : new Date(lastActivity).toISOString(),
      lastSessionId,
      lastSessionTitle,
      sessionCount: sessions.length,
      activityByDay,
    };
  };

  const byLastActivity = (a: { lastActivity: string | null }, b: { lastActivity: string | null }) =>
    (toTimestamp(b.lastActivity) ?? 0) - (toTimestamp(a.lastActivity) ?? 0);

  const buildFavorites = (tzOffsetMinutes: number): { favorites: HomeFavoriteProject[]; projectCount: number } => {
    const projects = projectsDb.getProjectPaths();
    const favorites = projects
      .filter((project) => Boolean(project.isStarred))
      .map((project): HomeFavoriteProject => {
        const { lastSessionTitle: _title, ...favorite } = describeProjectActivity(project, tzOffsetMinutes);
        return favorite;
      })
      .sort(byLastActivity);

    return { favorites, projectCount: projects.length };
  };

  const buildScheduled = (userId: number): HomeScheduledEvent[] => {
    const horizon = dependencies.now() + SCHEDULED_HORIZON_MS;
    return scheduledMessagesDb
      .listPendingForUser(userId)
      .filter((row) => (toTimestamp(row.scheduled_for) ?? Infinity) <= horizon)
      .slice(0, MAX_SCHEDULED_ITEMS)
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        ...describeSession(row.session_id),
        preview: truncateText(row.content),
        scheduledFor: row.scheduled_for,
      }));
  };

  const buildRecent = (): HomeRecentSession[] =>
    sessionsService.listRecentSessions(MAX_RECENT_ITEMS, 0).conversations.map((conversation) => ({
      sessionId: conversation.sessionId,
      projectId: conversation.projectId,
      projectName: conversation.projectDisplayName,
      sessionTitle: conversation.sessionTitle === conversation.sessionId ? 'Без названия' : conversation.sessionTitle,
      lastActivity: conversation.lastActivity,
    }));

  return {
    /**
     * Collects everything the home screen shows in one read. Each call starts
     * with a fresh project lookup cache so renamed projects show up at once.
     */
    async getOverview(input: { userId: number; tzOffsetMinutes: number }): Promise<HomeOverview> {
      projectByPath.clear();
      const activity = await buildActivity();
      const { favorites, projectCount } = buildFavorites(input.tzOffsetMinutes);
      return {
        generatedAt: new Date(dependencies.now()).toISOString(),
        activity,
        favorites,
        projectCount,
        scheduled: buildScheduled(input.userId),
        recent: buildRecent(),
      };
    },

    /**
     * Every project — active and archived — with its stats, plus the live
     * activity, for the «Все проекты» screen (DarkProjects). Folder discovery
     * (folders not yet in the panel) is added by the route from the folder service.
     */
    async getProjectsBoard(input: { tzOffsetMinutes: number }): Promise<HomeProjectsBoardCore> {
      projectByPath.clear();
      const activity = await buildActivity();
      const rows = [
        ...projectsDb.getProjectPaths(),
        ...projectsDb.getArchivedProjectPaths(),
      ];
      const projects = rows
        .map((project): HomeBoardProject => ({
          ...describeProjectActivity(project, input.tzOffsetMinutes),
          isStarred: Boolean(project.isStarred),
          isArchived: Boolean(project.isArchived),
        }))
        .sort(byLastActivity);
      const activePaths = new Set(rows.filter((row) => !row.isArchived).map((row) => row.project_path));
      const terminalRecent = sessionsDb
        .listRecentProjectPaths(MAX_TERMINAL_RECENT_SCAN)
        .filter((row) => !activePaths.has(row.project_path))
        .slice(0, MAX_TERMINAL_RECENT)
        .map((row) => ({ path: row.project_path, lastActivity: row.last_activity }));
      return {
        generatedAt: new Date(dependencies.now()).toISOString(),
        projects,
        activity,
        terminalRecent,
      };
    },
  };
}

/** Used by the home routes to answer `GET /api/home/overview`. */
export const homeOverviewService = createHomeOverviewService();
