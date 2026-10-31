import os from 'node:os';
import path from 'node:path';

import type {
  CommandCatalogResponse,
  SearchDialogHit,
  SearchResponse,
  SearchResultItem,
  SearchResultType,
  SearchSnippet,
} from '@/shared/types.js';
import { isSubscriptionLimitsSwitchOn } from '@/shared/utils.js';

/** A project as the Search service needs it; the module maps database rows to this. */
type SearchProject = {
  projectId: string;
  path: string;
  displayName: string;
  isStarred: boolean;
};

/** Session facts known to the database for a provider (transcript) session id. */
type SearchKnownSession = {
  sessionId: string;
  provider: string;
  title: string | null;
  projectPath: string | null;
  /** The session's last activity (`sessions.updated_at`), the date the chat list shows. */
  lastActivity: string | null;
};

type SearchServiceDependencies = {
  listProjects(): SearchProject[];
  findSession(providerSessionId: string): SearchKnownSession | null;
  getCatalog(): Promise<CommandCatalogResponse>;
  searchDialogs(
    query: string,
    options: { maxHits: number; deadlineMs: number },
  ): Promise<{ hits: SearchDialogHit[]; truncated: boolean }>;
  /** Relative file paths of a project, or null when the listing timed out or failed. */
  listFiles(projectPath: string, timeoutMs: number): Promise<string[] | null>;
  now(): number;
};

/** Parsed and validated transport input of `GET /api/search`. */
export type SearchRequest = {
  query: string;
  types: SearchResultType[];
  limit: number;
};

const ALL_TYPES: SearchResultType[] = ['project', 'session', 'file', 'command', 'action'];
const GROUP_LABELS: Record<SearchResultType, string> = {
  project: 'Проекты',
  session: 'Диалоги',
  file: 'Файлы',
  command: 'Команды',
  action: 'Действия',
};

const SNIPPET_LENGTH = 160;
const TIME_BUDGET_MS = 420;
const FILE_INDEX_TTL_MS = 120_000;
const MAX_FILES_PER_PROJECT = 30_000;
const DIALOG_HIT_CAP = 400;

type StaticAction = { id: string; title: string; keywords: string };

/** Panel actions that are not tied to a project; the UI maps `actionId` to a handler. */
const STATIC_ACTIONS: StaticAction[] = [
  { id: 'new_session', title: 'Новый диалог', keywords: 'новый чат создать диалог' },
  { id: 'open_calendar', title: 'Открыть календарь', keywords: 'календарь события расписание' },
  { id: 'compact_session', title: 'Сжать сессию', keywords: 'сжать компакт контекст compact' },
  { id: 'open_agents', title: 'Открыть агентов', keywords: 'агенты субагенты фоновые' },
  { id: 'open_files', title: 'Открыть файлы', keywords: 'файлы дерево' },
  { id: 'open_projects', title: 'Открыть проекты', keywords: 'проекты список' },
  { id: 'open_settings', title: 'Открыть настройки', keywords: 'настройки параметры пароль' },
  { id: 'show_usage', title: 'Показать лимиты тарифа', keywords: 'лимиты usage расход' },
  { id: 'voice_input', title: 'Голосовой ввод', keywords: 'голос микрофон диктовка' },
  { id: 'toggle_theme', title: 'Переключить тему', keywords: 'тема тёмная светлая' },
];

/**
 * Ranks how well `name` matches the lower-cased `needle`: exact 100, prefix 80, start of a
 * word 60, any occurrence 40, no match 0. Exported for Search tests.
 */
export function scoreNameMatch(name: string, needle: string): number {
  const haystack = name.toLowerCase();
  if (!needle) return 1;
  if (haystack === needle) return 100;
  if (haystack.startsWith(needle)) return 80;
  const index = haystack.indexOf(needle);
  if (index < 0) return 0;
  return /[\s\-_./\\:]/.test(haystack[index - 1] ?? '') ? 60 : 40;
}

