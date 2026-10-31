import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { agentsLiveService } from '@/modules/agents-live/index.js';
import { sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import { getReportedClaudeContextWindow, providerRuntimeService, providerTokenUsageService } from '@/modules/providers/index.js';
import { dispatchQueuedMessages } from '@/modules/scheduled-messages/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type {
  AnyRecord,
  LiveContextUsageReading,
  SessionCompactResult,
  SessionContextCategory,
  SessionContextFile,
  SessionContextUsage,
  SessionTranscriptSize,
  SessionUsageTotals,
} from '@/shared/types.js';
import { AppError, readQueuedChatMessage } from '@/shared/utils.js';

const CACHE_TTL_MS = 10_000;
const TOP_ITEMS = 15;
const MAX_FILES = 30;
const COMPACT_COMMAND = '/compact';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

/** What one pass over a transcript yields (cached by file size + mtime). */
type TranscriptScan = {
  totals: Omit<SessionUsageTotals, 'costUsd'>;
  files: SessionContextFile[];
  /** Model of the newest main-thread answer («claude-haiku-4-5-…»); null when none. */
  model?: string | null;
};

type ContextUsageDependencies = {
  now(): number;
  getSession(sessionId: string): SessionRow | null;
  getLiveContextUsage(sessionId: string): Promise<LiveContextUsageReading | null>;
  estimateTokenUsage(sessionId: string): Promise<{ used: number; total?: number }>;
  getLiveCostUsd(sessionId: string): number | null;
  /**
   * The window the SDK reported for the session's model: `result.modelUsage[model].contextWindow`
   * of the live process, else the last one the runtime remembered. Null when none reported.
   */
  getReportedContextWindow(sessionId: string, model: string | null): number | null;
  resolveTranscriptPath(session: SessionRow): string | null;
  /** Size and mtime of a file; null when it does not exist. */
  statFile(filePath: string): Promise<{ size: number; mtimeMs: number } | null>;
  scanTranscript(filePath: string, projectPath: string | null): Promise<TranscriptScan | null>;
  listQueuedFor(sessionId: string): Array<{ userId: number; content: string }>;
  appendQueuedMessage(userId: number, sessionId: string, content: string): boolean;
  clearQueuedMessage(userId: number, sessionId: string): void;
  isSessionProcessing(sessionId: string): boolean;
  dispatchQueue(): void;
};

