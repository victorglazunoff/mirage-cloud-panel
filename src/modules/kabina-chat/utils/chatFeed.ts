import type { ApiRetryInfo, ChatMessage } from '@/shared/types';
import { isLikelyFilePath } from '@/modules/chat';
import { toPanelWall } from '@/modules/kabina';
import { plural } from '@/modules/kabina-chat/utils/chatFormat';

/**
 * Turns the chat's message list into the DarkChat feed: user cards, Claude's
 * replies, one «ЖУРНАЛ» line per run of tool calls, artifact cards, the
 * «■ остановлено» mark and quiet system lines. Pure, so it is unit-tested.
 */

/** Colour of a step's result: done with changes, neutral, still running, failed. */
export type StepTone = 'ok' | 'mute' | 'run' | 'err';

/** One tool call inside a journal («#06 Edit data/villages.json +43 −43»). */
export type FeedStep = {
  key: string;
  /** Step number within its turn, 1-based. */
  n: number;
  tool: string;
  arg: string;
  res: string;
  tone: StepTone;
  message: ChatMessage;
};

/** An artifact published by an `Artifact` tool call, as the feed card needs it. */
export type FeedArtifact = { artifactId: string; title: string; url: string; version: string | null };

/** One line of Claude's plan (TodoWrite, or the newer TaskCreate / TaskUpdate list), as the CLI keeps it. */
export type TodoItem = { content: string; activeForm: string; status: 'pending' | 'in_progress' | 'completed'; id?: string };

export type FeedItem =
  | { kind: 'user'; key: string; message: ChatMessage; text: string; time: string; steeredAtStep: number | null }
  /** A subagent (Task / Agent call): its own nested card, with live progress drawn at render. */
  | { kind: 'agent'; key: string; message: ChatMessage; n: number; time: string }
  /** The turn's plan: where the turn first touched it, holding its latest state. */
  | { kind: 'todos'; key: string; items: TodoItem[]; updates: number; time: string }
  | { kind: 'assistant'; key: string; message: ChatMessage; text: string; time: string; isStreaming: boolean }
  | { kind: 'journal'; key: string; steps: FeedStep[]; summary: string; total: string; totalTone: StepTone; time: string }
  | { kind: 'artifact'; key: string; artifact: FeedArtifact; time: string }
  | { kind: 'stopped'; key: string; time: string; at: Date | null; stop: TurnStopSummary }
  | { kind: 'apiError'; key: string; time: string; at: number; error: ApiErrorKind; savedStep: number; retry: ApiRetryInfo | null; details: string }
  | { kind: 'note'; key: string; text: string; tone: 'err' | 'mute' | 'run'; detail: string | null };

/** What a hold-to-stop kept and cut (DarkStates C2): the step it stopped at, files edited before it, the step it cut. */
export type TurnStopSummary = { step: number; editedFiles: number; interrupted: string | null };

/** An API failure for DarkStates E1: the HTTP status (529, 429, 500…) or a dropped stream. */
export type ApiErrorKind = number | 'stream';

/**
 * Reads an API failure out of a message Claude Code left in the transcript or the
 * stream: «API Error: 529 {…overloaded…}», «Request timed out», a dropped
 * connection. Anything else (a tool error, a missing CLI) is not an API error.
 */
export function readApiError(text: string): ApiErrorKind | null {
  const status = /API Error:?\s*(\d{3})\b/i.exec(text);
  if (status) return Number(status[1]);
  if (/API Error|Request timed out|Connection error|ECONNRESET|socket hang up|stream (?:ended|closed|terminated)|terminated/i.test(text)) {
    return 'stream';
  }
  return null;
}

