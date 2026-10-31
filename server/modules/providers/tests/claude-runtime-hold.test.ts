import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  BYPASS_UNDER_ROOT_MESSAGE,
  claudeRuntime,
  isBypassRefusedForRoot,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  /** Every message the runtime wrote into the CLI's stdin, in order. */
  prompts: Array<Record<string, unknown>>;
  /** Control requests the runtime sent the live process (setModel and friends). */
  controls: Array<[string, unknown]>;
  /** The argument of every interrupt() call. */
  interrupts: unknown[];
  /** What interrupt() resolves to — undefined, like a CLI without receipts. */
  receipt: unknown;
  /** Mirage: what interrupt() rejects with instead (e.g. the SDK's «Query closed»). */
  interruptError: Error | null;
  /** Control methods (setModel, setPermissionMode, applyFlagSettings) that reject. */
  failingControls: Set<string>;
  /** How long a control request takes to answer. */
  controlDelayMs: number;
  closed: () => boolean;
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const stopped: string[] = [];
  const prompts: Array<Record<string, unknown>> = [];
  const controls: Array<[string, unknown]> = [];
  let closed = false;

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stopped,
    prompts,
    controls,
    interrupts: [],
    receipt: undefined,
    interruptError: null,
    failingControls: new Set(),
    controlDelayMs: 0,
    closed: () => closed,
  };

  const control = (name: string) => async (value: unknown) => {
    if (script.controlDelayMs > 0) {
      await new Promise((resolve) => { setTimeout(resolve, script.controlDelayMs); });
    }
    if (script.failingControls.has(name)) {
      throw new Error(`${name} refused`);
    }
    controls.push([name, value]);
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const message of prompt) { prompts.push(message as Record<string, unknown>); }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      // The real interrupt resolves to the CLI's receipt; the context type predates it.
      interrupt: async (options?: unknown): Promise<void> => {
        script.interrupts.push(options ?? null);
        if (script.interruptError) throw script.interruptError;
        return script.receipt as never;
      },
      close: () => { closed = true; queue.push(null); wake?.(); },
      stopTask: async (taskId: string) => { stopped.push(taskId); },
      setModel: control('setModel'),
      setPermissionMode: control('setPermissionMode'),
      applyFlagSettings: control('applyFlagSettings'),
    });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: { script: Scripted; sent: NormalizedMessage[]; done: Promise<unknown>; cwd: string }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    await runTest({ script, sent, done, cwd });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

// A fixed settle can be too short on a loaded machine; the supersede tests
// wait for the run to have actually processed its turn instead.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);

    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a new turn goes into the held process and leaves its background tasks running', async () => {
  // Mirage Х5: the first run is held for a background agent; the user's next
  // message must not replace that process (which would stop the agent) but be
  // written into it as the next turn.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  let secondQueries = 0;
  const firstSent: NormalizedMessage[] = [];
  const secondSent: NormalizedMessage[] = [];
  const firstWriter = { send: (message: NormalizedMessage) => { firstSent.push(message); }, userId: null };
  const secondWriter = { send: (message: NormalizedMessage) => { secondSent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const countingSecond: NonNullable<ProviderRuntimeContext['createQuery']> = (options) => {
    secondQueries += 1;
    return second.createQuery(options);
  };

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, firstWriter as never, { ...context, createQuery: first.createQuery });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => firstSent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');
    assert.equal(claudeRuntime.acceptsLiveInput(SESSION_ID), true, 'and can take the next turn');

    let secondDone = false;
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, model: 'opus' }, secondWriter as never, { ...context, createQuery: countingSecond })
      .then(() => { secondDone = true; });
    await waitFor(() => first.script.prompts.length === 2);
    assert.equal(secondQueries, 0, 'no new process is started');
    assert.deepEqual(first.script.stopped, [], 'the agent is not stopped');
    assert.equal(first.script.released(), false, 'and the process is not let go');
    assert.equal(first.script.prompts[1].priority, 'next');
    assert.deepEqual((first.script.prompts[1].message as Record<string, unknown>).content, 'Continue');
    assert.deepEqual(first.script.controls.find(([name]) => name === 'setModel'), ['setModel', 'opus'], 'a changed model is applied live');
    assert.equal(claudeRuntime.acceptsLiveInput(SESSION_ID), false, 'a turn is open again');

    // The CLI runs the turn; its events and its end belong to the new run.
    first.script.emit(init());
    first.script.emit({ type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'continued' }] } });
    first.script.emit(result());
    await waitFor(() => secondDone);
    assert.equal(secondSent.filter((message) => message.kind === 'complete').length, 1, 'the new turn reports complete once');
    assert.ok(secondSent.some((message) => message.kind === 'text' && message.content === 'continued'));
    assert.equal(firstSent.filter((message) => message.kind === 'complete').length, 1, 'the first run is not completed twice');
    assert.equal(first.script.released(), false, 'still held: the agent is outstanding');

    // The agent reports in; its follow-up turn's result lets the process go.
    first.script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    first.script.emit(init());
    first.script.emit(result());
    await waitFor(() => first.script.released());
    first.script.end();
    await firstRun;
    await secondRun;
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a message steered into a running turn reaches the live process with priority next', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_bash', 'Bash', { command: 'sleep 3' }));
    await settle();

    assert.equal(await claudeRuntime.steer(SESSION_ID, 'also say STEERED'), true);
    await waitFor(() => script.prompts.length === 2);
    assert.equal(script.prompts[1].priority, 'next');
    assert.deepEqual((script.prompts[1].message as Record<string, unknown>).content, 'also say STEERED');

    // Folded into the turn: no follow-up turn starts, so after the grace the
    // turn ends exactly once and the process is let go.
    script.emit(ack('toolu_bash', 'ok', {}));
    script.emit(result());
    await settle();
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 0, 'the end waits out the grace');
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(script.released(), true);
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'too late'), false, 'nothing to steer once the turn ended');
  });
});

