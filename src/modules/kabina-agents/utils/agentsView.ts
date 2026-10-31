// View model of the «Агенты» screen (DarkAgents): turns the live agent trees
// into the radar layout, labels and numbers the mock-up shows. Pure functions,
// so the layout and wording are covered by tests without rendering.
import { toPanelWall } from '@/modules/kabina';
import type { LiveAgentNode, LiveAgentState, LiveAgentsSession, LiveWorkflowPhase } from '@/shared/types';

/** The six looks of DarkAgents: think / tool / wait / done / off / error. */
export type AgentLook = 'think' | 'tool' | 'wait' | 'done' | 'off' | 'error';

const LOOK_BY_STATE: Record<LiveAgentState, AgentLook> = {
  pending: 'think',
  thinking: 'think',
  paused: 'think',
  tool: 'tool',
  waiting: 'wait',
  done: 'done',
  stopped: 'off',
  error: 'error',
};

const LABEL_BY_STATE: Record<LiveAgentState, string> = {
  pending: 'в очереди',
  thinking: 'думает',
  paused: 'пауза',
  tool: 'инструмент',
  waiting: 'ждёт тебя',
  done: 'готово',
  stopped: 'остановлен',
  error: 'ошибка',
};

export function agentLook(state: LiveAgentState): AgentLook {
  return LOOK_BY_STATE[state];
}

export function agentStateLabel(state: LiveAgentState): string {
  return LABEL_BY_STATE[state];
}

/** Ended for good: the timer stops and the agent can only be looked at. */
export function isTerminalState(state: LiveAgentState): boolean {
  return state === 'done' || state === 'error' || state === 'stopped';
}

/** Working or waiting: the agent still counts as «в эфире». */
export function isActiveState(state: LiveAgentState): boolean {
  return !isTerminalState(state);
}

// ------------------------------------------------------------ числа и время

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** «02:14» or «1:04:09», as the mock-up's timers. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
}

/** «9,8k», «312,4k», «1,84M»; null tokens are «—» (callers hide the field when they have none). */
export function formatTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens)) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1e6).toFixed(2).replace('.', ',')}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1).replace('.', ',')}k`;
  return String(Math.round(tokens));
}

/** Big number of the «ТОКЕНЫ / ЧАС» cell, split into the digits and the unit. */
export function tokensPerHourParts(tokens: number): { n: string; unit: string } {
  if (tokens >= 1_000_000) return { n: (tokens / 1e6).toFixed(2).replace('.', ','), unit: 'M' };
  if (tokens >= 1000) return { n: (tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1).replace('.', ','), unit: 'k' };
  return { n: String(Math.round(tokens)), unit: '' };
}

/** «14:32» or «14:32:16» in the panel's time zone. */
export function formatClock(value: string | number | Date, withSeconds: boolean): string {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return '--:--';
  const date = toPanelWall(instant);
  const base = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(date.getSeconds())}` : base;
}

/** Russian plural: ruPlural(3, 'агент', 'агента', 'агентов') → «агента». */
export function ruPlural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Work time now: the server's figure plus the time since the frame for an agent that still runs. */
export function liveDurationMs(agent: LiveAgentNode, receivedAt: number | undefined, now: number): number {
  if (isTerminalState(agent.state) || receivedAt === undefined) return agent.durationMs;
  return agent.durationMs + Math.max(0, now - receivedAt);
}

/** `~/demo-site` from a project path. */
export function shortProjectPath(path: string | null): string {
  if (!path) return '';
  const name = path.split('/').filter(Boolean).pop();
  return name ? `~/${name}` : path;
}

/** One-line «что сейчас» of an agent: its action, else its error, summary or state. */
export function agentActivity(agent: LiveAgentNode): string {
  if (agent.state === 'waiting' && agent.permission) {
    return `${agent.permission.toolName}: ${agent.permission.summary} — нужно «разрешить один раз»`;
  }
  if (agent.state === 'error') return agent.error || agent.currentAction || 'Ошибка без описания';
  if (isTerminalState(agent.state)) return agent.summary || agent.currentAction || agentStateLabel(agent.state);
  return agent.currentAction || agent.summary || agentStateLabel(agent.state);
}

// ------------------------------------------------------------ радар

/** A contact on the radar: one agent with its place in percent of the stage. */
export type RadarNode = {
  agent: LiveAgentNode;
  look: AgentLook;
  /** Centre, percent of the stage width / height. */
  x: number;
  y: number;
  width: number;
};