/** Claude's transcript for a session: the indexed path, else `~/.claude/projects/<encoded cwd>/<id>.jsonl`. */
function resolveClaudeTranscriptPath(session: SessionRow): string | null {
  if (session.jsonl_path) {
    return session.jsonl_path;
  }
  if (!session.project_path) {
    return null;
  }
  const encoded = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
  const projectDirectory = path.join(os.homedir(), '.claude', 'projects', encoded);
  const filePath = path.join(projectDirectory, `${session.provider_session_id || session.session_id}.jsonl`);
  const relative = path.relative(projectDirectory, filePath);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : filePath;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Characters of text a tool result put into context (strings and text blocks). */
function measureToolResult(content: unknown): number {
  if (typeof content === 'string') {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((sum: number, block) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0);
  }
  return 0;
}

/**
 * A read file as the «Файлы в контексте» list shows it: relative to the project; outside it
 * short — the home folder as `~`, and a deep folder cut to its last folder after `…/`.
 * Exported for the tests.
 */
export function splitFilePath(filePath: string, projectPath: string | null, home = os.homedir()): { dir: string; name: string } {
  const root = projectPath?.replace(/\/+$/, '');
  let shown = filePath;
  if (root && filePath.startsWith(`${root}/`)) {
    shown = filePath.slice(root.length + 1);
  } else {
    const homeRoot = home.replace(/\/+$/, '');
    if (homeRoot && filePath.startsWith(`${homeRoot}/`)) shown = `~/${filePath.slice(homeRoot.length + 1)}`;
    const parts = shown.split('/');
    // «/tmp/claude-0/-root/<id>/tasks/x.output» → «…/tasks/x.output»
    if (parts.length > 4) shown = `…/${parts.slice(-2).join('/')}`;
  }
  const slash = shown.lastIndexOf('/');
  return slash >= 0 ? { dir: shown.slice(0, slash + 1), name: shown.slice(slash + 1) } : { dir: '', name: shown };
}

/**
 * Window size for a transcript-only estimate. Without a live process the
 * provider falls back to the CONTEXT_WINDOW setting (160k by default), which
 * a 1M-context session overflows («151 % занято»): a reading above the
 * configured window can only come from a larger one, so the window is the
 * next real size — 200k, else 1M. Exported for the tests.
 */
export function inferContextWindow(used: number, configured: number | undefined): number {
  const window = configured && configured > 0 ? configured : 0;
  if (used <= window) return window;
  return used <= 200_000 ? 200_000 : 1_000_000;
}

/**
 * The window of a transcript-only reading and whether it is known rather than guessed.
 * The SDK's reported window wins; then the model id: a `[1m]` id is 1M, Haiku 3–4 is 200k,
 * other Claude models are at least 200k (the configured 160k default is too small for
 * any of them); `inferContextWindow` is the last resort. Exported for the tests.
 */
export function contextWindowFor(
  model: string | null,
  used: number,
  configured: number | undefined,
  reported: number | null,
): { maxTokens: number; known: boolean } {
  if (reported && reported > 0 && used <= reported) return { maxTokens: reported, known: true };
  const id = (model ?? '').toLowerCase();
  if (/\[1m\]|-1m\b/.test(id)) return { maxTokens: 1_000_000, known: true };
  // Haiku 3.x / 4.x serve 200k; newer ones state their window in the SDK report (5.5 says 1M).
  if (/haiku-[34]\b|3-(5-)?haiku/.test(id) && used <= 200_000) return { maxTokens: 200_000, known: true };
  if (/claude|opus|sonnet|haiku|fable/.test(id)) {
    return { maxTokens: inferContextWindow(used, Math.max(configured ?? 0, 200_000)), known: false };
  }
  return { maxTokens: inferContextWindow(used, configured), known: false };
}

/**
 * Reads a Claude transcript line by line: main-thread token totals (each
 * assistant message counted once, by its last streamed row) and the files
 * read into context since the last compaction, with tokens ≈ chars / 4.
 *
 * Exported for the module's tests.
 */
export async function scanClaudeTranscript(filePath: string, projectPath: string | null): Promise<TranscriptScan | null> {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const usageByMessage = new Map<string, AnyRecord>();
  const anonymousUsage: AnyRecord[] = [];
  let pendingReads = new Map<string, string>();
  let files = new Map<string, number>();
  let model: string | null = null;

  const lines = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let row: AnyRecord;
    try {
      row = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }
    if (row.isSidechain === true) {
      continue;
    }
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      files = new Map();
      pendingReads = new Map();
      continue;
    }
    const message = row.message as AnyRecord | undefined;
    const content = Array.isArray(message?.content) ? message?.content as AnyRecord[] : [];
    if (row.type === 'assistant' && message) {
      if (typeof message.model === 'string' && message.model && message.model !== '<synthetic>') {
        model = message.model;
      }
      if (message.usage && message.model !== '<synthetic>') {
        if (typeof message.id === 'string') {
          usageByMessage.set(message.id, message.usage as AnyRecord);
        } else {
          anonymousUsage.push(message.usage as AnyRecord);
        }
      }
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Read' && typeof block.input?.file_path === 'string') {
          pendingReads.set(String(block.id), block.input.file_path);
        }
      }
    } else if (row.type === 'user') {
      for (const block of content) {
        const readPath = block?.type === 'tool_result' ? pendingReads.get(String(block.tool_use_id)) : undefined;
        if (readPath) {
          pendingReads.delete(String(block.tool_use_id));
          files.set(readPath, Math.ceil(measureToolResult(block.content) / 4));
        }
      }
    }
  }

  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, assistantTurns: 0 };
  for (const usage of [...usageByMessage.values(), ...anonymousUsage]) {
    totals.inputTokens += readNumber(usage.input_tokens);
    totals.outputTokens += readNumber(usage.output_tokens);
    totals.cacheReadTokens += readNumber(usage.cache_read_input_tokens);
    totals.cacheCreationTokens += readNumber(usage.cache_creation_input_tokens);
    totals.assistantTurns += 1;
  }
  return {
    totals,
    model,
    files: [...files.entries()]
      .map(([readPath, tokens]) => ({ path: readPath, ...splitFilePath(readPath, projectPath), tokens }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, MAX_FILES),
  };
}