test('a steered message that missed its turn keeps the turn open until its own turn ends', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await settle();
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'one more thing'), true);
    script.emit(result());
    // The CLI answers the late message in a turn of its own right away.
    script.emit(init());
    await new Promise((resolve) => { setTimeout(resolve, 2300); });
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 0, 'still running: the steered turn is going');
    assert.equal(script.released(), false);

    script.emit({ type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'and the other thing' }] } });
    script.emit(result());
    await settle();
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(script.released(), true);
  });
});

test('steering is refused when no live process runs the session', async () => {
  assert.equal(await claudeRuntime.steer('no-such-session', 'hello'), false);
  assert.equal(claudeRuntime.acceptsLiveInput('no-such-session'), false);
});

test('a held process that cannot take the turn is still let go when stopping its tasks throws', async () => {
  // Stopping is best effort; a stop that throws on the spot must not keep the
  // held process alive or take the new turn down with it.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const throwingStop: NonNullable<ProviderRuntimeContext['createQuery']> = (options) =>
    Object.assign(first.createQuery(options), {
      stopTask: () => { throw new Error('stop failed'); },
    });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: throwingStop });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    // A turn for another project directory cannot run in the held process,
    // so it falls back to replacing it (stopping its tasks first).
    const otherCwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-other-'));
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd: otherCwd }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    await rm(otherCwd, { recursive: true, force: true });
    assert.equal(first.script.released(), true, 'the held process is let go anyway');

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(second.script.released(), true, 'the new turn ran to completion');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

// ---------------------------------------------------------------------------
// Mirage: review fixes for steering, live turns and Stop.

type HeldRun = {
  first: Scripted;
  second: Scripted;
  firstSent: NormalizedMessage[];
  secondSent: NormalizedMessage[];
  secondQueries: () => number;
  cwd: string;
  /** Starts the session's next turn; it goes into the held process when it can. */
  next: (command: string, options?: Record<string, unknown>) => Promise<void>;
};

/**
 * Runs a first turn that leaves a background agent (`a1`) going, so its
 * process is held, then hands the test the means to send the next turn.
 */