/** A line from the parent (core or node) to a contact; `d` is in the 0–100 viewBox of the stage. */
export type RadarLink = { agentId: string; look: AgentLook; d: string };

/** A phase column of a workflow radar: divider and «ФАЗА 01» caption. */
export type RadarColumn = { label: string; start: number; overflow: number };

/** Everything a project card draws. */
export type RadarLayout = {
  /** Full-width card (workflow phases or more contacts than fit one column). */
  wide: boolean;
  core: { x: number; y: number };
  nodes: RadarNode[];
  links: RadarLink[];
  /** Phase columns for a workflow session; empty otherwise. */
  columns: RadarColumn[];
  /** Contacts not drawn for lack of room. */
  hidden: number;
  /** The workflow whose phases the strip shows. */
  phases: LiveWorkflowPhase[];
  workflowName: string | null;
};

const COLUMN_CAPACITY = 4;
const MAX_COLUMNS = 3;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Vertical places of `count` contacts in one column (mock-up: 2 → 26/74, 3 → 16/50/84). */
export function columnYs(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [50];
  if (count === 2) return [26, 74];
  const top = count >= 4 ? 13 : 16;
  const step = (100 - 2 * top) / (count - 1);
  return Array.from({ length: count }, (_, index) => round(top + step * index));
}

/** Live and waiting agents first, then errors, then the most recently finished. */
function rankAgent(agent: LiveAgentNode): number {
  if (agent.state === 'waiting') return 0;
  if (isActiveState(agent.state)) return 1;
  if (agent.state === 'error') return 2;
  return 3;
}

function byImportance(a: LiveAgentNode, b: LiveAgentNode): number {
  const rank = rankAgent(a) - rankAgent(b);
  if (rank !== 0) return rank;
  return (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt);
}

/** Orthogonal route of the wide radar: out of the core, along, then up/down into the contact. */
function elbowPath(fromX: number, fromY: number, toX: number, toY: number): string {
  if (Math.abs(toY - fromY) < 1) return `M${fromX} ${fromY} H${toX}`;
  const sign = toY < fromY ? -1 : 1;
  const turn = round(toX - 4);
  return `M${fromX} ${fromY} H${turn} Q${toX} ${fromY} ${toX} ${round(fromY + sign * 5)} V${toY}`;
}

/**
 * Places a session's agents around its orchestrator (DarkAgents radar): a
 * narrow card with one column for up to four contacts, a wide card with up to
 * three columns otherwise, and phase columns when a workflow runs.
 */
