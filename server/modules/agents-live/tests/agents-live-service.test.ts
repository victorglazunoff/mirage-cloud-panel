import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { readPermissionDecision } from '@/modules/agents-live/agents-live.routes.js';
import { createAgentsLiveService } from '@/modules/agents-live/services/agents-live.service.js';
import type { LLMProvider, ProviderPermissionDecision, ProviderRuntimeEvent, ProviderRuntimeEventListener } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const SESSION = 'app-svc';
const RUN = 'run-svc';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, any>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, any>);
  return socket;
}

function setup(overrides: { live?: boolean; runStatus?: string | null } = {}) {
  let listener: ProviderRuntimeEventListener | null = null;
  const calls = {
    stopTask: [] as Array<[LLMProvider, string, string]>,
    abort: [] as Array<[LLMProvider, string]>,
    approvals: [] as Array<[string, ProviderPermissionDecision]>,
    completed: [] as Array<[string, boolean]>,
  };
  const service = createAgentsLiveService({
    now: () => Date.parse('2026-10-26T14:30:00Z'),
    subscribeRuntimeEvents: (next) => { listener = next; return () => { listener = null; }; },
    describeSession: (sessionId, projectPath) => ({ projectId: 'p1', projectName: 'Панель Мираж', projectPath, sessionTitle: sessionId }),
    getSessionProvider: () => 'claude',
    listRunningSessions: async () => [
      { sessionId: SESSION, provider: 'claude', startedAt: 1 },
      { sessionId: 'terminal-session', provider: 'claude', startedAt: 2, statusText: 'Running in the Claude CLI' },
    ],
    readExternalTranscript: async () => ({
      model: 'claude-opus-4-8',
      tokens: 41_200,
      toolCalls: 7,
      recentActions: [{ at: '2026-10-26T14:29:00Z', tool: 'Read', text: 'server/index.ts', kind: 'tool' }],
    }),
    stopTask: async (provider, sessionId, taskId) => { calls.stopTask.push([provider, sessionId, taskId]); return true; },
    abort: async (provider, sessionId) => { calls.abort.push([provider, sessionId]); return true; },
    isLive: () => overrides.live ?? true,
    resolveToolApproval: (requestId, decision) => { calls.approvals.push([requestId, decision]); },
    getRunStatus: () => (overrides.runStatus === null ? null : { status: overrides.runStatus ?? 'running', provider: 'claude' }),
    completeAbortedRun: (sessionId, success) => { calls.completed.push([sessionId, success]); },
  });
  service.start();
  const emit = (event: ProviderRuntimeEvent) => listener?.(event);
  const sdk = (message: Record<string, unknown>) => emit({
    type: 'sdk_message', provider: 'claude', sessionId: SESSION, runId: RUN, providerSessionId: null, message, normalized: [], at: Date.now(),
  });
  emit({ type: 'run_started', provider: 'claude', sessionId: SESSION, runId: RUN, providerSessionId: null, projectPath: '/srv/mirage', at: Date.now() });
  sdk({
    type: 'assistant', parent_tool_use_id: null,
    message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'u-agent', name: 'Agent', input: { description: 'Дизайн · Агенты', prompt: 'макет' } }] },
  });
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-agent', tool_use_id: 'u-agent', description: 'Дизайн · Агенты', task_type: 'local_agent' });
  return { service, emit, sdk, calls, stop: () => service.stop() };
}

