import path from 'node:path';

import type { WebSocket } from 'ws';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeEvents, providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, registerChatSocketExtension, WS_OPEN_STATE } from '@/modules/websocket/index.js';
import { createAgentsLiveAggregator, modelFamilyOf } from '@/modules/agents-live/services/agents-live-aggregator.service.js';
import { readExternalTranscript, resolveClaudeTranscriptFile } from '@/modules/agents-live/services/external-transcript.service.js';
import type { ExternalTranscriptReading } from '@/modules/agents-live/services/external-transcript.service.js';
import type {
  AnyRecord,
  LiveAgentNode,
  LiveAgentsActionResult,
  LiveAgentsSession,
  LiveAgentsSnapshot,
  LiveAgentsSocketFrame,
  LiveSessionUsage,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeEventListener,
} from '@/shared/types.js';

/** Frames are coalesced: at most one delta per this many ms. */
const DELTA_FLUSH_MS = 250;
const PRUNE_INTERVAL_MS = 60_000;

type RunningSessionLike = {
  sessionId: string;
  provider: LLMProvider;
  startedAt: number;
  statusText?: string;
};

type AgentsLiveDependencies = {
  now(): number;
  subscribeRuntimeEvents(listener: ProviderRuntimeEventListener): () => void;
  describeSession(sessionId: string, projectPath: string | null): {
    projectId: string | null;
    projectName: string;
    projectPath: string | null;
    sessionTitle: string;
  };
  getSessionProvider(sessionId: string): LLMProvider | null;
  /** Sessions a Claude CLI outside the panel works on (shown without a tree). */
  listRunningSessions(): Promise<RunningSessionLike[]>;
  /** Model, tokens and last calls of such a session, from its transcript; null when unknown. */
  readExternalTranscript(sessionId: string): Promise<ExternalTranscriptReading | null>;
  stopTask(provider: LLMProvider, sessionId: string, taskId: string): Promise<boolean>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  isLive(sessionId: string): boolean;
  resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void;
  getRunStatus(sessionId: string): { status: string; provider: LLMProvider } | null;
  completeAbortedRun(sessionId: string, success: boolean): void;
};

function describeSessionFromDatabase(sessionId: string, runProjectPath: string | null) {
  const session = sessionsDb.getSessionById(sessionId);
  const projectPath = session?.project_path?.trim() ? session.project_path : runProjectPath;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  return {
    projectId: project?.project_id ?? null,
    projectName: project?.custom_project_name?.trim() || (projectPath ? path.basename(projectPath) : 'Без проекта'),
    projectPath: projectPath ?? null,
    sessionTitle: session?.custom_name?.trim() || 'Без названия',
  };
}

const defaultDependencies: AgentsLiveDependencies = {
  now: () => Date.now(),
  subscribeRuntimeEvents: (listener) => providerRuntimeEvents.subscribe(listener),
  describeSession: describeSessionFromDatabase,
  getSessionProvider: (sessionId) => (sessionsDb.getSessionById(sessionId)?.provider as LLMProvider | undefined) ?? null,
  listRunningSessions: () => sessionsService.listRunningSessions(),
  readExternalTranscript: async (sessionId) => {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session || session.provider !== 'claude') {
      return null;
    }
    const filePath = resolveClaudeTranscriptFile(session);
    return filePath ? readExternalTranscript(filePath, session.project_path?.trim() || null) : null;
  },
  stopTask: (provider, sessionId, taskId) => providerRuntimeService.stopTask(provider, sessionId, taskId),
  abort: (provider, sessionId) => providerRuntimeService.abort(provider, sessionId),
  isLive: (sessionId) => providerRuntimeService.isLive(sessionId),
  resolveToolApproval: (requestId, decision) => providerRuntimeService.resolveToolApproval(requestId, decision),
  getRunStatus: (sessionId) => {
    const run = chatRunRegistry.getRun(sessionId);
    return run ? { status: run.status, provider: run.provider as LLMProvider } : null;
  },
  completeAbortedRun: (sessionId, success) => {
    chatRunRegistry.completeRun(sessionId, { exitCode: success ? 0 : 1, aborted: true });
  },
};

function fail(error: string): LiveAgentsActionResult {
  return { ok: false, error };
}

/** Status lines of the providers module, in the panel's language. */
const STATUS_TEXT_RU: Record<string, string> = {
  'Running in the Claude CLI': 'Идёт в терминале Claude',
};

function statusTextRu(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  return STATUS_TEXT_RU[text] ?? text;
}