async function withHeldRun(runTest: (run: HeldRun) => Promise<void>, firstOptions: Record<string, unknown> = {}): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  let secondQueries = 0;
  const firstSent: NormalizedMessage[] = [];
  const secondSent: NormalizedMessage[] = [];
  const firstWriter = { send: (message: NormalizedMessage) => { firstSent.push(message); }, userId: null };
  const secondWriter = { send: (message: NormalizedMessage) => { secondSent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const countingSecond: NonNullable<ProviderRuntimeContext['createQuery']> = (options) => {
    secondQueries += 1;
    return second.createQuery(options);
  };
  const laterRuns: Array<Promise<void>> = [];

  const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd, ...firstOptions }, firstWriter as never, { ...context, createQuery: first.createQuery });
  try {
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => firstSent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    await runTest({
      first: first.script,
      second: second.script,
      firstSent,
      secondSent,
      secondQueries: () => secondQueries,
      cwd,
      next: (command, options = {}) => {
        const run = queryClaudeSDK(command, { sessionId: SESSION_ID, cwd, ...options }, secondWriter as never, { ...context, createQuery: countingSecond });
        laterRuns.push(run);
        return run;
      },
    });
  } finally {
    first.script.end();
    second.script.end();
    await firstRun;
    await Promise.all(laterRuns);
    await rm(cwd, { recursive: true, force: true });
  }
}

const completes = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'complete').length;
const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

test('every message written into the live process carries its own uuid', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    await settle();
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'one'), true);
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'two'), true);
    await waitFor(() => script.prompts.length === 3);
    const uuids = script.prompts.slice(1).map((prompt) => prompt.uuid);
    assert.ok(uuids.every((uuid) => typeof uuid === 'string' && uuid.length > 0));
    assert.notEqual(uuids[0], uuids[1]);
    script.emit(result());
  });
});

test('a steer answered by a turn of its own is named back so the client drops «вклинено»', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await settle();
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'folded', { steerId: 'steer-in' }), true);
    await waitFor(() => script.prompts.length === 2);
    const foldedUuid = script.prompts[1].uuid;
    // Taken into the running turn: nothing to report.
    script.emit({ ...assistantText('ok, also that'), user_message_uuid: foldedUuid });
    await settle();
    assert.equal(sent.filter((message) => message.kind === 'chat_steer_new_turn').length, 0);

    assert.equal(await claudeRuntime.steer(SESSION_ID, 'late', { steerId: 'steer-late' }), true);
    await waitFor(() => script.prompts.length === 3);
    const lateUuid = script.prompts[2].uuid;
    script.emit(result());
    // The CLI runs the late message as its own turn.
    script.emit(init());
    script.emit({ ...assistantText('and the late one'), user_message_uuid: lateUuid });
    await settle();
    const notes = sent.filter((message) => message.kind === 'chat_steer_new_turn') as Array<NormalizedMessage & { steerId?: string }>;
    assert.deepEqual(notes.map((message) => message.steerId), ['steer-late']);
    script.emit(result());
  });
});

test('Stop asks the CLI to cancel queued messages and closes a process that sent no receipt after a steer', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await settle();
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'also this'), true);
    await waitFor(() => script.prompts.length === 2);

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.deepEqual(script.interrupts, [{ cancelQueued: true }]);
    assert.equal(script.closed(), true, 'nothing vouches that the steered message will not run');
    await waitFor(() => script.released());
    await settle();
    assert.equal(completes(sent), 0, 'the abort handler owns the terminal complete');
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'too late'), false);
  });
});

test('Stop closes the process when the receipt still lists a message written into it', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    await settle();
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'also this'), true);
    await waitFor(() => script.prompts.length === 2);
    script.receipt = { still_queued: ['someone-elses-uuid', script.prompts[1].uuid] };

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.equal(script.closed(), true);
  });
});

test('Stop leaves the process to wind down when the CLI cancelled what was written in', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    await settle();
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'also this'), true);
    await waitFor(() => script.prompts.length === 2);
    script.receipt = { still_queued: ['a-cron-trigger-we-never-sent'], cancelled: [script.prompts[1].uuid] };

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.equal(script.closed(), false, 'unknown uuids are ignored');
    await waitFor(() => script.released());
  });
});

test('Stop with nothing written in since the turn began needs no receipt to trust the interrupt', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    await settle();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.equal(script.closed(), false);
    await waitFor(() => script.released());
  });
});