export function buildRadarLayout(session: LiveAgentsSession): RadarLayout {
  const workflow = session.workflows.find((info) => info.phases.length > 0) ?? null;
  const workflowNodeIds = new Set(session.workflows.map((info) => info.nodeId));
  // The workflow run itself is the phase strip, not a contact.
  const contacts = session.agents.filter(
    (agent) => agent.kind !== 'orchestrator' && agent.id !== 'main' && !(workflow && workflowNodeIds.has(agent.id)),
  );

  let columnsOfAgents: LiveAgentNode[][];
  let columns: RadarColumn[] = [];
  let xs: number[];
  let wide: boolean;
  let hidden = 0;

  if (workflow) {
    wide = true;
    const placed = new Set<string>();
    columnsOfAgents = workflow.phases.map((phase) => {
      const members = contacts.filter((agent) => phase.agentIds.includes(agent.id));
      members.forEach((agent) => placed.add(agent.id));
      return members;
    });
    const others = contacts.filter((agent) => !placed.has(agent.id));
    const labels = workflow.phases.map((phase) => `ФАЗА ${pad2(phase.index + 1)}`);
    if (others.length > 0) {
      columnsOfAgents.push(others);
      labels.push('АГЕНТЫ');
    }
    const span = 80 / columnsOfAgents.length;
    xs = columnsOfAgents.map((_, index) => round(18 + span * (index + 0.5)));
    columns = labels.map((label, index) => ({ label, start: round(18 + span * index), overflow: 0 }));
  } else {
    const ordered = [...contacts].sort(byImportance);
    wide = ordered.length > COLUMN_CAPACITY;
    const shown = ordered.slice(0, COLUMN_CAPACITY * MAX_COLUMNS);
    hidden = ordered.length - shown.length;
    // Keep a parent before its children so lines run left to right.
    const arranged: LiveAgentNode[] = [];
    const added = new Set<string>();
    const add = (agent: LiveAgentNode) => {
      if (added.has(agent.id)) return;
      added.add(agent.id);
      const parent = shown.find((candidate) => candidate.id === agent.parentId);
      if (parent) add(parent);
      arranged.push(agent);
    };
    shown.forEach(add);
    const columnCount = Math.max(1, Math.ceil(arranged.length / COLUMN_CAPACITY));
    columnsOfAgents = Array.from({ length: columnCount }, (_, index) => arranged.slice(index * COLUMN_CAPACITY, (index + 1) * COLUMN_CAPACITY));
    xs = !wide ? [70] : columnCount === 2 ? [45, 80] : [31, 57.5, 84];
  }

  const core = wide ? { x: 10, y: 50 } : { x: 20, y: 50 };
  const width = columnsOfAgents.length >= 5 ? 168 : wide ? 200 : 188;
  const nodes: RadarNode[] = [];
  columnsOfAgents.forEach((members, columnIndex) => {
    const sorted = workflow ? [...members].sort(byImportance) : members;
    const visible = sorted.slice(0, COLUMN_CAPACITY);
    const overflow = sorted.length - visible.length;
    if (overflow > 0) {
      hidden += overflow;
      if (columns[columnIndex]) columns[columnIndex].overflow = overflow;
    }
    // A lone contact of a phase column sits above or below the axis in turn, so lines do not run through cards.
    const ys = workflow && visible.length === 1 ? [columnIndex % 2 === 0 ? 26 : 74] : columnYs(visible.length);
    visible.forEach((agent, index) => {
      nodes.push({ agent, look: agentLook(agent.state), x: xs[columnIndex], y: ys[index], width });
    });
  });

  const nodeById = new Map(nodes.map((node) => [node.agent.id, node]));
  const fromCore = nodes.filter((node) => !nodeById.has(node.agent.parentId ?? ''));
  const links: RadarLink[] = nodes.map((node) => {
    const parent = nodeById.get(node.agent.parentId ?? '');
    if (parent && parent !== node) {
      return { agentId: node.agent.id, look: node.look, d: `M${parent.x} ${parent.y} L${node.x} ${node.y}` };
    }
    if (!wide) {
      return { agentId: node.agent.id, look: node.look, d: `M${core.x} ${core.y} L${node.x} ${node.y}` };
    }
    // Fan the lines out of the core a little so they do not sit on top of each other.
    const order = fromCore.indexOf(node);
    const spread = fromCore.length > 1 ? Math.min(2, 8 / fromCore.length) : 0;
    const startY = round(core.y + (order - (fromCore.length - 1) / 2) * spread);
    return { agentId: node.agent.id, look: node.look, d: elbowPath(core.x, startY, node.x, node.y) };
  });

  return {
    wide,
    core,
    nodes,
    links,
    columns: workflow ? columns : [],
    hidden,
    phases: workflow?.phases ?? [],
    workflowName: workflow?.name ?? null,
  };
}

// ------------------------------------------------------------ экран

/** A session counts as «в эфире» while a turn, a prompt or background work is going. */
export function isSessionActive(session: LiveAgentsSession): boolean {
  if (session.status === 'running' || session.status === 'waiting' || session.status === 'background' || session.status === 'external') {
    return true;
  }
  return session.agents.some((agent) => isActiveState(agent.state));
}

/** A waiting prompt with the agent and session it belongs to, oldest first. */
export type WaitingPrompt = {
  session: LiveAgentsSession;
  agent: LiveAgentNode;
  requestId: string;
  toolName: string;
  summary: string;
  command: string;
  receivedAt: string;
};

function commandOf(toolName: string, summary: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.command === 'string' && record.command.trim()) return record.command.trim();
    if (typeof record.file_path === 'string') return `${toolName} ${record.file_path}`;
    if (typeof record.url === 'string') return `${toolName} ${record.url}`;
  }
  return summary ? `${toolName} ${summary}` : toolName;
}