test('a subscribed socket gets a snapshot, then coalesced deltas', async () => {
  const { service, sdk, stop } = setup();
  try {
    const socket = createFakeSocket();
    await service.handleSocketMessage(socket as never, { type: 'agents.subscribe' });
    assert.equal(socket.frames[0].kind, 'agents_snapshot');
    const snapshot = socket.frames[0].snapshot;
    assert.deepEqual(snapshot.sessions[0].agents.map((node: { id: string }) => node.id), ['main', 'u-agent']);
    // A CLI working outside the panel is listed without a tree.
    assert.deepEqual(snapshot.sessions.map((entry: { status: string }) => entry.status), ['running', 'external']);
    // …with what its transcript tells, in Russian, and counted by the header like any working agent.
    const external = snapshot.sessions[1].orchestrator;
    assert.equal(external.currentAction, 'Идёт в терминале Claude');
    assert.equal(external.modelFamily, 'opus');
    assert.equal(external.tokens, 41_200);
    assert.equal(external.toolCalls, 7);
    assert.equal(external.recentActions[0].text, 'server/index.ts');
    assert.equal(snapshot.stats.working, 3, 'main + agent of the panel session, plus the CLI session');
    assert.equal(snapshot.stats.activeProjects, 1);

    sdk({ type: 'system', subtype: 'task_progress', task_id: 't-agent', description: 'x', usage: { total_tokens: 500, tool_uses: 3, duration_ms: 10 } });
    sdk({ type: 'system', subtype: 'task_progress', task_id: 't-agent', description: 'x', usage: { total_tokens: 900, tool_uses: 4, duration_ms: 20 } });
    service.flushNow();
    const deltas = socket.frames.filter((frame) => frame.kind === 'agents_delta');
    assert.equal(deltas.length, 1, 'two events, one frame');
    assert.equal(deltas[0].delta.sessions[0].agents[1].tokens, 900);

    await service.handleSocketMessage(socket as never, { type: 'agents.unsubscribe' });
    sdk({ type: 'system', subtype: 'task_progress', task_id: 't-agent', description: 'x', usage: { total_tokens: 1000, tool_uses: 5, duration_ms: 30 } });
    service.flushNow();
    assert.equal(socket.frames.filter((frame) => frame.kind === 'agents_delta').length, 1);
  } finally {
    stop();
  }
});

test('stopping an agent stops its CLI task; stopping main stops the whole session', async () => {
  const { service, calls, stop } = setup();
  try {
    assert.deepEqual(await service.stopAgent(SESSION, 'u-agent'), { ok: true, error: null });
    assert.deepEqual(calls.stopTask, [['claude', SESSION, 't-agent']]);

    assert.equal((await service.stopAgent(SESSION, 'nope')).ok, false);

    assert.deepEqual(await service.stopAgent(SESSION, 'main'), { ok: true, error: null });
    assert.deepEqual(calls.abort, [['claude', SESSION]]);
    assert.deepEqual(calls.completed, [[SESSION, true]], 'the running chat turn is closed as aborted');
  } finally {
    stop();
  }
});

test('stop is refused without a live process; stop-session without anything running', async () => {
  const { service, calls, stop } = setup({ live: false, runStatus: null });
  try {
    assert.equal((await service.stopAgent(SESSION, 'u-agent')).error, 'У сессии нет живого процесса.');
    assert.equal((await service.stopSession(SESSION)).ok, false);
    assert.deepEqual(calls.stopTask, []);
    assert.deepEqual(calls.abort, []);
  } finally {
    stop();
  }
});

test('permission answers go through the runtime resolver, only for prompts that wait', async () => {
  const { service, emit, calls, stop } = setup();
  try {
    assert.equal(service.answerPermission('req-x', { allow: true }).ok, false);
    emit({
      type: 'permission_requested', provider: 'claude', sessionId: SESSION, runId: RUN, requestId: 'req-1',
      toolName: 'Bash', input: { command: 'rm -rf dist' }, toolUseId: null, agentId: null, at: Date.now(),
    });
    const socket = createFakeSocket();
    await service.handleSocketMessage(socket as never, { type: 'agents.permission', requestId: 'req-1', allow: false, message: 'нет', requestKey: 'k1' });
    assert.deepEqual(calls.approvals, [['req-1', { allow: false, message: 'нет', rememberEntry: undefined }]]);
    assert.deepEqual(socket.frames[0], { kind: 'agents_action_result', action: 'permission', requestKey: 'k1', ok: true, error: null });
  } finally {
    stop();
  }
});

test('the permission route accepts only an explicit boolean decision', () => {
  assert.deepEqual(readPermissionDecision({ allow: true, rememberEntry: 'Bash(npm test:*)' }), {
    allow: true, message: undefined, rememberEntry: 'Bash(npm test:*)',
  });
  assert.throws(() => readPermissionDecision({ allow: 'yes' }), AppError);
  assert.throws(() => readPermissionDecision(null), AppError);
});