test('Stop stops the session\'s background tasks before letting the process go', async () => {
  await withHeldRun(async ({ first }) => {
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.deepEqual(first.stopped, ['a1'], 'Stop stops the agent, like replacing the process does');
    await waitFor(() => first.released());
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('a turn after a Stop reports its own complete while the stopped process still winds down', async () => {
  await withHeldRun(async ({ first, second, next, secondSent, secondQueries }) => {
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    const secondRun = next('again');
    await waitFor(() => secondQueries() === 1);
    second.emit(init());
    second.emit(assistantText('fresh'));
    second.emit(result());
    await waitFor(() => completes(secondSent) === 1);
    assert.equal(first.released(), true);
    second.end();
    await secondRun;
  });
});

test('a task stopped during a turn continued in the held process does not close stdin under it', async () => {
  await withHeldRun(async ({ first, next, secondSent, secondQueries }) => {
    const secondRun = next('Continue');
    await waitFor(() => first.prompts.length === 2);
    assert.equal(secondQueries(), 0);

    first.emit(init());
    // The user stops the agent while the continued turn runs.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'a1'), true);
    first.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    await settle();
    assert.equal(first.released(), false, 'the running turn keeps its stdin');

    first.emit(assistantText('done'));
    first.emit(result());
    await secondRun;
    assert.equal(completes(secondSent), 1);
    assert.equal(first.released(), true, 'nothing is outstanding once the turn ends');
  });
});

test('a message steered between a result and the next init still holds the turn open', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await settle();
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'first'), true);
    script.emit(result());
    await settle();
    // Inside the grace: the CLI has not started the turn for `first` yet.
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'second'), true);
    script.emit(init());
    script.emit(assistantText('about first'));
    script.emit(result());
    await settle();
    assert.equal(completes(sent), 0, '`second` may still get a turn of its own');

    script.emit(init());
    script.emit(assistantText('about second'));
    script.emit(result());
    await waitFor(() => completes(sent) === 1);
    assert.equal(script.released(), true);
  });
});

test('two steers in a row reach the process in the order they were sent', async () => {
  await withRun(async ({ script, cwd }) => {
    // The first one carries an image, so it takes longer to build.
    const imagePath = path.join(cwd, 'shot.png');
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    script.emit(init());
    await settle();

    const firstSteer = claudeRuntime.steer(SESSION_ID, 'with picture', { images: [{ path: imagePath }] });
    const secondSteer = claudeRuntime.steer(SESSION_ID, 'plain');
    assert.deepEqual(await Promise.all([firstSteer, secondSteer]), [true, true]);
    await waitFor(() => script.prompts.length === 3);
    assert.ok(JSON.stringify(script.prompts[1].message).includes('with picture'));
    assert.deepEqual((script.prompts[2].message as Record<string, unknown>).content, 'plain');
    script.emit(result());
  });
});

test('a live turn waits for its option changes before its message goes in', async () => {
  await withHeldRun(async ({ first, next, secondQueries }) => {
    first.controlDelayMs = 60;
    const secondRun = next('Plan this', { permissionMode: 'plan', model: 'opus' });
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    assert.equal(first.prompts.length, 1, 'the message waits for the CLI to accept the changes');
    await waitFor(() => first.prompts.length === 2);
    assert.equal(secondQueries(), 0);
    assert.deepEqual(first.controls.map(([name, value]) => [name, value]), [['setModel', 'opus'], ['setPermissionMode', 'plan']]);
    first.emit(init());
    first.emit(result());
    await secondRun;
  });
});

test('a stricter permission mode the live process refuses sends the turn to a fresh process', async () => {
  await withHeldRun(async ({ first, second, next, secondQueries, secondSent }) => {
    first.failingControls.add('setPermissionMode');
    const secondRun = next('Plan this', { permissionMode: 'plan' });
    await waitFor(() => secondQueries() === 1);
    assert.equal(first.prompts.length, 1, 'nothing is written into the old process');
    assert.deepEqual(first.stopped, ['a1'], 'the old process is replaced the usual way');
    assert.equal(first.released(), true);
    second.emit(init());
    second.emit(result());
    await waitFor(() => completes(secondSent) === 1);
    second.end();
    await secondRun;
  });
});

test('a looser permission mode the live process refuses keeps the stricter one and the turn', async () => {
  await withHeldRun(async ({ first, next, secondQueries }) => {
    first.failingControls.add('setPermissionMode');
    const secondRun = next('Go ahead', { permissionMode: 'default' });
    await waitFor(() => first.prompts.length === 2);
    assert.equal(secondQueries(), 0);
    first.emit(init());
    first.emit(result());
    await secondRun;
  }, { permissionMode: 'plan' });
});