/** Every permission prompt across sessions, oldest first (the one blocking longest leads). */
export function collectWaitingPrompts(sessions: LiveAgentsSession[]): WaitingPrompt[] {
  const prompts: WaitingPrompt[] = [];
  for (const session of sessions) {
    for (const pending of session.pendingPermissions) {
      const agent = session.agents.find((candidate) => candidate.id === pending.agentId) ?? session.orchestrator;
      prompts.push({
        session,
        agent,
        requestId: pending.requestId,
        toolName: pending.toolName,
        summary: pending.summary,
        command: commandOf(pending.toolName, pending.summary, pending.input),
        receivedAt: pending.receivedAt,
      });
    }
  }
  return prompts.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/** Name of the agent's parent for «Сайт клиента · ночная сборка». */
export function parentName(session: LiveAgentsSession, agent: LiveAgentNode): string {
  if (agent.id === 'main' || agent.kind === 'orchestrator') return 'главный диалог';
  const parent = session.agents.find((candidate) => candidate.id === agent.parentId);
  if (!parent || parent.id === 'main') return 'главный диалог';
  return parent.name;
}

/** Header counters taken from the very sessions the radar draws, so the eyebrow, lead and board agree. */
export type AgentCounts = { working: number; waiting: number; errors: number; projects: number; agents: number };

/** One source for every «сколько работает» on the screen: the active sessions themselves. */
export function countAgents(sessions: LiveAgentsSession[]): AgentCounts {
  let working = 0;
  let waiting = 0;
  let errors = 0;
  let agents = 0;
  const projects = new Set<string>();
  for (const session of sessions) {
    projects.add(session.projectId ?? session.projectPath ?? session.projectName);
    for (const agent of session.agents) {
      agents += 1;
      if (agent.state === 'waiting') waiting += 1;
      else if (agent.state === 'error') errors += 1;
      else if (isActiveState(agent.state)) working += 1;
    }
  }
  return { working, waiting, errors, projects: projects.size, agents };
}

/** «Работает 1 агент», «Работают 2 агента», «Работают 5 агентов». */
export function workingPhrase(count: number): string {
  return `${ruPlural(count, 'Работает', 'Работают', 'Работают')} ${count} ${ruPlural(count, 'агент', 'агента', 'агентов')}`;
}

/** The «ЖИВАЯ СХЕМА · 3 ПРОЕКТА · 12 АГЕНТОВ» line. */
export function eyebrowText(projects: number, agents: number): string {
  return `ЖИВАЯ СХЕМА · ${projects} ${ruPlural(projects, 'ПРОЕКТ', 'ПРОЕКТА', 'ПРОЕКТОВ')} · ${agents} ${ruPlural(agents, 'АГЕНТ', 'АГЕНТА', 'АГЕНТОВ')}`;
}

/** The lead paragraph under «Агенты в эфире»: what needs the user, then how the rest goes. */
export function leadText(sessions: LiveAgentsSession[], prompts: WaitingPrompt[]): string {
  const all = sessions.flatMap((session) => session.agents.map((agent) => ({ session, agent })));
  const errors = all.filter(({ agent }) => agent.state === 'error');
  const working = all.filter(({ agent }) => isActiveState(agent.state) && agent.state !== 'waiting');
  const parts: string[] = [];
  if (prompts.length > 0) {
    const first = prompts[0];
    parts.push(`${first.session.projectName}: «${first.agent.name}» ждёт разрешения на ${first.toolName} — нужно твоё «да».`);
    if (prompts.length > 1) parts.push(`Ещё ${prompts.length - 1} ${ruPlural(prompts.length - 1, 'запрос', 'запроса', 'запросов')} в очереди.`);
  }
  if (working.length > 0) {
    parts.push(prompts.length > 0 ? 'Остальное идёт само.' : `${workingPhrase(working.length)} — всё идёт само, вмешиваться не нужно.`);
  }
  if (errors.length > 0) {
    const first = errors[0];
    parts.push(errors.length === 1
      ? `«${first.agent.name}» споткнулся и ждёт повтора.`
      : `${errors.length} ${ruPlural(errors.length, 'агент споткнулся', 'агента споткнулись', 'агентов споткнулись')} — их можно повторить.`);
  }
  if (parts.length === 0) return 'Сейчас никто не работает: ни ходов, ни фоновых агентов.';
  return parts.join(' ');
}

/** The agent picked by default: the one waiting for the user, else the first working contact, else an orchestrator. */
export function defaultSelection(sessions: LiveAgentsSession[]): { sessionId: string; agentId: string } | null {
  for (const session of sessions) {
    const waiting = session.agents.find((agent) => agent.state === 'waiting');
    if (waiting) return { sessionId: session.sessionId, agentId: waiting.id };
  }
  for (const session of sessions) {
    const working = session.agents.find((agent) => agent.id !== 'main' && isActiveState(agent.state));
    if (working) return { sessionId: session.sessionId, agentId: working.id };
  }
  const first = sessions[0];
  return first ? { sessionId: first.sessionId, agentId: first.orchestrator.id } : null;
}
