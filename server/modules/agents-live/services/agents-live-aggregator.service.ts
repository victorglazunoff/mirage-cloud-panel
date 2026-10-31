import type {
  AnyRecord,
  LiveAgentAction,
  LiveAgentKind,
  LiveAgentNode,
  LiveAgentPermission,
  LiveAgentState,
  LiveAgentsDelta,
  LiveAgentsFeedEvent,
  LiveAgentsSession,
  LiveAgentsSnapshot,
  LiveAgentsStats,
  LiveSessionUsage,
  LiveWorkflowInfo,
  LiveWorkflowPhase,
  LLMProvider,
  ProviderRuntimeEvent,
  WorkflowAgentProgress,
} from '@/shared/types.js';

/** How the aggregator learns where a session belongs (database lookups in production). */
type SessionDescription = {
  projectId: string | null;
  projectName: string;
  projectPath: string | null;
  sessionTitle: string;
};

type AggregatorDependencies = {
  now(): number;
  describeSession(sessionId: string, projectPath: string | null): SessionDescription;
};

const MAIN_ID = 'main';
const MAX_RECENT_ACTIONS = 10;
const MAX_FEED = 100;
const MAX_NODES_PER_SESSION = 80;
const HOUR_MS = 60 * 60 * 1000;
/** Finished agents of an earlier process stay on screen this long after a new process takes the session. */
const KEEP_FINISHED_NODE_MS = 15 * 60 * 1000;
/** An ended session stays listed this long. */
const KEEP_ENDED_SESSION_MS = HOUR_MS;
const MAX_TEXT = 140;
const MAX_TASK_TEXT = 600;