test('a model change the live process refuses is asked for again on the next turn', async () => {
  await withHeldRun(async ({ first, next, secondQueries }) => {
    first.failingControls.add('setModel');
    const secondRun = next('Continue', { model: 'opus' });
    await waitFor(() => first.prompts.length === 2);
    assert.equal(secondQueries(), 0, 'the turn still runs, on the model the process had');
    first.emit(init());
    first.emit(result());
    await secondRun;

    first.failingControls.delete('setModel');
    const thirdRun = next('Continue again', { model: 'opus' });
    await waitFor(() => first.prompts.length === 3);
    assert.deepEqual(first.controls, [['setModel', 'opus']]);
    first.emit(init());
    first.emit(result());
    await thirdRun;
  });
});

test('a stale steering grace cannot end the next turn continued in the process', async () => {
  await withHeldRun(async ({ first, next, secondSent }) => {
    // A steer into the continued turn arms the grace at its result; a second
    // result without an init then settles the turn — and must disarm it.
    const continued = next('Continue');
    await waitFor(() => first.prompts.length === 2);
    first.emit(init());
    await settle();
    assert.equal(await claudeRuntime.steer(SESSION_ID, 'and this'), true);
    first.emit(result());
    first.emit(result());
    await waitFor(() => completes(secondSent) === 1);
    await continued;

    const third = next('And more');
    await waitFor(() => first.prompts.length === 4);
    await new Promise((resolve) => { setTimeout(resolve, 2300); });
    assert.equal(completes(secondSent), 1, 'the third turn is still running');
    first.emit(init());
    first.emit(result());
    await third;
    assert.equal(completes(secondSent), 2);
  });
});

test('a live turn whose setup throws reports the error instead of escaping', async () => {
  await withHeldRun(async ({ first, next, secondSent, secondQueries }) => {
    // Unusable tool settings make the option mapping throw.
    await next('Continue', { toolsSettings: { allowedTools: 5 } });
    assert.equal(secondQueries(), 0);
    const error = secondSent.find((message) => message.kind === 'error');
    assert.ok(error, 'an error reaches the client');
    assert.equal(typeof error.content, 'string');
    const complete = secondSent.find((message) => message.kind === 'complete');
    assert.equal(complete?.exitCode, 1);
    assert.equal(first.released(), false, 'the held process and its agent are untouched');
  });
});

test('a process already letting go is replaced without an interrupt it can no longer take', async () => {
  await withHeldRun(async ({ first, second, next, secondQueries }) => {
    // The agent reports in; its follow-up turn's result lets stdin go while
    // the process is still winding down.
    first.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    first.emit(init());
    first.emit(result());
    await waitFor(() => first.released());

    const run = next('after the turn');
    await waitFor(() => secondQueries() === 1);
    await settle();
    assert.deepEqual(first.interrupts, [], 'no "Query closed" interrupt');
    second.emit(init());
    second.emit(result());
    second.end();
    await run;
  });
});

test('the CLI\'s "No response requested." stand-in is not shown', async () => {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const row = (content: unknown, model = '<synthetic>') => ({
    type: 'assistant', uuid: 'row-1', timestamp: '2026-10-26T00:00:00.000Z',
    message: { role: 'assistant', model, content },
  });
  assert.deepEqual(sessions.normalizeMessage(row([{ type: 'text', text: 'No response requested.' }]), 's'), []);
  assert.deepEqual(sessions.normalizeMessage(row('No response requested.'), 's'), []);
  assert.equal(sessions.normalizeMessage(row([{ type: 'text', text: 'No response requested.' }], 'claude-haiku-4-5'), 's').length, 1, 'a real reply is kept');

  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit({ ...row([{ type: 'text', text: 'No response requested.' }]), session_id: NATIVE_ID, parent_tool_use_id: null });
    script.emit(result());
    await waitFor(() => completes(sent) === 1);
    assert.equal(sent.some((message) => message.kind === 'text'), false);
  });
});