const scanCache = new Map<string, { key: string; scan: TranscriptScan | null }>();

/** `scanClaudeTranscript` memoised on the file's size and mtime. */
async function scanTranscriptCached(filePath: string, projectPath: string | null): Promise<TranscriptScan | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = scanCache.get(filePath);
  if (cached?.key === key) {
    return cached.scan;
  }
  const scan = await scanClaudeTranscript(filePath, projectPath);
  scanCache.set(filePath, { key, scan });
  if (scanCache.size > 200) {
    scanCache.delete(scanCache.keys().next().value as string);
  }
  return scan;
}

/** Windows the SDK reported, per model id (process memory; a few models at most). */
const reportedWindowByModel = new Map<string, number>();

function rememberModelWindow(model: string, window: number): void {
  reportedWindowByModel.set(model, window);
  if (reportedWindowByModel.size > 50) {
    reportedWindowByModel.delete(reportedWindowByModel.keys().next().value as string);
  }
}

const defaultDependencies: ContextUsageDependencies = {
  now: () => Date.now(),
  getSession: (sessionId) => sessionsDb.getSessionById(sessionId),
  getLiveContextUsage: (sessionId) => providerRuntimeService.getLiveContextUsage(sessionId, 'full'),
  estimateTokenUsage: (sessionId) => providerTokenUsageService.getSessionTokenUsage(sessionId),
  getLiveCostUsd: (sessionId) => agentsLiveService.getSessionUsage(sessionId)?.costUsd ?? null,
  getReportedContextWindow: (sessionId, model) => {
    const byModel = agentsLiveService.getSessionUsage(sessionId)?.byModel ?? {};
    const live = (model ? byModel[model]?.contextWindow : null)
      ?? Object.values(byModel).find((entry) => (entry.contextWindow ?? 0) > 0)?.contextWindow
      ?? null;
    const reported = live ?? getReportedClaudeContextWindow(sessionId) ?? null;
    if (model && reported) rememberModelWindow(model, reported);
    // A session whose process has not reported yet (the first turn after a restart)
    // borrows the window another session of the same model reported.
    return reported ?? (model ? reportedWindowByModel.get(model) ?? null : null);
  },
  resolveTranscriptPath: resolveClaudeTranscriptPath,
  statFile: async (filePath) => {
    try {
      const stats = await fs.promises.stat(filePath);
      return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
    } catch {
      return null;
    }
  },
  scanTranscript: scanTranscriptCached,
  listQueuedFor: (sessionId) => sessionDraftsDb.listQueuedMessages()
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => ({ userId: entry.userId, content: readQueuedChatMessage(entry.queuedMessage)?.content ?? '' })),
  appendQueuedMessage: (userId, sessionId, content) =>
    sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content, attachments: [] }) !== null,
  clearQueuedMessage: (userId, sessionId) => sessionDraftsDb.clearQueuedMessage(userId, sessionId),
  isSessionProcessing: (sessionId) => chatRunRegistry.isProcessing(sessionId),
  dispatchQueue: () => {
    // Not awaited: a dispatch pass resolves only when the turns it sent finish.
    void dispatchQueuedMessages(providerRuntimeService).catch((error: unknown) => {
      console.error('[Context] Queue dispatch failed:', error instanceof Error ? error.message : error);
    });
  },
};

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function percentOf(tokens: number, max: number): number {
  return max > 0 ? Math.round((tokens / max) * 1000) / 10 : 0;
}