/** A session a CLI outside the panel runs: only its orchestrator is known, plus what its transcript tells. */
function buildExternalSession(
  entry: RunningSessionLike,
  description: ReturnType<AgentsLiveDependencies['describeSession']>,
  transcript: ExternalTranscriptReading | null,
): LiveAgentsSession {
  const startedAt = new Date(entry.startedAt).toISOString();
  const orchestrator: LiveAgentNode = {
    id: 'main',
    kind: 'orchestrator',
    parentId: null,
    taskId: null,
    toolUseId: null,
    parentTaskId: null,
    spawnDepth: 0,
    name: description.sessionTitle,
    role: 'оркестратор · вне панели',
    model: transcript?.model ?? null,
    modelFamily: modelFamilyOf(transcript?.model ?? null),
    state: 'thinking',
    currentAction: statusTextRu(entry.statusText),
    task: null,
    backgrounded: false,
    startedAt,
    endedAt: null,
    durationMs: Math.max(0, Date.now() - entry.startedAt),
    tokens: transcript?.tokens ?? null,
    outputTokens: null,
    toolCalls: transcript?.toolCalls ?? 0,
    recentActions: transcript?.recentActions ?? [],
    summary: null,
    error: null,
    permission: null,
    canStop: false,
  };
  return {
    sessionId: entry.sessionId,
    provider: entry.provider,
    providerSessionId: null,
    projectId: description.projectId,
    projectName: description.projectName,
    projectPath: description.projectPath,
    sessionTitle: description.sessionTitle,
    status: 'external',
    startedAt,
    updatedAt: startedAt,
    orchestrator,
    agents: [orchestrator],
    workflows: [],
    pendingPermissions: [],
    usage: null,
  };
}

function sendFrame(ws: WebSocket, frame: LiveAgentsSocketFrame): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(frame));
  }
}

function readRequestKey(data: AnyRecord): string | null {
  return typeof data.requestKey === 'string' ? data.requestKey : null;
}

function readId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Live picture of every agent the panel's runtimes drive: folds the provider
 * runtime event tap into the aggregator, serves snapshots, streams coalesced
 * deltas to subscribed chat sockets, and carries out stop / permission
 * actions through the existing runtime gateway.
 *
 * Dependencies are injectable so tests run it without a provider runtime or
 * database; production uses `agentsLiveService` below.
 */