test('a turn the CLI runs for a pending task notification before the prompt does not end the client\'s turn', async () => {
  // Verified live (SDK 0.3.310): after a Stop that also stopped a background
  // task, the resumed process first reports the stopped task and runs a turn
  // of its own for it (init and result with no client uuid), then the turn
  // for the prompt. Ending the client's turn at the first result left its
  // real turn without a run, so the panel's «Стоп» had nothing to abort.
  await withRun(async ({ script, sent }) => {
    await waitFor(() => script.prompts.length === 1);
    const promptUuid = script.prompts[0].uuid;
    assert.equal(typeof promptUuid, 'string', 'the prompt carries a uuid the CLI can name back');

    script.emit(taskNotification('old-bg', 'toolu_old', 'stopped'));
    script.emit(init());
    script.emit(result());
    await settle();
    assert.equal(completes(sent), 0, 'the CLI\'s own turn is not the client\'s');

    // The prompt's own turn follows straight away, past the steering grace.
    script.emit({ ...init(), user_message_uuids: [promptUuid] });
    script.emit({ ...assistantText('working'), user_message_uuid: promptUuid, user_message_uuids: [promptUuid] });
    await new Promise((resolve) => { setTimeout(resolve, 2300); });
    assert.equal(completes(sent), 0, 'the client\'s turn is still running');
    script.emit({ ...result(), user_message_uuid: promptUuid, user_message_uuids: [promptUuid] });
    await waitFor(() => completes(sent) === 1);
  });
});

test('a CLI turn of its own still ends the client\'s turn when no turn for the prompt follows', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(taskNotification('old-bg', 'toolu_old', 'stopped'));
    script.emit(init());
    script.emit(result());
    await settle();
    assert.equal(completes(sent), 0);
    // An older CLI that names no uuids ran the prompt in that same turn.
    await waitFor(() => completes(sent) === 1);
  });
});

test('Mirage: a stopped turn is kept in history as a turn_stopped mark', () => {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const userRow = (content: unknown) => ({
    type: 'user', uuid: 'row-2', timestamp: '2026-10-26T00:00:01.000Z',
    message: { role: 'user', content },
  });
  for (const content of [
    [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
    [{ type: 'text', text: '[Request interrupted by user]' }],
    '[Request interrupted by user]',
  ]) {
    const [mark, ...rest] = sessions.normalizeMessage(userRow(content), 's');
    assert.equal(mark?.kind, 'turn_stopped');
    assert.equal(mark?.timestamp, '2026-10-26T00:00:01.000Z');
    assert.deepEqual(rest, []);
  }
  // An ordinary message that merely quotes the banner is still the user's.
  const quoted = sessions.normalizeMessage(userRow('why did I see [Request interrupted by user]?'), 's');
  assert.equal(quoted[0]?.kind, 'text');
});

test('Mirage: task events say whether the task runs in the background', () => {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const [foreground] = sessions.normalizeMessage({
    type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_1',
    description: 'Pause 5 seconds', task_type: 'local_bash', is_backgrounded: false, uuid: 'u1',
  }, 's');
  assert.equal(foreground?.kind, 'task_status');
  assert.equal(foreground?.backgrounded, false);
  const [moved] = sessions.normalizeMessage({
    type: 'system', subtype: 'task_updated', task_id: 't1', patch: { is_backgrounded: true }, uuid: 'u2',
  }, 's');
  assert.equal(moved?.backgrounded, true);
});

// ---------------------------------------------------------------------------
// Mirage (Б8, Б9): the panel's permission mode reaches the CLI.

/** Runs one turn with `options`; returns the SDK options it started the CLI with (null when none started). */
async function sdkOptionsOfTurn(
  options: Record<string, unknown>,
): Promise<{ options: Record<string, unknown> | null; sent: NormalizedMessage[] }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-mode-'));
  const { createQuery, script } = createScriptedQuery();
  let started: Record<string, unknown> | null = null;
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: (queryOptions) => {
      started = (queryOptions as unknown as { options: Record<string, unknown> }).options;
      return createQuery(queryOptions);
    },
  };
  try {
    const done = queryClaudeSDK('hello', { sessionId: 'app-mode-session', cwd, ...options }, writer as never, context);
    await settle();
    script.emit({ ...init(), session_id: 'native-mode-session' });
    script.emit({ ...result(), session_id: 'native-mode-session' });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  return { options: started, sent };
}

test('Mirage (Б8): Default is passed to the SDK instead of leaving the settings.json default in force', async () => {
  const { options } = await sdkOptionsOfTurn({ permissionMode: 'default' });
  assert.equal(options?.permissionMode, 'default');
});

test('Mirage (Б8): every other mode the panel picks is passed as is', async () => {
  for (const mode of ['auto', 'plan', 'acceptEdits']) {
    const { options } = await sdkOptionsOfTurn({ permissionMode: mode });
    assert.equal(options?.permissionMode, mode);
  }
});