function byTokensDesc<T extends { tokens: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.tokens - a.tokens);
}

/** Groups MCP tools per server — the «MCP-инструменты» row expands into servers. */
function sumMcpByServer(usage: AnyRecord): Array<{ name: string; tokens: number }> {
  const byServer = new Map<string, number>();
  for (const tool of Array.isArray(usage.mcpTools) ? usage.mcpTools as AnyRecord[] : []) {
    const server = String(tool?.serverName ?? 'mcp');
    byServer.set(server, (byServer.get(server) ?? 0) + readNumber(tool?.tokens));
  }
  return byTokensDesc([...byServer].map(([name, tokens]) => ({ name, tokens })));
}

function categoryItems(id: string, usage: AnyRecord): SessionContextCategory['items'] {
  const list = (value: unknown) => (Array.isArray(value) ? value as AnyRecord[] : []);
  switch (id) {
    case 'mcp_tools':
    case 'mcp_tools_deferred':
      return sumMcpByServer(usage);
    case 'skills':
      return byTokensDesc(list((usage.skills as AnyRecord | undefined)?.skillFrontmatter)
        .map((skill) => ({ name: String(skill.name), tokens: readNumber(skill.tokens) })));
    case 'custom_agents':
      return byTokensDesc(list(usage.agents).map((agent) => ({ name: String(agent.agentType), tokens: readNumber(agent.tokens) })));
    case 'memory_files':
      return byTokensDesc(list(usage.memoryFiles).map((file) => ({ name: String(file.path), tokens: readNumber(file.tokens) })));
    case 'system_tools':
      return byTokensDesc(list(usage.systemTools).map((tool) => ({ name: String(tool.name), tokens: readNumber(tool.tokens) })));
    case 'system_prompt':
      return byTokensDesc(list(usage.systemPromptSections)
        .map((section) => ({ name: String(section.name), tokens: readNumber(section.tokens) })));
    default:
      return [];
  }
}

/**
 * Maps the SDK's `getContextUsage` answer onto the panel's contract. Pure;
 * exported for the module's tests.
 */
export function mapLiveContextUsage(
  sessionId: string,
  reading: LiveContextUsageReading,
): Omit<SessionContextUsage, 'files' | 'session' | 'compactQueued' | 'cachedAt'> {
  const usage = reading.usage;
  const maxTokens = readNumber(usage.maxTokens);
  const totalTokens = readNumber(usage.totalTokens);
  const threshold = typeof usage.autoCompactThreshold === 'number' ? usage.autoCompactThreshold : null;
  const categories = (Array.isArray(usage.categories) ? usage.categories as AnyRecord[] : []).map((category) => {
    const id = typeof category.id === 'string' ? category.id : slug(String(category.name ?? ''));
    const tokens = readNumber(category.tokens);
    const kind = ['used', 'free', 'buffer', 'deferred'].includes(category.kind) ? category.kind : 'used';
    return {
      id,
      name: String(category.name ?? id),
      tokens,
      percentage: percentOf(tokens, maxTokens),
      kind,
      color: typeof category.color === 'string' ? category.color : null,
      items: categoryItems(id, usage),
    } as SessionContextCategory;
  });
  const breakdown = usage.messageBreakdown as AnyRecord | undefined;
  const skills = (usage.skills as AnyRecord | undefined)?.skillFrontmatter;
  return {
    sessionId,
    source: 'live',
    estimated: false,
    detail: reading.detail,
    model: typeof usage.model === 'string' ? usage.model : null,
    totalTokens,
    maxTokens,
    percentage: typeof usage.percentage === 'number' ? usage.percentage : percentOf(totalTokens, maxTokens),
    autoCompactThreshold: threshold,
    isAutoCompactEnabled: typeof usage.isAutoCompactEnabled === 'boolean' ? usage.isAutoCompactEnabled : null,
    tokensUntilAutoCompact: threshold === null ? null : Math.max(0, threshold - totalTokens),
    categories,
    heavyMcpTools: byTokensDesc((Array.isArray(usage.mcpTools) ? usage.mcpTools as AnyRecord[] : []).map((tool) => ({
      name: String(tool.name),
      serverName: String(tool.serverName ?? ''),
      tokens: readNumber(tool.tokens),
      isLoaded: typeof tool.isLoaded === 'boolean' ? tool.isLoaded : null,
    }))).slice(0, TOP_ITEMS),
    heavySkills: byTokensDesc((Array.isArray(skills) ? skills as AnyRecord[] : []).map((skill) => ({
      name: String(skill.name),
      source: String(skill.source ?? ''),
      tokens: readNumber(skill.tokens),
    }))).slice(0, TOP_ITEMS),
    memoryFiles: (Array.isArray(usage.memoryFiles) ? usage.memoryFiles as AnyRecord[] : []).map((file) => ({
      path: String(file.path),
      type: String(file.type ?? ''),
      tokens: readNumber(file.tokens),
    })),
    agents: (Array.isArray(usage.agents) ? usage.agents as AnyRecord[] : []).map((agent) => ({
      agentType: String(agent.agentType),
      source: String(agent.source ?? ''),
      tokens: readNumber(agent.tokens),
    })),
    messageBreakdown: breakdown ? {
      toolCallTokens: readNumber(breakdown.toolCallTokens),
      toolResultTokens: readNumber(breakdown.toolResultTokens),
      attachmentTokens: readNumber(breakdown.attachmentTokens),
      assistantMessageTokens: readNumber(breakdown.assistantMessageTokens),
      userMessageTokens: readNumber(breakdown.userMessageTokens),
    } : null,
  };
}