/**
 * Cuts about 160 characters of `text` around the first case-insensitive occurrence of
 * `needle` and reports the match offsets inside the cut. Returns null when the text does
 * not contain the needle (the transcript line matched only JSON-escaped content).
 * Exported for Search tests.
 */
export function buildSnippet(text: string, needle: string): SearchSnippet | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  const index = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return null;

  const room = Math.max(0, SNIPPET_LENGTH - needle.length);
  let start = Math.max(0, index - Math.floor(room / 3));
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  start = Math.max(0, Math.min(start, end - SNIPPET_LENGTH));

  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  const body = flat.slice(start, end);
  return {
    text: `${prefix}${body}${suffix}`,
    matchStart: prefix.length + (index - start),
    matchEnd: prefix.length + (index - start) + needle.length,
  };
}

function emptyItem(type: SearchResultType, id: string, title: string, score: number): SearchResultItem {
  return {
    type, id, title, score,
    subtitle: null, projectId: null, projectName: null, path: null, sessionId: null,
    provider: null, snippet: null, role: null, timestamp: null, lastActivity: null, commandName: null, actionId: null,
  };
}

function compareItems(a: SearchResultItem, b: SearchResultItem): number {
  return b.score - a.score
    || (b.timestamp ?? '').localeCompare(a.timestamp ?? '')
    || a.title.length - b.title.length
    || a.title.localeCompare(b.title);
}

/** Parses raw query-string values into a validated search request. Used by the route. */
export function parseSearchRequest(raw: { q?: unknown; types?: unknown; limit?: unknown }): SearchRequest {
  const query = typeof raw.q === 'string' ? raw.q.trim().slice(0, 200) : '';
  const requested = typeof raw.types === 'string'
    ? raw.types.split(',').map((value) => value.trim()).filter((value): value is SearchResultType =>
      (ALL_TYPES as string[]).includes(value))
    : [];
  const parsedLimit = Number.parseInt(typeof raw.limit === 'string' ? raw.limit : '', 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 50) : 8;
  return { query, types: requested.length > 0 ? requested : ALL_TYPES, limit };
}

/**
 * Creates the global search service behind `GET /api/search`: projects, dialogs of all
 * projects (ripgrep over transcripts), project files, slash commands and panel actions.
 * Every source is injected so tests need no ripgrep, database or home directory.
 * Dialog and file scans share one time budget, so a typical query answers in under 500 ms;
 * file listings are cached per project and warmed in the background after a cold miss.
 */