test('Mirage (Б8): a held process started on the settings default is switched to Default when a turn asks', async () => {
  await withHeldRun(async ({ first, next, secondQueries }) => {
    const secondRun = next('Ask me first', { permissionMode: 'default' });
    await waitFor(() => first.prompts.length === 2);
    assert.equal(secondQueries(), 0);
    assert.deepEqual(first.controls, [['setPermissionMode', 'default']]);
    first.emit(init());
    first.emit(result());
    await secondRun;
  });
});

test('Mirage (Б8): a mode change between turns goes to the live process', async () => {
  await withHeldRun(async ({ first, next }) => {
    const secondRun = next('Go on', { permissionMode: 'auto' });
    await waitFor(() => first.prompts.length === 2);
    assert.deepEqual(first.controls, [['setPermissionMode', 'auto']]);
    first.emit(init());
    first.emit(result());
    await secondRun;
  }, { permissionMode: 'default' });
});

test('Mirage (Б9): Bypass under root is recognised the way the CLI refuses it', () => {
  const root = () => 0;
  assert.equal(isBypassRefusedForRoot({ permissionMode: 'bypassPermissions' }, {}, root), true);
  assert.equal(isBypassRefusedForRoot({ permissionMode: 'default', toolsSettings: { skipPermissions: true } }, {}, root), true);
  assert.equal(isBypassRefusedForRoot({ permissionMode: 'plan', toolsSettings: { skipPermissions: true } }, {}, root), false);
  assert.equal(isBypassRefusedForRoot({ permissionMode: 'default' }, {}, root), false);
  assert.equal(isBypassRefusedForRoot({ permissionMode: 'bypassPermissions' }, { IS_SANDBOX: '1' }, root), false);
  assert.equal(isBypassRefusedForRoot({ permissionMode: 'bypassPermissions' }, {}, () => 1000), false);
});

test(
  'Mirage (Б9): a Bypass turn under root says why and starts no process',
  { skip: process.getuid?.() !== 0 || process.env.IS_SANDBOX === '1' || Boolean(process.env.CLAUDE_CODE_BUBBLEWRAP) },
  async () => {
    const { options, sent } = await sdkOptionsOfTurn({ permissionMode: 'bypassPermissions' });
    assert.equal(options, null, 'no CLI process is started');
    const error = sent.find((message) => message.kind === 'error');
    assert.equal(error?.content, BYPASS_UNDER_ROOT_MESSAGE);
    assert.equal(sent.at(-1)?.kind, 'complete');
  },
);

test('Mirage: the turn the CLI runs on its own to relay a finished task is listed and «Стоп» stops it', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_bg', 'Bash', { command: 'sleep 20', run_in_background: true }));
    script.emit(taskStarted('bg1', 'toolu_bg', 'local_bash'));
    script.emit(ack('toolu_bg', 'Command running in background with ID: bg1', { backgroundTaskId: 'bg1' }));
    script.emit(result());
    await settle();
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1, 'the client turn is over');
    assert.deepEqual(claudeRuntime.listOwnTurns(), [], 'held for the task, but no turn runs');

    // The task finishes; the CLI relays it in a turn of its own.
    script.emit(taskNotification('bg1', 'toolu_bg', 'completed'));
    script.emit(init());
    script.emit(toolUse('toolu_fg', 'Bash', { command: './wait.sh' }));
    await settle();

    const turns = claudeRuntime.listOwnTurns();
    assert.deepEqual(turns.map((turn) => turn.sessionId), [SESSION_ID]);
    assert.equal(typeof turns[0].startedAt, 'number');
    assert.equal(claudeRuntime.canAbort(SESSION_ID), true);

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.equal(script.interrupts.length, 1, 'the turn is interrupted');
    await settle();
    assert.equal(script.released(), true, 'and the process let go');
    assert.equal(claudeRuntime.canAbort(SESSION_ID), false);
    assert.deepEqual(claudeRuntime.listOwnTurns(), []);
  });
});

test('Mirage: «Стоп» closes a process that no longer takes the interrupt instead of letting its turn run on', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_fg', 'Bash', { command: './wait.sh' }));
    await settle();
    // The SDK refuses control requests once stdin has ended.
    script.interruptError = new Error('Query closed before response received');

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.equal(script.closed(), true, 'the process is ended');
  });
});
