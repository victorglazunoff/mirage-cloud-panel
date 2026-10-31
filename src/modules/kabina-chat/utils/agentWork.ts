import type { BackgroundTaskSummary, ChatMessage, LiveAgentNode } from '@/shared/types';
import { describeStepArgument, describeStepResult, resultText } from '@/modules/kabina-chat/utils/chatFeed';
import type { FeedItem, StepTone, TodoItem } from '@/modules/kabina-chat/utils/chatFeed';
import { formatTokens } from '@/modules/kabina-chat/utils/chatFormat';

/**
 * The «как в Claude Code» view of a turn's work: a subagent's card («● Task(описание) ⎿ N
 * вызовов · токены · время»), the turn line's «✻ что делает сейчас» and the background
 * work. Pure: the transcript row and, while it runs, the live agent tree (`/api/agents/live`)
 * go in, plain view data comes out — unit-tested without a socket.
 */

/** Where a subagent stands: working, finished, failed, or cut short (stopped / interrupted). */
export type AgentState = 'run' | 'done' | 'err' | 'stopped';

/** One tool call of a subagent, as its card lists them. */
export type AgentStep = { key: string; tool: string; arg: string; res: string; tone: StepTone };

/** Everything a subagent card shows. Numbers are null when nothing reported them yet. */
export type AgentView = {
  name: string;
  /** `subagent_type` («general-purpose», «Explore»), when it is not the default. */
  agentType: string | null;
  /** «haiku», «sonnet», «opus», «fable» — or the raw model id when no family is known. */
  model: string | null;
  state: AgentState;
  /** Launched with `run_in_background`: the turn does not wait for it. */
  background: boolean;
  toolCalls: number | null;
  tokens: number | null;
  durationMs: number | null;
  /** While it works: the call it is on («Bash ls -la»). */
  current: string | null;
  /** When it ended: the first line of its report (or of the error). */
  summary: string | null;
  steps: AgentStep[];
};

/** A live node of the session's agent tree and when its numbers were taken (local clock). */
export type LiveAgentSample = { node: LiveAgentNode; receivedAt: number };

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstLine(text: string, limit = 160): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** «claude-haiku-5-5» → «haiku»; anything without a known family stays as it is. */
export function modelWord(model: string | null | undefined): string | null {
  if (!model) return null;
  const family = /(opus|sonnet|haiku|fable)/i.exec(model);
  return family ? family[1].toLowerCase() : model;
}