export function createSearchService(dependencies: SearchServiceDependencies) {
  const fileIndex = new Map<string, { at: number; files: string[] }>();
  const fileIndexPending = new Map<string, Promise<string[] | null>>();

  function loadFiles(projectPath: string, budgetMs: number): Promise<string[] | null> {
    const cached = fileIndex.get(projectPath);
    if (cached && dependencies.now() - cached.at < FILE_INDEX_TTL_MS) return Promise.resolve(cached.files);

    let pending = fileIndexPending.get(projectPath);
    if (!pending) {
      // Listing may outlive this request; it keeps filling the cache for the next one.
      pending = dependencies.listFiles(projectPath, 8_000).then((files) => {
        if (files) fileIndex.set(projectPath, { at: dependencies.now(), files });
        return files;
      }).finally(() => fileIndexPending.delete(projectPath));
      fileIndexPending.set(projectPath, pending);
    }
    const stale = cached?.files ?? null;
    return Promise.race([
      pending,
      new Promise<string[] | null>((resolve) => setTimeout(() => resolve(stale), budgetMs)),
    ]);
  }

  function projectResults(projects: SearchProject[], needle: string): SearchResultItem[] {
    const items: SearchResultItem[] = [];
    for (const project of projects) {
      const score = Math.max(
        scoreNameMatch(project.displayName, needle),
        scoreNameMatch(path.basename(project.path), needle),
        needle && project.path.toLowerCase().includes(needle) ? 20 : 0,
      );
      if (score === 0) continue;
      const item = emptyItem('project', project.projectId, project.displayName, score + (project.isStarred ? 5 : 0));
      item.subtitle = project.path;
      item.projectId = project.projectId;
      item.projectName = project.displayName;
      item.path = project.path;
      items.push(item);
    }
    return items;
  }

  async function commandResults(needle: string, projectId: string | null): Promise<SearchResultItem[]> {
    const catalog = await dependencies.getCatalog();
    const bare = needle.replace(/^\//, '');
    const items: SearchResultItem[] = [];
    for (const command of catalog.commands) {
      const nameScore = scoreNameMatch(command.name.slice(1), bare);
      const descriptionScore = bare && command.description.toLowerCase().includes(bare) ? 15 : 0;
      const score = Math.max(nameScore, descriptionScore);
      if (score === 0) continue;
      const item = emptyItem('command', command.id, command.name, score);
      item.subtitle = command.description;
      item.commandName = command.name;
      item.projectId = projectId;
      items.push(item);
    }
    return items;
  }

  function actionResults(projects: SearchProject[], needle: string): SearchResultItem[] {
    const items: SearchResultItem[] = [];
    for (const action of STATIC_ACTIONS) {
      // No limits counter (MIRAGE_SUBSCRIPTION_LIMITS): no «показать лимиты» either.
      if (action.id === 'show_usage' && !isSubscriptionLimitsSwitchOn()) continue;
      const score = Math.max(
        scoreNameMatch(action.title, needle),
        needle && action.keywords.includes(needle) ? 30 : 0,
      );
      if (score === 0) continue;
      const item = emptyItem('action', action.id, action.title, score);
      item.actionId = action.id;
      items.push(item);
    }

    // "Новый диалог в …" for every project; with an empty query only starred ones.
    for (const project of projects) {
      const title = `Новый диалог в ${project.displayName}`;
      const score = needle
        ? Math.max(scoreNameMatch(title, needle), scoreNameMatch(project.displayName, needle) > 0 ? 35 : 0)
        : (project.isStarred ? 2 : 0);
      if (score === 0) continue;
      const item = emptyItem('action', `new_session:${project.projectId}`, title, score);
      item.actionId = 'new_session';
      item.projectId = project.projectId;
      item.projectName = project.displayName;
      item.path = project.path;
      items.push(item);
    }
    return items;
  }

  async function fileResults(
    projects: SearchProject[],
    needle: string,
    budgetMs: number,
  ): Promise<{ items: SearchResultItem[]; truncated: boolean }> {
    if (!needle) return { items: [], truncated: false };
    let truncated = false;
    const perProject = await Promise.all(projects.map(async (project) => {
      const files = await loadFiles(project.path, budgetMs);
      if (!files) {
        truncated = true;
        return [];
      }
      const items: SearchResultItem[] = [];
      for (const relative of files) {
        const base = path.basename(relative);
        const score = Math.max(
          scoreNameMatch(base, needle),
          relative.toLowerCase().includes(needle) ? 20 : 0,
        );
        if (score === 0) continue;
        const item = emptyItem('file', `${project.projectId}:${relative}`, base, score);
        item.subtitle = `${project.displayName} · ${path.dirname(relative) === '.' ? '/' : path.dirname(relative)}`;
        item.projectId = project.projectId;
        item.projectName = project.displayName;
        item.path = path.join(project.path, relative);
        items.push(item);
      }
      return items;
    }));
    return { items: perProject.flat(), truncated };
  }

  async function dialogResults(
    projects: SearchProject[],
    query: string,
    budgetMs: number,
  ): Promise<{ items: SearchResultItem[]; truncated: boolean }> {
    if (query.length < 2) return { items: [], truncated: false };
    const { hits, truncated } = await dependencies.searchDialogs(query, {
      maxHits: DIALOG_HIT_CAP,
      deadlineMs: budgetMs,
    });

    // One result per session: its most recent matching message.
    const latestBySession = new Map<string, SearchDialogHit>();
    for (const hit of hits) {
      const current = latestBySession.get(hit.providerSessionId);
      if (!current || (hit.timestamp ?? '') > (current.timestamp ?? '')) {
        latestBySession.set(hit.providerSessionId, hit);
      }
    }

    const projectsByPath = new Map(projects.map((project) => [project.path, project]));
    const newest = [...latestBySession.values()].reduce((max, hit) => ((hit.timestamp ?? '') > max ? (hit.timestamp ?? '') : max), '');
    const newestMs = Date.parse(newest) || dependencies.now();

    const items: SearchResultItem[] = [];
    for (const hit of latestBySession.values()) {
      const snippet = buildSnippet(hit.text, query);
      if (!snippet) continue;

      const known = dependencies.findSession(hit.providerSessionId);
      const projectPath = known?.projectPath ?? hit.cwd;
      const project = projectPath ? projectsByPath.get(projectPath) ?? null : null;
      const ageDays = Math.max(0, (newestMs - (Date.parse(hit.timestamp ?? '') || 0)) / 86_400_000);
      const recency = Math.max(0, 10 - ageDays / 3);

      const sessionId = known?.sessionId ?? hit.providerSessionId;
      const item = emptyItem(
        'session',
        `session:${sessionId}`,
        known?.title?.trim() || `Диалог ${hit.providerSessionId.slice(0, 8)}`,
        40 + recency,
      );
      item.subtitle = project?.displayName ?? (projectPath ? path.basename(projectPath) : null);
      item.projectId = project?.projectId ?? null;
      item.projectName = project?.displayName ?? null;
      item.path = projectPath;
      item.sessionId = sessionId;
      item.provider = known?.provider ?? 'claude';
      item.snippet = snippet;
      item.role = hit.role;
      item.timestamp = hit.timestamp;
      item.lastActivity = known?.lastActivity ?? hit.timestamp;
      items.push(item);
    }
    return { items, truncated };
  }

  return {
    /** Runs the search; every requested type gets a group even when it has no hits. */
    async search(request: SearchRequest, context: { projectId?: string | null } = {}): Promise<SearchResponse> {
      const startedAt = dependencies.now();
      const { types, limit } = request;
      const commandMode = request.query.startsWith('/');
      const query = request.query;
      const needle = query.toLowerCase();
      const wanted = new Set(types);
      const projects = dependencies.listProjects();

      const searchable = projects.filter((project) => project.path !== '/' && project.path !== os.homedir());

      const [dialogs, files, commands] = await Promise.all([
        wanted.has('session') && !commandMode
          ? dialogResults(projects, query, TIME_BUDGET_MS)
          : { items: [], truncated: false },
        wanted.has('file') && !commandMode
          ? fileResults(searchable, needle, TIME_BUDGET_MS)
          : { items: [], truncated: false },
        wanted.has('command') ? commandResults(needle, context.projectId ?? null) : [],
      ]);

      const byType: Record<SearchResultType, SearchResultItem[]> = {
        project: wanted.has('project') && !commandMode ? projectResults(projects, needle) : [],
        session: dialogs.items,
        file: files.items,
        command: commands,
        action: wanted.has('action') && !commandMode ? actionResults(projects, needle) : [],
      };

      const groups = ALL_TYPES.filter((type) => wanted.has(type)).map((type) => {
        const sorted = byType[type].sort(compareItems);
        return { type, label: GROUP_LABELS[type], count: sorted.length, items: sorted.slice(0, limit) };
      });

      return {
        query,
        tookMs: dependencies.now() - startedAt,
        total: groups.reduce((sum, group) => sum + group.count, 0),
        truncated: dialogs.truncated || files.truncated,
        groups,
      };
    },
  };
}

/** Service type used by the search router and module wiring. */
export type SearchService = ReturnType<typeof createSearchService>;