export function createAgentsLiveService(overrides: Partial<AgentsLiveDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const aggregator = createAgentsLiveAggregator({
    now: dependencies.now,
    describeSession: dependencies.describeSession,
  });
  const subscribers = new Set<WebSocket>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let unregisterSocket: (() => void) | null = null;

  const flush = () => {
    flushTimer = null;
    if (subscribers.size === 0) {
      aggregator.clearDelta();
      return;
    }
    const delta = aggregator.takeDelta();
    if (!delta) {
      return;
    }
    for (const ws of subscribers) {
      sendFrame(ws, { kind: 'agents_delta', delta });
    }
  };

  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(flush, DELTA_FLUSH_MS);
      flushTimer.unref?.();
    }
  };

  const service = {
    /** Folds one runtime event (the tap listener; exposed for tests). */
    handleRuntimeEvent(event: Parameters<ProviderRuntimeEventListener>[0]): void {
      aggregator.apply(event);
      scheduleFlush();
    },

    /** Sends pending changes now instead of waiting for the coalescing timer (tests). */
    flushNow(): void {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flush();
    },

    /** Body of GET /api/agents/live: the aggregator's view plus sessions run outside the panel. */
    async getSnapshot(): Promise<LiveAgentsSnapshot> {
      const snapshot = aggregator.snapshot();
      try {
        const running = await dependencies.listRunningSessions();
        const projects = new Set(snapshot.sessions
          .filter((session) => session.status !== 'ended')
          .map((session) => session.projectId ?? session.projectPath ?? session.sessionId));
        for (const entry of running) {
          if (entry.statusText && !aggregator.hasSession(entry.sessionId)) {
            const transcript = await dependencies.readExternalTranscript(entry.sessionId).catch(() => null);
            const session = buildExternalSession(entry, dependencies.describeSession(entry.sessionId, null), transcript);
            snapshot.sessions.push(session);
            // Its orchestrator works, so the header counters count it like any other — one source for every number.
            snapshot.stats.working += 1;
            projects.add(session.projectId ?? session.projectPath ?? session.sessionId);
          }
        }
        snapshot.stats.activeProjects = Math.max(snapshot.stats.activeProjects, projects.size);
      } catch (error) {
        console.warn('[AgentsLive] Could not list external sessions:', error instanceof Error ? error.message : error);
      }
      return snapshot;
    },

    /** Cost and tokens of the session's live process; used by the context-usage module. */
    getSessionUsage(sessionId: string): LiveSessionUsage | null {
      return aggregator.getUsage(sessionId);
    },

    /** Starts streaming to a chat socket: one snapshot, then deltas. */
    async subscribe(ws: WebSocket): Promise<void> {
      subscribers.add(ws);
      sendFrame(ws, { kind: 'agents_snapshot', snapshot: await service.getSnapshot() });
    },

    unsubscribe(ws: WebSocket): void {
      subscribers.delete(ws);
    },

    /** Stops one agent through the CLI (`stopTask`); `main` stops the whole session. */
    async stopAgent(sessionId: string, agentId: string): Promise<LiveAgentsActionResult> {
      if (agentId === 'main') {
        return service.stopSession(sessionId);
      }
      const agent = aggregator.findAgent(sessionId, agentId);
      if (!agent) {
        return fail('Агент не найден.');
      }
      if (agent.terminal) {
        return fail('Агент уже завершён.');
      }
      if (agent.kind === 'workflow_agent') {
        return fail('Агента воркфлоу можно остановить только вместе с воркфлоу.');
      }
      if (!agent.taskId) {
        return fail('Агент ещё не запущен — остановить нечего.');
      }
      const provider = dependencies.getSessionProvider(sessionId);
      if (!provider || !dependencies.isLive(sessionId)) {
        return fail('У сессии нет живого процесса.');
      }
      try {
        const stopped = await dependencies.stopTask(provider, sessionId, agent.taskId);
        return stopped ? { ok: true, error: null } : fail('Процесс не принял остановку.');
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },

    /** «Остановить всё»: interrupts the turn and every agent of the session, like the chat Stop. */
    async stopSession(sessionId: string): Promise<LiveAgentsActionResult> {
      const run = dependencies.getRunStatus(sessionId);
      const provider = run?.provider ?? dependencies.getSessionProvider(sessionId);
      if (!provider) {
        return fail('Сессия не найдена.');
      }
      if (run?.status !== 'running' && !dependencies.isLive(sessionId)) {
        return fail('В сессии ничего не выполняется.');
      }
      const success = await dependencies.abort(provider, sessionId);
      if (run?.status === 'running') {
        // Same as chat.abort: the gateway reports the aborted turn to the chat tabs.
        dependencies.completeAbortedRun(sessionId, success);
      }
      return success ? { ok: true, error: null } : fail('Не удалось остановить сессию.');
    },

    /** Answers a waiting permission prompt through the runtime's approval resolver. */
    answerPermission(requestId: string, decision: ProviderPermissionDecision): LiveAgentsActionResult {
      if (!aggregator.findPermission(requestId)) {
        return fail('Запрос разрешения не найден или уже отвечен.');
      }
      dependencies.resolveToolApproval(requestId, decision);
      return { ok: true, error: null };
    },

    /** Handles the agents.* messages of the chat socket. */
    async handleSocketMessage(ws: WebSocket, data: AnyRecord): Promise<void> {
      const requestKey = readRequestKey(data);
      switch (data.type) {
        case 'agents.subscribe':
          await service.subscribe(ws);
          return;
        case 'agents.unsubscribe':
          service.unsubscribe(ws);
          return;
        case 'agents.stop': {
          const result = await service.stopAgent(readId(data.sessionId), readId(data.agentId));
          sendFrame(ws, { kind: 'agents_action_result', action: 'stop', requestKey, ...result });
          return;
        }
        case 'agents.stop-session': {
          const result = await service.stopSession(readId(data.sessionId));
          sendFrame(ws, { kind: 'agents_action_result', action: 'stop-session', requestKey, ...result });
          return;
        }
        case 'agents.permission': {
          const result = service.answerPermission(readId(data.requestId), {
            allow: data.allow === true,
            message: typeof data.message === 'string' ? data.message : undefined,
            rememberEntry: data.rememberEntry,
          });
          sendFrame(ws, { kind: 'agents_action_result', action: 'permission', requestKey, ...result });
          return;
        }
        default:
      }
    },

    /** Subscribes to the runtime tap, registers agents.* on /ws and starts pruning. Idempotent. */
    start(): void {
      if (unsubscribeEvents) {
        return;
      }
      unsubscribeEvents = dependencies.subscribeRuntimeEvents((event) => service.handleRuntimeEvent(event));
      unregisterSocket = registerChatSocketExtension({
        types: ['agents.subscribe', 'agents.unsubscribe', 'agents.stop', 'agents.stop-session', 'agents.permission'],
        handle: (ws, data) => service.handleSocketMessage(ws, data),
        onClose: (ws) => service.unsubscribe(ws),
      });
      pruneTimer = setInterval(() => {
        if (aggregator.prune()) {
          scheduleFlush();
        }
      }, PRUNE_INTERVAL_MS);
      pruneTimer.unref?.();
    },

    stop(): void {
      unsubscribeEvents?.();
      unregisterSocket?.();
      unsubscribeEvents = null;
      unregisterSocket = null;
      if (pruneTimer) clearInterval(pruneTimer);
      if (flushTimer) clearTimeout(flushTimer);
      pruneTimer = null;
      flushTimer = null;
      subscribers.clear();
    },
  };

  return service;
}

/**
 * Process-wide instance. Started by the server entrypoint
 * (`initializeAgentsLive`), served by this module's routes, and read by the
 * context-usage module for a session's live cost.
 */
export const agentsLiveService = createAgentsLiveService();

/**
 * Started by the server entrypoint: subscribes to the provider runtime event
 * tap and registers the agents.* messages on the chat socket.
 */
export function initializeAgentsLive(): void {
  agentsLiveService.start();
}