/** «14:09» in the panel's time zone (panelTime); empty when the timestamp is unusable. */
export function formatClock(value: ChatMessage['timestamp'] | undefined): string {
  if (value === undefined || value === null) return '';
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const date = toPanelWall(instant);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

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

function readString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Workspace-relative tail of a path: the last three segments are enough to recognise a file. */
function shortPath(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join('/') : parts.join('/') || filePath;
}

function firstLine(text: string, limit = 90): string {
  const line = text.split('\n').find((part) => part.trim()) ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Plain text of a tool result, whatever shape the provider gave it. */
export function resultText(message: ChatMessage): string {
  const content = message.toolResult?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('\n');
  }
  return '';
}

/** What the step acted on: a file, a command, a search, an agent's task. */
export function describeStepArgument(message: ChatMessage): string {
  const input = asRecord(message.toolInput);
  const tool = message.toolName ?? '';
  if (tool === 'Bash') return firstLine(readString(input, 'command', 'description'));
  if (tool === 'Grep' || tool === 'Glob') {
    const pattern = readString(input, 'pattern', 'query');
    const where = readString(input, 'path', 'glob');
    return where ? `«${pattern}» в ${shortPath(where)}` : `«${pattern}»`;
  }
  if (tool === 'Task' || tool === 'Agent' || message.isSubagentContainer) {
    return `субагент · ${readString(input, 'description', 'prompt') || 'задача'}`;
  }
  if (tool === 'WebSearch') return readString(input, 'query');
  if (tool === 'WebFetch') return readString(input, 'url');
  if (tool === 'Artifact') return readString(input, 'title', 'file_path', 'url') || 'артефакт';
  if (tool === 'TodoWrite') return 'список задач';
  if (tool === 'TaskCreate') return readString(input, 'subject');
  const filePath = readString(input, 'file_path', 'path', 'notebook_path');
  if (filePath) return shortPath(filePath);
  const anyText = Object.values(input).find((value) => typeof value === 'string' && value.trim());
  return typeof anyText === 'string' ? firstLine(anyText) : '';
}

/** Tools whose input names one file: their journal step links to it. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'NotebookRead']);

/** The file a step read or wrote, in full, or null for steps that act on no single file. */
export function stepFilePath(message: ChatMessage): string | null {
  if (!FILE_TOOLS.has(message.toolName ?? '')) return null;
  const filePath = readString(asRecord(message.toolInput), 'file_path', 'notebook_path', 'path').trim();
  return filePath && isLikelyFilePath(filePath) ? filePath : null;
}

function countLines(text: string): number {
  return text ? text.split('\n').length : 0;
}

function lineDiff(input: Record<string, unknown>): { added: number; removed: number } | null {
  if (Array.isArray(input.edits)) {
    return (input.edits as Array<Record<string, unknown>>).reduce<{ added: number; removed: number }>((sum, edit) => ({
      added: sum.added + countLines(readString(edit, 'new_string')),
      removed: sum.removed + countLines(readString(edit, 'old_string')),
    }), { added: 0, removed: 0 });
  }
  if (typeof input.new_string === 'string' || typeof input.old_string === 'string') {
    return {
      added: countLines(typeof input.new_string === 'string' ? input.new_string : ''),
      removed: countLines(typeof input.old_string === 'string' ? input.old_string : ''),
    };
  }
  return null;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The result column of a step and its colour. `now` drives «идёт m:ss» for running agents. */
export function describeStepResult(message: ChatMessage, now: number): { res: string; tone: StepTone } {
  const tool = message.toolName ?? '';
  const result = message.toolResult;
  const isAgent = message.isSubagentContainer || tool === 'Task' || tool === 'Agent' || tool === 'Workflow';
  if (!result) {
    if (isAgent || message.taskStatus) {
      const started = new Date(message.timestamp as string | number | Date).getTime();
      return { res: Number.isNaN(started) ? 'идёт' : `идёт ${formatElapsed(now - started)}`, tone: 'run' };
    }
    return { res: 'идёт…', tone: 'run' };
  }
  if (result.isError) return { res: 'ошибка', tone: 'err' };
  const input = asRecord(message.toolInput);
  const text = resultText(message);
  if (tool === 'Edit' || tool === 'MultiEdit') {
    const diff = lineDiff(input);
    return diff ? { res: `+${diff.added} −${diff.removed}`, tone: 'ok' } : { res: 'правка', tone: 'ok' };
  }
  if (tool === 'Write') return { res: `+${countLines(readString(input, 'content'))}`, tone: 'ok' };
  if (tool === 'Read') {
    const lines = countLines(text.trimEnd());
    return { res: lines ? `${lines} стр.` : 'прочитан', tone: 'mute' };
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const hits = text.trim() ? text.trim().split('\n').length : 0;
    return { res: hits ? `${hits} совп.` : 'нет совп.', tone: 'mute' };
  }
  if (isAgent) return { res: 'готово', tone: 'ok' };
  if (tool === 'Bash' && isBackgroundLaunch(message)) {
    const status = message.taskStatus?.status;
    if (status === 'running') {
      const started = new Date(message.timestamp as string | number | Date).getTime();
      return { res: Number.isNaN(started) ? 'в фоне' : `в фоне ${formatElapsed(now - started)}`, tone: 'run' };
    }
    if (status === 'failed') return { res: 'фон: ошибка', tone: 'err' };
    if (status === 'stopped') return { res: 'фон: остановлен', tone: 'mute' };
    if (status === 'completed' || /^Background command .*completed/i.test(text)) return { res: 'фон: готово', tone: 'ok' };
    return { res: 'в фоне', tone: 'mute' };
  }
  if (tool === 'Bash') return { res: 'ok', tone: 'ok' };
  return { res: 'ok', tone: 'mute' };
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** A Bash call sent to the background (`run_in_background`): its result only says it started. */
export function isBackgroundLaunch(message: ChatMessage): boolean {
  if (message.toolName !== 'Bash') return false;
  return asRecord(message.toolInput).run_in_background === true;
}

/** A row that spawned a subagent (Task / Agent call): drawn as its own card, not a journal step. */
export function isAgentRow(message: ChatMessage): boolean {
  return Boolean(message.isSubagentContainer || message.toolName === 'Task' || message.toolName === 'Agent');
}

/** The plan tools: TodoWrite rewrites the list, TaskCreate / TaskUpdate / TaskList keep it item by item. */
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

function planStatus(value: unknown): TodoItem['status'] | null {
  return value === 'completed' || value === 'in_progress' || value === 'pending' ? value : null;
}

/**
 * Applies one plan call to the session's plan (the list lives across turns: a TaskUpdate of
 * this turn may name a task created in an earlier one). Returns the new list, or null when
 * the call says nothing about the plan.
 */
export function applyPlanCall(plan: TodoItem[], message: ChatMessage): TodoItem[] | null {
  const tool = message.toolName ?? '';
  const input = asRecord(message.toolInput);
  const outcome = asRecord(message.toolResult?.toolUseResult);
  if (tool === 'TodoWrite') return readTodos(message.toolInput);
  if (tool === 'TaskCreate') {
    const content = readString(input, 'subject', 'description');
    if (!content) return null;
    // The id the CLI gave it (result «Task #3 created…»), else the next number — ids count from 1.
    const created = readString(asRecord(outcome.task), 'id') || /#(\d+)/.exec(resultText(message))?.[1] || String(plan.length + 1);
    return [...plan.filter((item) => item.id !== created), { id: created, content, activeForm: readString(input, 'activeForm') || content, status: 'pending' }];
  }
  if (tool === 'TaskUpdate') {
    const id = readString(input, 'taskId');
    if (!id) return null;
    if (input.status === 'deleted') return plan.filter((item) => item.id !== id);
    return plan.map((item) => (item.id !== id ? item : {
      ...item,
      content: readString(input, 'subject') || item.content,
      activeForm: readString(input, 'activeForm') || item.activeForm,
      status: planStatus(input.status) ?? item.status,
    }));
  }
  if (tool === 'TaskList' && Array.isArray(outcome.tasks)) {
    return (outcome.tasks as unknown[]).flatMap((entry): TodoItem[] => {
      const record = asRecord(entry);
      const content = readString(record, 'subject');
      if (!content) return [];
      const id = readString(record, 'id');
      const known = plan.find((item) => item.id === id);
      return [{ id, content, activeForm: known?.activeForm ?? content, status: planStatus(record.status) ?? 'pending' }];
    });
  }
  return null;
}

/** The plan a TodoWrite call wrote, or null when its input is not a plan. */
export function readTodos(toolInput: unknown): TodoItem[] | null {
  const todos = asRecord(toolInput).todos;
  if (!Array.isArray(todos)) return null;
  const items = todos.flatMap((entry): TodoItem[] => {
    const record = asRecord(entry);
    const content = readString(record, 'content', 'subject', 'title');
    if (!content) return [];
    const status = record.status === 'completed' || record.status === 'in_progress' ? record.status : 'pending';
    return [{ content, activeForm: readString(record, 'activeForm') || content, status }];
  });
  return items;
}


/** «Read prices-oct.csv · Grep «Берёзовая» · 3 правки» — the collapsed journal line. */
export function summarizeSteps(steps: FeedStep[]): string {
  const edits = steps.filter((step) => EDIT_TOOLS.has(step.tool)).length;
  const agents = steps.filter((step) => step.message.isSubagentContainer || step.tool === 'Task' || step.tool === 'Agent').length;
  const named = steps
    .filter((step) => !EDIT_TOOLS.has(step.tool) && !(step.message.isSubagentContainer || step.tool === 'Task' || step.tool === 'Agent'))
    .slice(0, 2)
    .map((step) => {
      // A search names its pattern («Grep «Берёзовая»»), everything else its file or command.
      const name = step.tool === 'Grep' || step.tool === 'Glob'
        ? step.arg.split(' в ')[0]
        : step.tool === 'Bash' ? step.arg : (step.arg.split('/').pop() ?? step.arg);
      return name ? `${step.tool} ${name.length > 32 ? `${name.slice(0, 31)}…` : name}` : step.tool;
    });
  const parts = [...named];
  if (edits) parts.push(`${edits} ${plural(edits, 'правка', 'правки', 'правок')}`);
  if (agents) parts.push(`${agents} ${plural(agents, 'субагент', 'субагента', 'субагентов')}`);
  return parts.join(' · ') || steps.map((step) => step.tool).slice(0, 3).join(' · ');
}

function journalTotal(steps: FeedStep[]): { total: string; totalTone: StepTone } {
  if (steps.some((step) => step.tone === 'run')) return { total: 'идёт', totalTone: 'run' };
  const errors = steps.filter((step) => step.tone === 'err').length;
  if (errors) return { total: `${errors} ${plural(errors, 'ошибка', 'ошибки', 'ошибок')}`, totalTone: 'err' };
  return { total: `${steps.length} ${plural(steps.length, 'шаг', 'шага', 'шагов')}`, totalTone: 'mute' };
}

function isToolRow(message: ChatMessage): boolean {
  return Boolean(message.isToolUse && (message.toolName || message.isSubagentContainer));
}

function readArtifact(message: ChatMessage): FeedArtifact | null {
  const artifact = message.artifact as Record<string, unknown> | undefined;
  if (!artifact || typeof artifact.artifactId !== 'string') return null;
  return {
    artifactId: artifact.artifactId,
    title: typeof artifact.title === 'string' && artifact.title ? artifact.title : 'Артефакт',
    url: typeof artifact.url === 'string' ? artifact.url : '',
    version: typeof artifact.version === 'string' ? artifact.version : null,
  };
}

function messageKey(message: ChatMessage, index: number): string {
  return String(message.toolId ?? message.transcriptAnchorId ?? message.id ?? `${message.type}-${index}`);
}

/**
 * Feed items plus the step count of the last turn (for «ход · шаг») and the last turn's plan
 * (TodoWrite) for the turn line; null when the last turn wrote none.
 */
export type ChatFeed = { items: FeedItem[]; lastTurnSteps: number; turnTodos: TodoItem[] | null };

export function buildChatFeed(messages: ChatMessage[], now: number = Date.now()): ChatFeed {
  const items: FeedItem[] = [];
  let run: FeedStep[] = [];
  let stepInTurn = 0;
  // Every step of the current turn (journals split at Claude's replies), for the stop summary.
  let turnSteps: FeedStep[] = [];
  // The current turn's plan card: the first plan call places it, later ones update it.
  let turnTodos: Extract<FeedItem, { kind: 'todos' }> | null = null;
  // The session's plan so far (TaskCreate / TaskUpdate carry it across turns).
  let plan: TodoItem[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const { total, totalTone } = journalTotal(run);
    items.push({
      kind: 'journal',
      key: `journal-${run[0].key}`,
      steps: run,
      summary: summarizeSteps(run),
      total,
      totalTone,
      time: formatClock(run[0].message.timestamp),
    });
    run = [];
  };

  messages.forEach((message, index) => {
    const key = messageKey(message, index);
    if (message.isThinking) return;

    if (isToolRow(message) && PLAN_TOOLS.has(message.toolName ?? '')) {
      stepInTurn += 1;
      const next = applyPlanCall(plan, message);
      // A read of the plan (TaskGet) or a failed call changes nothing on screen.
      if (!next || message.toolResult?.isError) return;
      plan = next;
      if (turnTodos) {
        turnTodos.items = plan;
        turnTodos.updates += 1;
      } else if (plan.length > 0) {
        flush();
        turnTodos = { kind: 'todos', key: `todos-${key}`, items: plan, updates: 1, time: formatClock(message.timestamp) };
        items.push(turnTodos);
      }
      return;
    }

    if (isToolRow(message) && isAgentRow(message)) {
      stepInTurn += 1;
      const { res, tone } = describeStepResult(message, now);
      turnSteps.push({ key, n: stepInTurn, tool: message.toolName || 'Task', arg: describeStepArgument(message), res, tone, message });
      flush();
      items.push({ kind: 'agent', key: `agent-${key}`, message, n: stepInTurn, time: formatClock(message.timestamp) });
      return;
    }

    if (isToolRow(message)) {
      stepInTurn += 1;
      const { res, tone } = describeStepResult(message, now);
      const step: FeedStep = {
        key,
        n: stepInTurn,
        tool: message.isSubagentContainer && !message.toolName ? 'Task' : String(message.toolName),
        arg: describeStepArgument(message),
        res,
        tone,
        message,
      };
      run.push(step);
      turnSteps.push(step);
      const artifact = message.toolName === 'Artifact' ? readArtifact(message) : null;
      if (artifact) {
        flush();
        items.push({ kind: 'artifact', key: `artifact-${key}`, artifact, time: formatClock(message.timestamp) });
      }
      return;
    }

    flush();

    if (message.apiRetry) {
      const at = new Date(message.timestamp as string | number | Date).getTime();
      items.push({
        kind: 'apiError',
        key,
        time: formatClock(message.timestamp),
        at: Number.isNaN(at) ? now : at,
        error: message.apiRetry.errorStatus ?? 'stream',
        savedStep: stepInTurn,
        retry: message.apiRetry,
        details: retryDetails(message.apiRetry),
      });
      return;
    }

    if (message.isTurnStopped) {
      const at = new Date(message.timestamp as string | number | Date);
      items.push({
        kind: 'stopped',
        key,
        time: formatClock(message.timestamp),
        at: Number.isNaN(at.getTime()) ? null : at,
        stop: summarizeStop(turnSteps, stepInTurn),
      });
      return;
    }

    if (message.type === 'user') {
      const steered = Boolean(message.steered);
      if (!steered) {
        stepInTurn = 0;
        turnSteps = [];
        turnTodos = null;
      }
      items.push({
        kind: 'user',
        key,
        message,
        text: String(message.displayText ?? message.content ?? ''),
        time: formatClock(message.timestamp),
        steeredAtStep: steered ? stepInTurn : null,
      });
      return;
    }

    if (message.compact) {
      const phase = message.compact.phase;
      items.push({
        kind: 'note',
        key,
        text: String(message.content || (phase === 'running' ? 'Сжимаю контекст…' : 'Контекст сжат')),
        tone: phase === 'failed' ? 'err' : phase === 'running' ? 'run' : 'mute',
        detail: message.compactSummary ?? null,
      });
      return;
    }

    if (message.isTaskNotification) {
      items.push({
        kind: 'note',
        key,
        text: String(message.content ?? ''),
        tone: message.taskNotificationStatus === 'completed' ? 'mute' : 'run',
        detail: null,
      });
      return;
    }

    const text = String(message.content ?? '');
    // «API Error: 529 …» — an error row live, an assistant row from the transcript.
    const apiError = message.type === 'error' || (message.type === 'assistant' && /^\s*API Error/i.test(text))
      ? readApiError(text)
      : null;
    if (apiError !== null) {
      const at = new Date(message.timestamp as string | number | Date).getTime();
      items.push({
        kind: 'apiError', key, time: formatClock(message.timestamp), at: Number.isNaN(at) ? now : at,
        error: apiError, savedStep: stepInTurn, retry: null, details: text.trim(),
      });
      return;
    }

    if (message.type === 'error') {
      items.push({ kind: 'note', key, text: String(message.content ?? 'Ошибка'), tone: 'err', detail: null });
      return;
    }

    if (message.type === 'assistant' && text.trim()) {
      items.push({
        kind: 'assistant',
        key,
        message,
        text,
        time: formatClock(message.timestamp),
        isStreaming: Boolean(message.isStreaming),
      });
    }
  });

  flush();
  // Assigned inside the loop's callback, which the compiler does not follow.
  const lastTodos = turnTodos as Extract<FeedItem, { kind: 'todos' }> | null;
  return { items: settleApiErrors(items), lastTurnSteps: stepInTurn, turnTodos: lastTodos?.items ?? null };
}

/**
 * DarkStates E1 «уходит после успеха»: a retry notice stays only while it is the
 * last thing in the feed (the reply has not resumed yet); a failure that the
 * dialog has moved past shrinks to one quiet line.
 */
function settleApiErrors(items: FeedItem[]): FeedItem[] {
  const lastIndex = items.length - 1;
  return items.flatMap((item, index): FeedItem[] => {
    if (item.kind !== 'apiError' || index === lastIndex) return [item];
    if (item.retry) return [];
    return [{ kind: 'note', key: item.key, text: `Claude не ответил · ${apiErrorChip(item.error)}`, tone: 'err', detail: item.details || null }];
  });
}

/** «API 529 · перегружен» — the short name of a failure for the quiet line. */
export function apiErrorChip(error: ApiErrorKind): string {
  if (error === 'stream') return 'поток оборвался';
  if (error === 529) return 'API 529 · перегружен';
  if (error === 429) return 'API 429 · лимит запросов';
  if (error >= 500) return `API ${error} · сбой сервера`;
  return `API ${error}`;
}

function retryDetails(retry: ApiRetryInfo): string {
  const status = retry.errorStatus === null ? 'нет ответа' : String(retry.errorStatus);
  return [
    `попытка ${retry.attempt} из ${retry.maxRetries || '?'}  →  ${status}${retry.error ? ` ${retry.error}` : ''}`,
    `пауза перед повтором  ${Math.round(retry.retryDelayMs / 100) / 10} с`,
  ].join('\n');
}

/** Files edited before the stop and the step the stop cut short. */
function summarizeStop(steps: FeedStep[], stepInTurn: number): TurnStopSummary {
  const edited = new Set<string>();
  let interrupted: string | null = null;
  for (const step of steps) {
    if (EDIT_TOOLS.has(step.tool) && step.tone !== 'err' && step.tone !== 'run') {
      const input = asRecord(step.message.toolInput);
      edited.add(readString(input, 'file_path', 'path', 'notebook_path') || step.arg);
    }
    if (step.tone === 'run' || (step.message.toolResult?.isError && /interrupt/i.test(resultText(step.message)))) {
      interrupted = step.arg ? `${step.tool} ${step.arg}` : step.tool;
    }
  }
  return { step: stepInTurn, editedFiles: edited.size, interrupted };
}