const TERMINAL_STATES = new Set<LiveAgentState>(['done', 'error', 'stopped']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

type NodeRecord = {
  id: string;
  kind: LiveAgentKind;
  parentId: string | null;
  taskId: string | null;
  toolUseId: string | null;
  parentTaskId: string | null;
  spawnDepth: number;
  name: string;
  role: string | null;
  model: string | null;
  state: LiveAgentState;
  /** State to return to when a permission prompt is answered. */
  stateBeforeWait: LiveAgentState | null;
  currentAction: string | null;
  task: string | null;
  backgrounded: boolean;
  startedAt: number;
  endedAt: number | null;
  cliDurationMs: number | null;
  tokens: number | null;
  toolCalls: number;
  cliToolCalls: number | null;
  recentActions: LiveAgentAction[];
  summary: string | null;
  error: string | null;
  permission: LiveAgentPermission | null;
  /** Tool calls the agent issued that have no result yet. */
  openToolCalls: Set<string>;
};

type SessionRecord = {
  sessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  runId: string | null;
  projectPath: string | null;
  description: SessionDescription;
  processAlive: boolean;
  turnActive: boolean;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  nodes: Map<string, NodeRecord>;
  taskToNode: Map<string, string>;
  /** tool_use id → node that issued the call (who waits on its permission). */
  toolUseOwner: Map<string, string>;
  /** requestId → node waiting on it. */
  permissions: Map<string, string>;
  workflows: Map<string, LiveWorkflowInfo>;
  usage: LiveSessionUsage | null;
  /** Totals of the last `result`, to turn cumulative usage into per-hour samples. */
  lastUsageTotal: number;
  /**
   * Main thread's writing per assistant message id in the current run: the reported
   * `output_tokens` (blocks of one message repeat it, and the stream reports it before the
   * message is done) and the characters of its blocks, for Claude Code's own estimate.
   */
  runOutputTokens: Map<string, { reported: number; chars: number }>;
};

/** One-line text for anything long: first line, trimmed, capped. */
function clip(value: unknown, limit = MAX_TEXT): string {
  if (typeof value !== 'string') {
    return '';
  }
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `opus` / `sonnet` / `haiku` / `fable` from a model id or alias; also used by the service for CLI sessions. */
export function modelFamilyOf(model: string | null): string | null {
  if (!model) {
    return null;
  }
  const match = /(opus|sonnet|haiku|fable)/i.exec(model);
  return match ? match[1].toLowerCase() : null;
}

/** Shortens a path to be relative to the project when it lies inside it. */
function relativeTo(filePath: string, root: string | null): string {
  if (root && filePath.startsWith(`${root.replace(/\/+$/, '')}/`)) {
    return filePath.slice(root.replace(/\/+$/, '').length + 1);
  }
  return filePath;
}

/**
 * The one line an agent's current action shows for a tool call:
 * «server/index.ts» for Read, «npm test» for Bash, the query for WebSearch.
 * Returned without the tool name; callers prefix it where they need it.
 */
export function summarizeToolCall(toolName: string, rawInput: unknown, projectPath: string | null = null): string {
  const input = rawInput && typeof rawInput === 'object' ? rawInput as AnyRecord : {};
  const filePath = readString(input.file_path) ?? readString(input.notebook_path) ?? readString(input.path);
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return clip(filePath ? relativeTo(filePath, projectPath) : '');
    case 'Bash':
      return clip(readString(input.command) ?? readString(input.description) ?? '');
    case 'Grep':
      return clip(`«${readString(input.pattern) ?? ''}»${filePath ? ` в ${relativeTo(filePath, projectPath)}` : ''}`);
    case 'Glob':
      return clip(readString(input.pattern) ?? '');
    case 'WebSearch':
      return clip(readString(input.query) ?? '');
    case 'WebFetch':
      return clip(readString(input.url) ?? '');
    case 'Agent':
    case 'Task': {
      const description = readString(input.description) ?? readString(input.prompt) ?? '';
      const type = readString(input.subagent_type);
      return clip(type ? `${description} (${type})` : description);
    }
    case 'Skill':
      return clip(readString(input.skill) ?? readString(input.name) ?? '');
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} пунктов` : '';
    default: {
      for (const key of ['command', 'file_path', 'path', 'url', 'query', 'pattern', 'description', 'prompt', 'name']) {
        const value = readString(input[key]);
        if (value) {
          return clip(value);
        }
      }
      return '';
    }
  }
}

/**
 * «Bash npm test» — tool name plus summary, mcp__server__tool shown as «server · tool».
 * Used here and by the external-transcript reader of this module (last actions of CLI sessions).
 */
export function describeToolCall(toolName: string, input: unknown, projectPath: string | null): string {
  const label = toolName.startsWith('mcp__') ? toolName.slice(5).replace('__', ' · ') : toolName;
  const summary = summarizeToolCall(toolName, input, projectPath);
  return summary ? `${label} ${summary}` : label;
}

function sumUsageTotal(usage: LiveSessionUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens;
}

/**
 * Folds provider runtime events (SDK stream messages, permission prompts,
 * process start/end) into the «Агенты» read model: per session an
 * orchestrator and a tree of subagents, shells and workflow agents, plus a
 * global feed and counters. Pure apart from the injected clock and session
 * lookup, so tests drive it with event fixtures.
 *
 * Used by the agents-live service, which feeds it the runtime event tap and
 * ships `takeDelta()` to subscribed sockets.
 */
export function createAgentsLiveAggregator(dependencies: AggregatorDependencies) {
  const sessions = new Map<string, SessionRecord>();
  const feed: LiveAgentsFeedEvent[] = [];
  const doneTimes: number[] = [];
  const tokenSamples: Array<{ at: number; tokens: number }> = [];
  let feedSeq = 0;
  let seq = 0;
  const dirty = new Set<string>();
  const removed = new Set<string>();
  let pendingFeed: LiveAgentsFeedEvent[] = [];

  const touch = (session: SessionRecord) => {
    session.updatedAt = dependencies.now();
    dirty.add(session.sessionId);
    removed.delete(session.sessionId);
    seq += 1;
  };

  const pushFeed = (session: SessionRecord, node: NodeRecord, kind: LiveAgentsFeedEvent['kind'], text: string) => {
    feedSeq += 1;
    const event: LiveAgentsFeedEvent = {
      id: feedSeq,
      at: new Date(dependencies.now()).toISOString(),
      sessionId: session.sessionId,
      projectName: session.description.projectName,
      agentId: node.id,
      agentName: node.name,
      kind,
      text,
    };
    feed.unshift(event);
    feed.length = Math.min(feed.length, MAX_FEED);
    pendingFeed.unshift(event);
    pendingFeed.length = Math.min(pendingFeed.length, MAX_FEED);
  };

  const pushAction = (node: NodeRecord, action: Omit<LiveAgentAction, 'at'>) => {
    node.recentActions.unshift({ at: new Date(dependencies.now()).toISOString(), ...action });
    node.recentActions.length = Math.min(node.recentActions.length, MAX_RECENT_ACTIONS);
  };

  const createNode = (session: SessionRecord, init: Partial<NodeRecord> & Pick<NodeRecord, 'id' | 'kind' | 'name'>): NodeRecord => {
    const node: NodeRecord = {
      parentId: MAIN_ID,
      taskId: null,
      toolUseId: null,
      parentTaskId: null,
      spawnDepth: 1,
      role: null,
      model: null,
      state: 'pending',
      stateBeforeWait: null,
      currentAction: null,
      task: null,
      backgrounded: false,
      startedAt: dependencies.now(),
      endedAt: null,
      cliDurationMs: null,
      tokens: null,
      toolCalls: 0,
      cliToolCalls: null,
      recentActions: [],
      summary: null,
      error: null,
      permission: null,
      openToolCalls: new Set(),
      ...init,
    };
    session.nodes.set(node.id, node);
    return node;
  };

  const createOrchestrator = (session: SessionRecord): NodeRecord => createNode(session, {
    id: MAIN_ID,
    kind: 'orchestrator',
    name: session.description.sessionTitle,
    parentId: null,
    spawnDepth: 0,
    role: 'оркестратор',
    state: 'thinking',
  });

  const ensureSession = (event: { sessionId: string; provider: LLMProvider }, projectPath: string | null = null): SessionRecord => {
    let session = sessions.get(event.sessionId);
    if (!session) {
      const now = dependencies.now();
      session = {
        sessionId: event.sessionId,
        provider: event.provider,
        providerSessionId: null,
        runId: null,
        projectPath,
        description: dependencies.describeSession(event.sessionId, projectPath),
        processAlive: true,
        turnActive: true,
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        nodes: new Map(),
        taskToNode: new Map(),
        toolUseOwner: new Map(),
        permissions: new Map(),
        workflows: new Map(),
        usage: null,
        lastUsageTotal: 0,
        runOutputTokens: new Map(),
      };
      sessions.set(event.sessionId, session);
      createOrchestrator(session);
    }
    return session;
  };

  const mainOf = (session: SessionRecord): NodeRecord => session.nodes.get(MAIN_ID) ?? createOrchestrator(session);

  const isTerminal = (node: NodeRecord) => TERMINAL_STATES.has(node.state);

  /** Forgets the tool calls a node issued: nothing will ask who owns them any more. */
  const forgetToolCallsOf = (session: SessionRecord, nodeId: string) => {
    for (const [toolUseId, ownerId] of session.toolUseOwner) {
      if (ownerId === nodeId) session.toolUseOwner.delete(toolUseId);
    }
  };

  /** Removes a node together with its lookups, so they do not outlive it. */
  const dropNode = (session: SessionRecord, nodeId: string) => {
    session.nodes.delete(nodeId);
    session.workflows.delete(nodeId);
    forgetToolCallsOf(session, nodeId);
    session.toolUseOwner.delete(nodeId);
    for (const [taskId, mappedId] of session.taskToNode) {
      if (mappedId === nodeId) session.taskToNode.delete(taskId);
    }
  };

  const finishNode = (session: SessionRecord, node: NodeRecord, state: 'done' | 'error' | 'stopped', text: string) => {
    if (isTerminal(node) && node.state === state) {
      return;
    }
    node.state = state;
    node.endedAt = dependencies.now();
    node.currentAction = node.id === MAIN_ID ? node.currentAction : (node.summary ? clip(node.summary) : text);
    node.openToolCalls.clear();
    node.permission = null;
    if (node.id !== MAIN_ID) {
      forgetToolCallsOf(session, node.id);
    }
    if (state === 'done' && node.id !== MAIN_ID) {
      doneTimes.push(node.endedAt);
    }
    pushAction(node, { tool: state === 'done' ? 'Готово' : state === 'error' ? 'Ошибка' : 'Стоп', text, kind: state === 'error' ? 'error' : 'finish' });
    pushFeed(session, node, state, text);
  };

  /** The node a message belongs to: the subagent behind `parent_tool_use_id`, else the orchestrator. */
  const ownerOf = (session: SessionRecord, parentToolUseId: unknown): NodeRecord => {
    const parentId = readString(parentToolUseId);
    if (!parentId) {
      return mainOf(session);
    }
    return session.nodes.get(parentId) ?? createNode(session, {
      id: parentId,
      kind: 'subagent',
      name: 'субагент',
      toolUseId: parentId,
      parentId: session.toolUseOwner.get(parentId) ?? MAIN_ID,
      state: 'thinking',
    });
  };

  const settleOpenTools = (node: NodeRecord) => {
    if (node.state === 'tool' && node.openToolCalls.size === 0) {
      node.state = 'thinking';
    }
  };

  const launchChild = (session: SessionRecord, owner: NodeRecord, block: AnyRecord) => {
    const input = (block.input && typeof block.input === 'object' ? block.input : {}) as AnyRecord;
    const name = String(block.name);
    const base = {
      id: String(block.id),
      toolUseId: String(block.id),
      parentId: owner.id,
      spawnDepth: owner.spawnDepth + 1,
    };
    if (session.nodes.has(base.id)) {
      return;
    }
    if (AGENT_TOOLS.has(name)) {
      const model = readString(input.model);
      const child = createNode(session, {
        ...base,
        kind: 'subagent',
        name: clip(readString(input.description) ?? 'субагент', 80),
        role: readString(input.subagent_type) ?? 'general-purpose',
        task: clip(readString(input.prompt) ?? '', MAX_TASK_TEXT) || null,
        model,
        backgrounded: input.run_in_background === true,
      });
      pushAction(child, { tool: 'Старт', text: `задача от «${owner.name}»`, kind: 'start' });
      pushFeed(session, child, 'start', `запущен: ${child.name}`);
    } else if (name === 'Bash' && input.run_in_background === true) {
      const command = clip(readString(input.command) ?? '', MAX_TASK_TEXT);
      const child = createNode(session, {
        ...base,
        kind: 'shell',
        name: clip(readString(input.description) ?? command, 80) || 'фоновая команда',
        role: 'фоновая команда',
        task: command || null,
        backgrounded: true,
        state: 'tool',
        currentAction: `Bash ${clip(command)}`,
      });
      pushAction(child, { tool: 'Старт', text: clip(command), kind: 'start' });
      pushFeed(session, child, 'start', `фоновая команда: ${clip(command)}`);
    } else if (name === 'Workflow') {
      const child = createNode(session, {
        ...base,
        kind: 'workflow',
        name: clip(readString(input.name) ?? readString(input.workflow) ?? readString(input.description) ?? 'воркфлоу', 80),
        role: 'оркестратор воркфлоу',
        backgrounded: true,
      });
      pushFeed(session, child, 'start', `воркфлоу: ${child.name}`);
    }
  };

  /**
   * What the main thread wrote: every content block of one API message carries that message's
   * usage, reported before the message is finished (a block can say 2 tokens out of 400). So
   * the count per message is the larger of the reported number and Claude Code's own spinner
   * estimate — about four characters a token over the text, thinking and tool input written.
   */
  const recordWriting = (session: SessionRecord, body: AnyRecord) => {
    const messageId = readString(body.id);
    if (!messageId) {
      return;
    }
    const entry = session.runOutputTokens.get(messageId) ?? { reported: 0, chars: 0 };
    const usage = body.usage as AnyRecord | undefined;
    entry.reported = Math.max(entry.reported, readNumber(usage?.output_tokens) ?? 0);
    const content = Array.isArray(body.content) ? body.content as AnyRecord[] : [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        entry.chars += block.text.length;
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        entry.chars += block.thinking.length;
      } else if (block?.type === 'tool_use') {
        entry.chars += JSON.stringify(block.input ?? {}).length;
      }
    }
    session.runOutputTokens.set(messageId, entry);
  };

  const applyAssistant = (session: SessionRecord, message: AnyRecord) => {
    const owner = ownerOf(session, message.parent_tool_use_id);
    const body = (message.message ?? {}) as AnyRecord;
    const model = readString(body.model);
    if (model && model !== '<synthetic>') {
      owner.model = model;
    }
    if (owner.id === MAIN_ID) {
      session.turnActive = true;
      const usage = body.usage as AnyRecord | undefined;
      if (usage) {
        const context = (readNumber(usage.input_tokens) ?? 0) + (readNumber(usage.cache_read_input_tokens) ?? 0)
          + (readNumber(usage.cache_creation_input_tokens) ?? 0) + (readNumber(usage.output_tokens) ?? 0);
        if (context > 0) {
          owner.tokens = context;
        }
      }
      recordWriting(session, body);
    }
    if (owner.state === 'pending' || (isTerminal(owner) && owner.id === MAIN_ID)) {
      owner.state = 'thinking';
      owner.endedAt = null;
    }
    const content = Array.isArray(body.content) ? body.content as AnyRecord[] : [];
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        const toolName = String(block.name ?? 'tool');
        session.toolUseOwner.set(block.id, owner.id);
        owner.openToolCalls.add(block.id);
        owner.toolCalls += 1;
        const summary = summarizeToolCall(toolName, block.input, session.projectPath);
        owner.currentAction = describeToolCall(toolName, block.input, session.projectPath);
        if (owner.state !== 'waiting' && !isTerminal(owner)) {
          owner.state = 'tool';
        }
        pushAction(owner, { tool: toolName, text: summary, kind: 'tool' });
        pushFeed(session, owner, 'tool', owner.currentAction);
        launchChild(session, owner, block);
      } else if (block?.type === 'text' && owner.openToolCalls.size === 0) {
        const text = clip(block.text);
        if (text) {
          owner.currentAction = text;
        }
      }
    }
  };

  const applyUser = (session: SessionRecord, message: AnyRecord) => {
    const content = (message.message as AnyRecord | undefined)?.content;
    if (!Array.isArray(content)) {
      return;
    }
    const owner = ownerOf(session, message.parent_tool_use_id);
    for (const block of content as AnyRecord[]) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
        continue;
      }
      owner.openToolCalls.delete(block.tool_use_id);
      // An answered call of the orchestrator is not looked up again (a late
      // lookup falls back to the orchestrator anyway); a subagent's calls go
      // when it finishes.
      if (session.toolUseOwner.get(block.tool_use_id) === MAIN_ID) {
        session.toolUseOwner.delete(block.tool_use_id);
      }
      if (block.is_error === true) {
        const action = owner.recentActions.find((entry) => entry.kind === 'tool');
        if (action) {
          action.failed = true;
        }
      }
      // A foreground subagent's result is its end; a background one's is only the launch receipt.
      const child = session.nodes.get(block.tool_use_id);
      if (child && child.kind === 'subagent' && !child.backgrounded && !isTerminal(child)) {
        finishNode(session, child, block.is_error === true ? 'error' : 'done', block.is_error === true ? 'ошибка' : 'готово');
      }
    }
    settleOpenTools(owner);
  };

  const nodeForTask = (session: SessionRecord, taskId: string): NodeRecord | undefined => {
    const nodeId = session.taskToNode.get(taskId);
    return nodeId ? session.nodes.get(nodeId) : undefined;
  };

  const kindForTaskType = (taskType: string | null): LiveAgentKind => {
    switch (taskType) {
      case 'local_agent':
      case 'remote_agent':
        return 'subagent';
      case 'local_bash':
        return 'shell';
      case 'local_workflow':
        return 'workflow';
      default:
        return 'task';
    }
  };

  const applyTaskStarted = (session: SessionRecord, message: AnyRecord) => {
    const taskId = readString(message.task_id);
    const taskType = readString(message.task_type);
    if (!taskId || message.ambient === true) {
      return;
    }
    const toolUseId = readString(message.tool_use_id);
    let node = toolUseId ? session.nodes.get(toolUseId) : undefined;
    // A plain foreground command is a tool call, not an agent.
    if (!node && taskType === 'local_bash' && message.is_backgrounded === false) {
      return;
    }
    const parentTaskId = readString(message.parent_task_id);
    const parentNode = parentTaskId ? nodeForTask(session, parentTaskId) : undefined;
    if (!node) {
      const parentId = parentNode?.id ?? (toolUseId ? session.toolUseOwner.get(toolUseId) : undefined) ?? MAIN_ID;
      const parent = session.nodes.get(parentId) ?? mainOf(session);
      node = createNode(session, {
        id: toolUseId ?? `task:${taskId}`,
        kind: kindForTaskType(taskType),
        name: clip(readString(message.workflow_name) ?? readString(message.description) ?? 'задача', 80),
        toolUseId,
        parentId: parent.id,
        spawnDepth: parent.spawnDepth + 1,
      });
      pushFeed(session, node, 'start', `запущен: ${node.name}`);
    }
    node.taskId = taskId;
    session.taskToNode.set(taskId, node.id);
    node.parentTaskId = parentTaskId;
    if (parentNode && node.parentId !== parentNode.id) {
      node.parentId = parentNode.id;
    }
    const spawnDepth = readNumber(message.spawn_depth);
    if (spawnDepth !== null) {
      // CLI depth counts from 0 for the orchestrator's own agents.
      node.spawnDepth = spawnDepth + 1;
    }
    if (taskType === 'local_workflow') {
      node.kind = 'workflow';
      node.name = clip(readString(message.workflow_name) ?? node.name, 80);
      node.role = 'оркестратор воркфлоу';
    }
    const subagentType = readString(message.subagent_type);
    if (subagentType && node.kind === 'subagent') {
      node.role = subagentType;
    }
    if (!node.task) {
      node.task = clip(readString(message.prompt) ?? '', MAX_TASK_TEXT) || null;
    }
    if (typeof message.is_backgrounded === 'boolean') {
      node.backgrounded = message.is_backgrounded;
    }
    if (node.state === 'pending') {
      node.state = node.kind === 'shell' ? 'tool' : 'thinking';
    }
  };

  const applyWorkflowProgress = (session: SessionRecord, node: NodeRecord, agents: WorkflowAgentProgress[]) => {
    const phases: LiveWorkflowPhase[] = [];
    const phaseByTitle = new Map<string, LiveWorkflowPhase>();
    for (const agent of agents) {
      const id = `${node.id}:${agent.index}`;
      let child = session.nodes.get(id);
      if (!child) {
        child = createNode(session, {
          id,
          kind: 'workflow_agent',
          name: clip(agent.label ?? `агент ${agent.index + 1}`, 80),
          parentId: node.id,
          spawnDepth: node.spawnDepth + 1,
          backgrounded: true,
          startedAt: agent.startedAt ?? dependencies.now(),
        });
        pushFeed(session, child, 'start', `запущен: ${child.name}`);
      }
      child.role = agent.phase ?? 'агент воркфлоу';
      child.model = agent.model ?? child.model;
      child.task = clip(agent.promptPreview ?? '', MAX_TASK_TEXT) || child.task;
      child.tokens = agent.tokens ?? child.tokens;
      child.cliToolCalls = agent.toolCalls ?? child.cliToolCalls;
      child.cliDurationMs = agent.durationMs ?? child.cliDurationMs;
      if (agent.lastToolName) {
        const action = agent.lastToolSummary ? `${agent.lastToolName} ${clip(agent.lastToolSummary)}` : agent.lastToolName;
        if (action !== child.currentAction) {
          child.currentAction = action;
          pushAction(child, { tool: agent.lastToolName, text: clip(agent.lastToolSummary ?? ''), kind: 'tool' });
        }
      }
      if (agent.state === 'queued') {
        child.state = 'pending';
      } else if (agent.state === 'running') {
        if (child.state !== 'waiting') {
          child.state = agent.lastToolName ? 'tool' : 'thinking';
        }
      } else if (agent.state === 'done') {
        child.summary = clip(agent.resultPreview ?? '', MAX_TASK_TEXT) || child.summary;
        finishNode(session, child, 'done', 'готово');
      } else {
        finishNode(session, child, 'error', 'ошибка');
      }

      const title = agent.phase ?? 'Агенты';
      let phase = phaseByTitle.get(title);
      if (!phase) {
        phase = { index: phases.length, title, state: 'queued', agentIds: [] };
        phaseByTitle.set(title, phase);
        phases.push(phase);
      }
      phase.agentIds.push(id);
    }
    for (const phase of phases) {
      const states = phase.agentIds.map((id) => session.nodes.get(id)?.state);
      phase.state = states.includes('error') ? 'failed'
        : states.includes('waiting') ? 'waiting'
          : states.some((state) => state === 'thinking' || state === 'tool') ? 'running'
            : states.every((state) => state === 'done') ? 'done' : 'queued';
    }
    session.workflows.set(node.id, { nodeId: node.id, name: node.name, phases });
  };

  const applyTaskProgress = (session: SessionRecord, message: AnyRecord, normalized: AnyRecord[]) => {
    const taskId = readString(message.task_id);
    const node = taskId ? nodeForTask(session, taskId) : undefined;
    if (!node) {
      return;
    }
    const usage = message.usage as AnyRecord | undefined;
    if (usage) {
      node.tokens = readNumber(usage.total_tokens) ?? node.tokens;
      node.cliToolCalls = readNumber(usage.tool_uses) ?? node.cliToolCalls;
      node.cliDurationMs = readNumber(usage.duration_ms) ?? node.cliDurationMs;
    }
    const summary = readString(message.summary);
    if (summary) {
      node.summary = clip(summary, MAX_TASK_TEXT);
      if (node.state === 'thinking') {
        node.currentAction = clip(summary);
      }
    }
    const lastTool = readString(message.last_tool_name);
    if (lastTool && node.kind !== 'workflow' && !node.currentAction) {
      node.currentAction = lastTool;
    }
    if (node.state === 'pending') {
      node.state = 'thinking';
    }
    const agents = normalized.find((entry) => entry?.kind === 'task_status' && Array.isArray(entry.agents))?.agents;
    if (node.kind === 'workflow' && Array.isArray(agents)) {
      applyWorkflowProgress(session, node, agents as WorkflowAgentProgress[]);
      const running = (agents as WorkflowAgentProgress[]).find((agent) => agent.state === 'running');
      node.currentAction = running ? `${running.phase ? `${running.phase}: ` : ''}${running.label ?? 'агент'}` : node.currentAction;
      node.state = running ? 'thinking' : node.state;
    }
  };

  const applyTaskUpdated = (session: SessionRecord, message: AnyRecord) => {
    const taskId = readString(message.task_id);
    const node = taskId ? nodeForTask(session, taskId) : undefined;
    const patch = (message.patch ?? {}) as AnyRecord;
    if (!node) {
      return;
    }
    if (typeof patch.is_backgrounded === 'boolean') {
      node.backgrounded = patch.is_backgrounded;
    }
    const description = readString(patch.description);
    if (description && node.kind !== 'workflow') {
      node.name = clip(description, 80);
    }
    switch (patch.status) {
      case 'running':
        if (node.state === 'pending' || node.state === 'paused') {
          node.state = 'thinking';
        }
        break;
      case 'paused':
        node.state = 'paused';
        break;
      case 'completed':
        finishNode(session, node, 'done', 'готово');
        break;
      case 'failed':
        node.error = clip(readString(patch.error) ?? 'ошибка', MAX_TASK_TEXT);
        finishNode(session, node, 'error', node.error);
        break;
      case 'killed':
        finishNode(session, node, 'stopped', 'остановлен');
        break;
      default:
    }
    const endTime = readNumber(patch.end_time);
    // Outside the Date range (±8.64e15) toISOString throws in the flush timer;
    // such a value from the CLI is broken data — keep our own end time.
    if (endTime !== null && Number.isFinite(new Date(endTime).getTime()) && isTerminal(node)) {
      node.endedAt = endTime;
    }
  };

  const applyTaskNotification = (session: SessionRecord, message: AnyRecord) => {
    const taskId = readString(message.task_id);
    const node = taskId ? nodeForTask(session, taskId) : undefined;
    if (!node) {
      return;
    }
    const usage = message.usage as AnyRecord | undefined;
    if (usage) {
      node.tokens = readNumber(usage.total_tokens) ?? node.tokens;
      node.cliToolCalls = readNumber(usage.tool_uses) ?? node.cliToolCalls;
      node.cliDurationMs = readNumber(usage.duration_ms) ?? node.cliDurationMs;
    }
    const summary = readString(message.summary);
    if (summary) {
      node.summary = clip(summary, MAX_TASK_TEXT);
      if (isTerminal(node)) {
        // Settled earlier by its tool result; the notification brings the summary.
        node.currentAction = clip(summary);
      }
    }
    if (message.status === 'completed') {
      finishNode(session, node, 'done', clip(summary ?? 'готово'));
    } else if (message.status === 'failed') {
      node.error = clip(summary ?? 'ошибка', MAX_TASK_TEXT);
      finishNode(session, node, 'error', node.error);
    } else {
      finishNode(session, node, 'stopped', 'остановлен');
    }
  };

  const applyResult = (session: SessionRecord, message: AnyRecord) => {
    const main = mainOf(session);
    session.turnActive = false;
    main.openToolCalls.clear();
    if (message.is_error === true || (typeof message.subtype === 'string' && message.subtype.startsWith('error'))) {
      const errors = Array.isArray(message.errors) ? message.errors.join('; ') : readString(message.result);
      main.error = clip(errors ?? 'ошибка', MAX_TASK_TEXT);
      finishNode(session, main, 'error', main.error);
    } else {
      main.summary = clip(readString(message.result) ?? '', MAX_TASK_TEXT) || main.summary;
      finishNode(session, main, 'done', 'ход завершён');
    }
    const modelUsage = message.modelUsage as Record<string, AnyRecord> | undefined;
    const usage: LiveSessionUsage = {
      costUsd: readNumber(message.total_cost_usd),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      byModel: {},
      turns: (session.usage?.turns ?? 0) + 1,
    };
    for (const [model, entry] of Object.entries(modelUsage ?? {})) {
      const row = {
        inputTokens: readNumber(entry?.inputTokens) ?? 0,
        outputTokens: readNumber(entry?.outputTokens) ?? 0,
        cacheReadTokens: readNumber(entry?.cacheReadInputTokens) ?? 0,
        cacheCreationTokens: readNumber(entry?.cacheCreationInputTokens) ?? 0,
        costUsd: readNumber(entry?.costUSD) ?? 0,
        contextWindow: readNumber(entry?.contextWindow),
      };
      usage.byModel[model] = row;
      usage.inputTokens += row.inputTokens;
      usage.outputTokens += row.outputTokens;
      usage.cacheReadTokens += row.cacheReadTokens;
      usage.cacheCreationTokens += row.cacheCreationTokens;
    }
    if (!modelUsage && message.usage) {
      const raw = message.usage as AnyRecord;
      usage.inputTokens = readNumber(raw.input_tokens) ?? 0;
      usage.outputTokens = readNumber(raw.output_tokens) ?? 0;
      usage.cacheReadTokens = readNumber(raw.cache_read_input_tokens) ?? 0;
      usage.cacheCreationTokens = readNumber(raw.cache_creation_input_tokens) ?? 0;
    }
    // modelUsage is cumulative for the process: the hour counter takes the growth.
    const total = sumUsageTotal(usage);
    const delta = total >= session.lastUsageTotal ? total - session.lastUsageTotal : total;
    session.lastUsageTotal = total;
    if (delta > 0) {
      tokenSamples.push({ at: dependencies.now(), tokens: delta });
    }
    session.usage = usage;
  };

  const startRun = (session: SessionRecord, event: Extract<ProviderRuntimeEvent, { type: 'run_started' }>) => {
    const now = dependencies.now();
    session.runId = event.runId;
    session.processAlive = true;
    session.turnActive = true;
    session.endedAt = null;
    session.providerSessionId = event.providerSessionId ?? session.providerSessionId;
    if (event.projectPath) {
      session.projectPath = event.projectPath;
    }
    session.description = dependencies.describeSession(session.sessionId, session.projectPath);
    session.usage = null;
    session.lastUsageTotal = 0;
    session.runOutputTokens.clear();
    session.permissions.clear();
    // Events of the earlier process are ignored from now on: its lookups go.
    session.toolUseOwner.clear();
    session.taskToNode.clear();
    // Finished agents of earlier processes stay a while; the rest of the tree is new.
    for (const [id, node] of session.nodes) {
      if (id !== MAIN_ID && (!isTerminal(node) || (node.endedAt ?? now) < now - KEEP_FINISHED_NODE_MS)) {
        dropNode(session, id);
      }
    }
    const main = mainOf(session);
    main.name = session.description.sessionTitle;
    main.state = 'thinking';
    main.startedAt = now;
    main.endedAt = null;
    main.error = null;
    main.permission = null;
    main.currentAction = null;
    main.toolCalls = 0;
    main.openToolCalls.clear();
    pushFeed(session, main, 'turn', 'новый ход');
  };

  const endRun = (session: SessionRecord, event: Extract<ProviderRuntimeEvent, { type: 'run_ended' }>) => {
    session.processAlive = false;
    session.turnActive = false;
    session.endedAt = dependencies.now();
    session.permissions.clear();
    session.toolUseOwner.clear();
    for (const node of session.nodes.values()) {
      if (isTerminal(node)) {
        continue;
      }
      if (node.id === MAIN_ID && event.reason === 'error') {
        node.error = clip(event.error ?? 'ошибка', MAX_TASK_TEXT);
        finishNode(session, node, 'error', node.error);
      } else {
        finishNode(session, node, 'stopped', event.reason === 'aborted' ? 'остановлен' : 'процесс завершён');
      }
    }
  };

  const pruneNodes = (session: SessionRecord) => {
    if (session.nodes.size <= MAX_NODES_PER_SESSION) {
      return;
    }
    const finished = [...session.nodes.values()]
      .filter((node) => node.id !== MAIN_ID && isTerminal(node))
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const node of finished) {
      if (session.nodes.size <= MAX_NODES_PER_SESSION) {
        break;
      }
      dropNode(session, node.id);
    }
  };

  const toNode = (session: SessionRecord, node: NodeRecord, now: number): LiveAgentNode => {
    const end = node.endedAt ?? now;
    return {
      id: node.id,
      kind: node.kind,
      parentId: node.parentId,
      taskId: node.taskId,
      toolUseId: node.toolUseId,
      parentTaskId: node.parentTaskId,
      spawnDepth: node.spawnDepth,
      name: node.name,
      role: node.role,
      model: node.model,
      modelFamily: modelFamilyOf(node.model),
      state: node.state,
      currentAction: node.currentAction,
      task: node.task,
      backgrounded: node.backgrounded,
      startedAt: new Date(node.startedAt).toISOString(),
      endedAt: node.endedAt === null ? null : new Date(node.endedAt).toISOString(),
      durationMs: Math.max(0, isTerminal(node) && node.cliDurationMs !== null ? node.cliDurationMs : end - node.startedAt),
      tokens: node.tokens,
      outputTokens: node.id === MAIN_ID && session.runOutputTokens.size > 0
        ? [...session.runOutputTokens.values()]
          .reduce((sum, entry) => sum + Math.max(entry.reported, Math.round(entry.chars / 4)), 0)
        : null,
      toolCalls: Math.max(node.toolCalls, node.cliToolCalls ?? 0),
      recentActions: node.recentActions.map((action) => ({ ...action })),
      summary: node.summary,
      error: node.error,
      permission: node.permission,
      canStop: session.processAlive && !isTerminal(node)
        && (node.id === MAIN_ID || (node.taskId !== null && node.kind !== 'workflow_agent')),
    };
  };

  const sessionStatus = (session: SessionRecord): LiveAgentsSession['status'] => {
    if (!session.processAlive) {
      return 'ended';
    }
    if (session.permissions.size > 0) {
      return 'waiting';
    }
    const nodes = [...session.nodes.values()];
    if (session.turnActive || nodes.some((node) => node.id === MAIN_ID && !isTerminal(node))) {
      return 'running';
    }
    return nodes.some((node) => !isTerminal(node)) ? 'background' : 'idle';
  };

  const toSession = (session: SessionRecord, now: number): LiveAgentsSession => {
    const agents = [...session.nodes.values()]
      .sort((a, b) => (a.id === MAIN_ID ? -1 : b.id === MAIN_ID ? 1 : a.startedAt - b.startedAt))
      .map((node) => toNode(session, node, now));
    const pendingPermissions = agents
      .filter((node) => node.permission)
      .map((node) => ({ ...(node.permission as LiveAgentPermission), agentId: node.id }));
    return {
      sessionId: session.sessionId,
      provider: session.provider,
      providerSessionId: session.providerSessionId,
      projectId: session.description.projectId,
      projectName: session.description.projectName,
      projectPath: session.projectPath,
      sessionTitle: session.description.sessionTitle,
      status: sessionStatus(session),
      startedAt: new Date(session.startedAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
      orchestrator: agents[0],
      agents,
      workflows: [...session.workflows.values()].map((workflow) => ({
        ...workflow,
        phases: workflow.phases.map((phase) => ({ ...phase, agentIds: [...phase.agentIds] })),
      })),
      pendingPermissions,
      usage: session.usage ? { ...session.usage, byModel: { ...session.usage.byModel } } : null,
    };
  };

  const computeStats = (now: number): LiveAgentsStats => {
    while (doneTimes.length > 0 && doneTimes[0] < now - HOUR_MS) {
      doneTimes.shift();
    }
    while (tokenSamples.length > 0 && tokenSamples[0].at < now - HOUR_MS) {
      tokenSamples.shift();
    }
    let working = 0;
    let waiting = 0;
    let errors = 0;
    const projects = new Set<string>();
    for (const session of sessions.values()) {
      if (session.processAlive) {
        projects.add(session.description.projectId ?? session.projectPath ?? session.sessionId);
      }
      for (const node of session.nodes.values()) {
        if (node.state === 'waiting') waiting += 1;
        else if (node.state === 'error') errors += 1;
        else if (!isTerminal(node)) working += 1;
      }
    }
    return {
      working,
      waiting,
      doneLastHour: doneTimes.length,
      errors,
      tokensLastHour: tokenSamples.reduce((sum, sample) => sum + sample.tokens, 0),
      activeProjects: projects.size,
    };
  };

  return {
    /** Folds one runtime event; events of a replaced process are ignored. */
    apply(event: ProviderRuntimeEvent): void {
      if (event.type === 'run_started') {
        const session = ensureSession(event, event.projectPath);
        startRun(session, event);
        touch(session);
        return;
      }
      const existing = sessions.get(event.sessionId);
      if (existing?.runId && event.runId !== existing.runId) {
        return;
      }
      if (event.type === 'run_ended') {
        if (existing && event.reason !== 'superseded') {
          endRun(existing, event);
          touch(existing);
        }
        return;
      }
      const session = existing ?? ensureSession(event);
      session.runId = event.runId;

      if (event.type === 'permission_requested') {
        const ownerId = (event.toolUseId && session.toolUseOwner.get(event.toolUseId)) || MAIN_ID;
        const node = session.nodes.get(ownerId) ?? mainOf(session);
        const summary = describeToolCall(event.toolName, event.input, session.projectPath);
        node.permission = {
          requestId: event.requestId,
          toolName: event.toolName,
          summary,
          input: event.input,
          receivedAt: new Date(event.at).toISOString(),
        };
        if (node.state !== 'waiting') {
          node.stateBeforeWait = isTerminal(node) ? 'tool' : node.state;
        }
        node.state = 'waiting';
        node.currentAction = `${summary} — ждёт разрешения`;
        session.permissions.set(event.requestId, node.id);
        pushAction(node, { tool: event.toolName, text: `ждёт разрешения: ${summarizeToolCall(event.toolName, event.input, session.projectPath)}`, kind: 'permission' });
        pushFeed(session, node, 'waiting', `ждёт разрешения: ${summary}`);
        touch(session);
        return;
      }

      if (event.type === 'permission_settled') {
        const nodeId = session.permissions.get(event.requestId);
        session.permissions.delete(event.requestId);
        const node = nodeId ? session.nodes.get(nodeId) : undefined;
        if (node && node.permission?.requestId === event.requestId) {
          const text = event.outcome === 'allowed' ? 'разрешено'
            : event.outcome === 'denied' ? 'отклонено' : event.outcome === 'timeout' ? 'время ответа вышло' : 'запрос снят';
          node.permission = null;
          if (node.state === 'waiting') {
            node.state = event.outcome === 'allowed' ? (node.stateBeforeWait ?? 'tool') : 'thinking';
          }
          node.stateBeforeWait = null;
          pushAction(node, { tool: 'Ты', text, kind: 'permission' });
          pushFeed(session, node, 'resolved', text);
          touch(session);
        }
        return;
      }

      const message = event.message;
      session.providerSessionId = event.providerSessionId ?? session.providerSessionId;
      switch (message?.type) {
        case 'assistant':
          applyAssistant(session, message);
          break;
        case 'user':
          applyUser(session, message);
          break;
        case 'result':
          applyResult(session, message);
          break;
        case 'system':
          switch (message.subtype) {
            case 'init': {
              const main = mainOf(session);
              session.turnActive = true;
              main.state = 'thinking';
              main.endedAt = null;
              main.error = null;
              main.model = readString(message.model) ?? main.model;
              break;
            }
            case 'task_started':
              applyTaskStarted(session, message);
              break;
            case 'task_progress':
              applyTaskProgress(session, message, event.normalized as unknown as AnyRecord[]);
              break;
            case 'task_updated':
              applyTaskUpdated(session, message);
              break;
            case 'task_notification':
              applyTaskNotification(session, message);
              break;
            case 'session_state_changed':
              if (message.state === 'idle') session.turnActive = false;
              else if (message.state === 'running') session.turnActive = true;
              break;
            default:
              return;
          }
          break;
        default:
          // tool_progress, stream events, rate limits: nothing the screen shows.
          return;
      }
      pruneNodes(session);
      touch(session);
    },

    /** Drops ended sessions older than an hour; returns true when something went. */
    prune(): boolean {
      const now = dependencies.now();
      let changed = false;
      for (const [sessionId, session] of sessions) {
        if (!session.processAlive && (session.endedAt ?? now) < now - KEEP_ENDED_SESSION_MS) {
          sessions.delete(sessionId);
          dirty.delete(sessionId);
          removed.add(sessionId);
          seq += 1;
          changed = true;
        }
      }
      return changed;
    },

    /** Whether the aggregator lists the session. */
    hasSession(sessionId: string): boolean {
      return sessions.has(sessionId);
    },

    /** The session a pending permission prompt belongs to, or null when none waits under that id. */
    findPermission(requestId: string): string | null {
      for (const session of sessions.values()) {
        if (session.permissions.has(requestId)) {
          return session.sessionId;
        }
      }
      return null;
    },

    /** Cost and token totals of the session's live process, from its `result` messages. */
    getUsage(sessionId: string): LiveSessionUsage | null {
      const usage = sessions.get(sessionId)?.usage;
      return usage ? { ...usage, byModel: { ...usage.byModel } } : null;
    },

    /** Forgets pending changes without building a delta (nobody is subscribed). */
    clearDelta(): void {
      dirty.clear();
      removed.clear();
      pendingFeed = [];
    },

    /** Sizes of a session's internal lookups — for tests and diagnostics of memory growth. */
    debugCounts(sessionId: string): { nodes: number; toolUseOwner: number; taskToNode: number } | null {
      const session = sessions.get(sessionId);
      return session
        ? { nodes: session.nodes.size, toolUseOwner: session.toolUseOwner.size, taskToNode: session.taskToNode.size }
        : null;
    },

    /** Node view used by the stop action to find the task id behind an agent id. */
    findAgent(sessionId: string, agentId: string): { taskId: string | null; kind: LiveAgentKind; terminal: boolean } | null {
      const node = sessions.get(sessionId)?.nodes.get(agentId);
      return node ? { taskId: node.taskId, kind: node.kind, terminal: isTerminal(node) } : null;
    },

    snapshot(): LiveAgentsSnapshot {
      const now = dependencies.now();
      return {
        generatedAt: new Date(now).toISOString(),
        seq,
        sessions: [...sessions.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((session) => toSession(session, now)),
        feed: feed.map((event) => ({ ...event })),
        stats: computeStats(now),
      };
    },

    /** Changes since the previous call, or null when nothing changed. */
    takeDelta(): LiveAgentsDelta | null {
      if (dirty.size === 0 && removed.size === 0 && pendingFeed.length === 0) {
        return null;
      }
      const now = dependencies.now();
      const delta: LiveAgentsDelta = {
        seq,
        generatedAt: new Date(now).toISOString(),
        sessions: [...dirty]
          .map((sessionId) => sessions.get(sessionId))
          .filter((session): session is SessionRecord => Boolean(session))
          .map((session) => toSession(session, now)),
        removedSessionIds: [...removed],
        feed: pendingFeed,
        stats: computeStats(now),
      };
      dirty.clear();
      removed.clear();
      pendingFeed = [];
      return delta;
    },
  };
}