/** 42 000 ms → «42 с», 192 000 → «3:12», past an hour «1:03:12» — the card's time. */
export function formatWorkTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} с`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** «6 вызовов · 12.4k ток. · 42 с» — whatever of the three is known. */
export function agentMetaLine(view: Pick<AgentView, 'toolCalls' | 'tokens' | 'durationMs'>): string {
  const parts: string[] = [];
  if (view.toolCalls !== null) parts.push(`${view.toolCalls} ${callsWord(view.toolCalls)}`);
  if (view.tokens) parts.push(`${formatTokens(view.tokens)} ток.`);
  if (view.durationMs !== null) parts.push(formatWorkTime(view.durationMs));
  return parts.join(' · ');
}

function callsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'вызов';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'вызова';
  return 'вызовов';
}

function stateFromLive(node: LiveAgentNode): AgentState {
  if (node.state === 'done') return 'done';
  if (node.state === 'error') return 'err';
  if (node.state === 'stopped') return 'stopped';
  return 'run';
}

function stateFromStatus(status: string | undefined): AgentState | null {
  if (status === 'running') return 'run';
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'err';
  if (status === 'stopped') return 'stopped';
  return null;
}

/** The report text of a finished Agent call (the CLI's `toolUseResult`), first line. */
function reportOf(message: ChatMessage, outcome: Record<string, unknown>): string | null {
  const handback = readText(asRecord(outcome.handbackReport).text);
  if (handback) return firstLine(handback);
  if (Array.isArray(outcome.content)) {
    const text = (outcome.content as unknown[]).map((part) => readText(asRecord(part).text)).find(Boolean);
    if (text) return firstLine(text);
  }
  const plain = resultText(message);
  // «Async agent launched…» and «report delivered as a message» say nothing about the work.
  if (!plain || /^\s*(Async agent launched|.*report was delivered to you)/i.test(plain)) return null;
  return firstLine(plain);
}

/**
 * The card of one subagent call. History (after a reload) reads the transcript: the
 * timeline the server attached, the CLI's totals in `toolUseResult`. While it runs, the
 * live tree's node (matched by the call's id) gives the current action, calls, tokens and
 * time, ticking on from when the frame came.
 */
export function describeAgent(message: ChatMessage, now: number, live: LiveAgentSample | null = null): AgentView {
  const input = asRecord(message.toolInput);
  const outcome = asRecord(message.toolResult?.toolUseResult);
  const usage = message.taskStatus?.usage;
  const subagent = message.subagent;
  const node = live?.node ?? null;

  const steps: AgentStep[] = (message.subagentActivity ?? [])
    .filter((entry) => entry.kind === 'tool' && entry.toolName)
    .map((entry, index) => {
      const asMessage = {
        type: 'assistant',
        timestamp: entry.timestamp ?? message.timestamp,
        isToolUse: true,
        toolName: entry.toolName,
        toolInput: entry.toolInput,
        toolResult: entry.toolResult ?? null,
      } as ChatMessage;
      const { res, tone } = describeStepResult(asMessage, now);
      return { key: entry.toolId ?? `${index}`, tool: entry.toolName ?? 'Tool', arg: describeStepArgument(asMessage), res, tone };
    });

  const background = input.run_in_background === true || Boolean(node?.backgrounded);
  const resultError = Boolean(message.toolResult?.isError);
  const interrupted = resultError && /interrupt/i.test(resultText(message));

  let state: AgentState;
  if (node) state = stateFromLive(node);
  else {
    const reported = stateFromStatus(subagent?.status) ?? stateFromStatus(message.taskStatus?.status)
      ?? stateFromStatus(typeof outcome.status === 'string' ? outcome.status : undefined);
    if (interrupted) state = 'stopped';
    else if (resultError) state = 'err';
    else if (reported) state = reported;
    else if (message.toolResult && !background) state = 'done';
    else state = 'run';
  }

  const started = new Date(message.timestamp as string | number | Date).getTime();
  let durationMs: number | null = readNumber(outcome.totalDurationMs) ?? usage?.durationMs ?? null;
  if (node && (state === 'run' || durationMs === null)) {
    durationMs = node.durationMs + (state === 'run' && live ? Math.max(0, now - live.receivedAt) : 0);
  } else if (state === 'run' && durationMs === null && !Number.isNaN(started)) {
    durationMs = Math.max(0, now - started);
  }

  const toolCalls = node?.toolCalls || readNumber(outcome.totalToolUseCount) || usage?.toolUses
    || subagent?.activityCount || (steps.length || null);
  const tokens = node?.tokens || readNumber(outcome.totalTokens) || usage?.totalTokens || null;

  const lastStep = steps[steps.length - 1];
  const current = state === 'run'
    ? (node?.currentAction || (lastStep ? `${lastStep.tool} ${lastStep.arg}`.trim() : null) || 'запускается…')
    : null;
  let summary: string | null = null;
  if (state !== 'run') {
    summary = reportOf(message, outcome) ?? (node?.summary ? firstLine(node.summary) : null)
      ?? (message.taskStatus?.summary ? firstLine(message.taskStatus.summary) : null)
      ?? (node?.error ? firstLine(node.error) : null);
    if (interrupted) summary = 'прерван до ответа';
  }

  const agentType = readText(input.subagent_type) || subagent?.type || null;
  return {
    name: readText(input.description) || subagent?.description || node?.name || 'субагент',
    agentType: agentType && agentType !== 'general-purpose' ? agentType : null,
    model: modelWord(node?.model ?? (typeof outcome.resolvedModel === 'string' ? outcome.resolvedModel : null)
      ?? subagent?.model ?? readText(input.model)),
    state,
    background,
    toolCalls: toolCalls || null,
    tokens,
    durationMs,
    current,
    summary,
    steps,
  };
}

/** How far the plan has got: «1/3» and the line being worked on now. */
export function todoProgress(items: TodoItem[]): { done: number; total: number; current: TodoItem | null } {
  return {
    done: items.filter((item) => item.status === 'completed').length,
    total: items.length,
    current: items.find((item) => item.status === 'in_progress') ?? null,
  };
}

/** One background job of the session, as the turn line's «фон» list shows it. */
export type BackgroundWork = { key: string; label: string; elapsedMs: number };

/** The session's own background jobs (commands, agents, workflows) — nested ones are an agent's business. */
export function backgroundWork(tasks: BackgroundTaskSummary[] | undefined, now: number): BackgroundWork[] {
  return (tasks ?? [])
    .filter((task) => !task.nested)
    .map((task) => {
      const what = task.workflowName || task.description || 'задача';
      const label = task.taskType === 'local_bash' ? `Bash ${what}`
        : task.taskType === 'local_workflow' ? `воркфлоу «${what}»` : `агент «${what}»`;
      return { key: task.taskId, label, elapsedMs: Math.max(0, now - task.startedAt) };
    });
}

/**
 * «✻ …» of the turn line — what the turn is doing right now, newest first: a decision it
 * waits on, a reply being written, a running call of the last journal, a working subagent,
 * the live tree's word for the main thread, else «думает».
 */
export function describeTurnActivity(items: FeedItem[], options: { waits: boolean; mainAction: string | null; now: number; live: (toolId: string) => LiveAgentSample | null }): string {
  if (options.waits) return 'ждёт твоего решения';
  const last = items[items.length - 1];
  if (last?.kind === 'assistant' && last.isStreaming) return 'пишет ответ';
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'user' && item.steeredAtStep === null) break;
    if (item.kind === 'journal') {
      const running = [...item.steps].reverse().find((step) => step.tone === 'run' && !step.res.startsWith('в фоне'));
      if (running) return `${running.tool} ${running.arg}`.trim();
    }
    if (item.kind === 'agent') {
      const view = describeAgent(item.message, options.now, options.live(String(item.message.toolId ?? '')));
      if (view.state === 'run' && !view.background) return `агент «${view.name}» · ${view.current ?? 'работает'}`;
    }
  }
  return options.mainAction || 'думает';
}