/**
 * The «Контекст» sidebar: a session's context breakdown from its live process
 * (or an estimate from the transcript), session token totals and cost, and
 * «сжать после хода» through the existing queued-message mechanism.
 *
 * Dependencies are injectable so tests need no live SDK process.
 */
export function createContextUsageService(overrides: Partial<ContextUsageDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const cache = new Map<string, { at: number; value: SessionContextUsage }>();

  const requireSession = (sessionId: string): SessionRow => {
    const session = dependencies.getSession(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    return session;
  };

  const isCompactQueued = (sessionId: string) => dependencies.listQueuedFor(sessionId)
    .some((entry) => entry.content.trim() === COMPACT_COMMAND);

  return {
    /** Body of GET /api/context/:sessionId; `fresh` skips the 10 s cache. */
    async getContextUsage(sessionId: string, options: { fresh?: boolean } = {}): Promise<SessionContextUsage> {
      const now = dependencies.now();
      const cached = cache.get(sessionId);
      if (cached && !options.fresh && now - cached.at < CACHE_TTL_MS) {
        return { ...cached.value, compactQueued: isCompactQueued(sessionId) };
      }
      const session = requireSession(sessionId);
      if (session.provider !== 'claude') {
        throw new AppError('Context breakdown is only available for Claude sessions.', {
          code: 'CONTEXT_UNSUPPORTED',
          statusCode: 400,
        });
      }

      let live: LiveContextUsageReading | null = null;
      try {
        live = await dependencies.getLiveContextUsage(sessionId);
      } catch (error) {
        console.warn('[Context] Live context usage failed, estimating from the transcript:', error instanceof Error ? error.message : error);
      }

      const transcriptPath = dependencies.resolveTranscriptPath(session);
      const scan = transcriptPath ? await dependencies.scanTranscript(transcriptPath, session.project_path) : null;
      const totals: SessionUsageTotals = {
        ...(scan?.totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, assistantTurns: 0 }),
        costUsd: dependencies.getLiveCostUsd(sessionId),
      };

      let value: SessionContextUsage;
      if (live) {
        value = {
          ...mapLiveContextUsage(sessionId, live),
          files: scan?.files ?? [],
          session: totals,
          compactQueued: isCompactQueued(sessionId),
          cachedAt: new Date(now).toISOString(),
        };
      } else {
        // A session with no transcript yet has nothing in context.
        const estimate = await dependencies.estimateTokenUsage(sessionId).catch((error: unknown) => {
          if (error instanceof AppError && error.statusCode === 404) {
            return { used: 0, total: undefined };
          }
          throw error;
        });
        const used = estimate.used;
        const model = scan?.model ?? null;
        const { maxTokens, known } = contextWindowFor(
          model,
          used,
          estimate.total,
          dependencies.getReportedContextWindow(sessionId, model),
        );
        const free = Math.max(0, maxTokens - used);
        value = {
          sessionId,
          source: 'transcript',
          // The used tokens are the newest request's real prompt; only a guessed window is an estimate.
          estimated: !known,
          detail: null,
          model,
          totalTokens: used,
          maxTokens,
          percentage: percentOf(used, maxTokens),
          autoCompactThreshold: null,
          isAutoCompactEnabled: null,
          tokensUntilAutoCompact: null,
          categories: [
            { id: 'messages', name: 'Использовано', tokens: used, percentage: percentOf(used, maxTokens), kind: 'used', color: null, items: [] },
            { id: 'free_space', name: 'Свободно', tokens: free, percentage: percentOf(free, maxTokens), kind: 'free', color: null, items: [] },
          ],
          heavyMcpTools: [],
          heavySkills: [],
          memoryFiles: [],
          agents: [],
          files: scan?.files ?? [],
          messageBreakdown: null,
          session: totals,
          compactQueued: isCompactQueued(sessionId),
          cachedAt: new Date(now).toISOString(),
        };
      }
      cache.set(sessionId, { at: now, value });
      if (cache.size > 200) {
        cache.delete(cache.keys().next().value as string);
      }
      return value;
    },

    /**
     * Queues `/compact` for the session as the user's queued message: it runs
     * after the current turn (never interrupting it), right away when idle.
     */
    queueCompact(userId: number, sessionId: string): SessionCompactResult {
      requireSession(sessionId);
      if (!isCompactQueued(sessionId)) {
        if (!dependencies.appendQueuedMessage(userId, sessionId, COMPACT_COMMAND)) {
          throw new AppError(
            'Another message is already queued for this session; /compact runs as a turn of its own. Try after it has gone.',
            { code: 'QUEUE_BUSY', statusCode: 409 },
          );
        }
      }
      const dispatchedNow = !dependencies.isSessionProcessing(sessionId);
      dependencies.dispatchQueue();
      cache.delete(sessionId);
      return { queued: true, dispatchedNow };
    },

    /** Takes a queued `/compact` back out of the queue (the user's own). */
    /**
     * Body of GET /api/context/:sessionId/size: the transcript's size on disk,
     * one `stat`, no scan. Non-Claude sessions and sessions without a file yet
     * answer `bytes: null` rather than an error — the chat simply shows nothing.
     */
    async getTranscriptSize(sessionId: string): Promise<SessionTranscriptSize> {
      const session = requireSession(sessionId);
      const transcriptPath = session.provider === 'claude' ? dependencies.resolveTranscriptPath(session) : null;
      const stats = transcriptPath ? await dependencies.statFile(transcriptPath) : null;
      return {
        sessionId,
        bytes: stats ? stats.size : null,
        modifiedAt: stats ? new Date(stats.mtimeMs).toISOString() : null,
      };
    },

    cancelCompact(userId: number, sessionId: string): SessionCompactResult {
      requireSession(sessionId);
      const mine = dependencies.listQueuedFor(sessionId).find((entry) => entry.userId === userId);
      if (mine && mine.content.trim() === COMPACT_COMMAND) {
        dependencies.clearQueuedMessage(userId, sessionId);
      }
      cache.delete(sessionId);
      return { queued: isCompactQueued(sessionId), dispatchedNow: false };
    },
  };
}

/** Process-wide instance; used by this module's routes. */
export const contextUsageService = createContextUsageService();
