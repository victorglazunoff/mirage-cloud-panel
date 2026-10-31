import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAgentsLiveAggregator,
  summarizeToolCall,
} from '@/modules/agents-live/services/agents-live-aggregator.service.js';
import type { LiveAgentsSession, NormalizedMessage, ProviderRuntimeEvent } from '@/shared/types.js';

const SESSION = 'app-1';
const RUN = 'run-1';
const PROJECT = '/srv/demo-site';

function createClock(start = Date.parse('2026-10-26T14:30:00Z')) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function setup() {
  const clock = createClock();
  const aggregator = createAgentsLiveAggregator({
    now: clock.now,
    describeSession: (sessionId, projectPath) => ({
      projectId: 'p1',
      projectName: 'Сайт клиента',
      projectPath,
      sessionTitle: `Сессия ${sessionId}`,
    }),
  });
  const sdk = (message: Record<string, unknown>, normalized: unknown[] = [], runId = RUN): void => {
    aggregator.apply({
      type: 'sdk_message', provider: 'claude', sessionId: SESSION, runId, providerSessionId: 'native-1',
      message, normalized: normalized as NormalizedMessage[], at: clock.now(),
    });
  };
  const start = () => aggregator.apply({
    type: 'run_started', provider: 'claude', sessionId: SESSION, runId: RUN, providerSessionId: null, projectPath: PROJECT, at: clock.now(),
  });
  const session = (): LiveAgentsSession => {
    const found = aggregator.snapshot().sessions.find((entry) => entry.sessionId === SESSION);
    assert.ok(found, 'session is listed');
    return found;
  };
  const agent = (id: string) => {
    const found = session().agents.find((node) => node.id === id);
    assert.ok(found, `agent ${id} is listed`);
    return found;
  };
  return { clock, aggregator, sdk, start, session, agent };
}

const assistant = (content: unknown[], parent: string | null = null, model = 'claude-opus-4-8') => ({
  type: 'assistant', parent_tool_use_id: parent,
  message: { id: `msg-${Math.random()}`, model, role: 'assistant', content, usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 50 } },
});
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const toolResult = (toolUseId: string, parent: string | null = null, isError = false) => ({
  type: 'user', parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: isError }] },
});

test('builds the orchestrator, a subagent, a nested agent and a background shell from the stream', () => {
  const { sdk, start, session, agent, clock } = setup();
  start();
  sdk({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' });
  sdk(assistant([
    toolUse('u-agent', 'Agent', { description: 'Сбор объявлений', subagent_type: 'researcher', prompt: 'Пройти 6 площадок', model: 'haiku' }),
    toolUse('u-bash', 'Bash', { command: 'npm run watch', run_in_background: true, description: 'Сборка в фоне' }),
  ]));
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-agent', tool_use_id: 'u-agent', description: 'Сбор объявлений', subagent_type: 'researcher', task_type: 'local_agent', spawn_depth: 0, is_backgrounded: false });
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-bash', tool_use_id: 'u-bash', description: 'npm run watch', task_type: 'local_bash', is_backgrounded: true });
  // A foreground command of the orchestrator is a tool call, not an agent.
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-fg', tool_use_id: 'u-fg', description: 'ls', task_type: 'local_bash', is_backgrounded: false });

  clock.advance(5_000);
  sdk(assistant([toolUse('u-read', 'Read', { file_path: `${PROJECT}/server/index.ts` })], 'u-agent', 'claude-haiku-4-5-20251001'));
  sdk(assistant([toolUse('u-nested', 'Task', { description: 'Запросы Wordstat', prompt: 'частотности' })], 'u-agent', 'claude-haiku-4-5-20251001'));
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-nested', tool_use_id: 'u-nested', description: 'Запросы Wordstat', task_type: 'local_agent', parent_task_id: 't-agent', spawn_depth: 1 });

  const ids = session().agents.map((node) => node.id);
  assert.deepEqual(ids, ['main', 'u-agent', 'u-bash', 'u-nested']);

  const main = agent('main');
  assert.equal(main.kind, 'orchestrator');
  assert.equal(main.state, 'tool');
  assert.equal(main.modelFamily, 'opus');
  assert.equal(main.tokens, 1060);

  const sub = agent('u-agent');
  assert.equal(sub.taskId, 't-agent');
  assert.equal(sub.parentId, 'main');
  assert.equal(sub.spawnDepth, 1);
  assert.equal(sub.role, 'researcher');
  assert.equal(sub.task, 'Пройти 6 площадок');
  assert.equal(sub.modelFamily, 'haiku');
  assert.equal(sub.state, 'tool');
  assert.equal(sub.currentAction, 'Task Запросы Wordstat');
  assert.deepEqual(sub.recentActions.slice(0, 2).map((action) => [action.tool, action.text]), [
    ['Task', 'Запросы Wordstat'],
    ['Read', 'server/index.ts'],
  ]);
  assert.equal(sub.canStop, true);

  const nested = agent('u-nested');
  assert.equal(nested.parentId, 'u-agent');
  assert.equal(nested.parentTaskId, 't-agent');
  assert.equal(nested.spawnDepth, 2);

  const shell = agent('u-bash');
  assert.equal(shell.kind, 'shell');
  assert.equal(shell.backgrounded, true);
  assert.equal(shell.name, 'Сборка в фоне');
  assert.equal(shell.state, 'tool');
});

test('a permission prompt marks the asking agent waiting until it is answered', () => {
  const { sdk, start, session, agent, aggregator, clock } = setup();
  start();
  sdk(assistant([toolUse('u-agent', 'Agent', { description: 'Выкладка на прод', prompt: 'deploy' })]));
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-agent', tool_use_id: 'u-agent', description: 'Выкладка на прод', task_type: 'local_agent' });
  sdk(assistant([toolUse('u-rsync', 'Bash', { command: 'rsync dist/ prod:/var/www' })], 'u-agent'));
  aggregator.apply({
    type: 'permission_requested', provider: 'claude', sessionId: SESSION, runId: RUN, requestId: 'req-1', toolName: 'Bash',
    input: { command: 'rsync dist/ prod:/var/www' }, toolUseId: 'u-rsync', agentId: null, at: clock.now(),
  });

  assert.equal(session().status, 'waiting');
  assert.equal(agent('u-agent').state, 'waiting');
  assert.equal(agent('u-agent').permission?.requestId, 'req-1');
  assert.equal(agent('main').permission, null, 'the orchestrator is not the one waiting');
  assert.deepEqual(session().pendingPermissions.map((entry) => [entry.requestId, entry.agentId]), [['req-1', 'u-agent']]);
  assert.equal(aggregator.snapshot().stats.waiting, 1);
  assert.equal(aggregator.findPermission('req-1'), SESSION);
  assert.equal(aggregator.snapshot().feed[0].kind, 'waiting');

  aggregator.apply({ type: 'permission_settled', provider: 'claude', sessionId: SESSION, runId: RUN, requestId: 'req-1', outcome: 'allowed', at: clock.now() });
  assert.equal(agent('u-agent').state, 'tool');
  assert.equal(agent('u-agent').permission, null);
  assert.equal(agent('u-agent').recentActions[0].text, 'разрешено');
  assert.equal(aggregator.findPermission('req-1'), null);
  assert.equal(session().status, 'running');

  sdk(toolResult('u-rsync', 'u-agent'));
  assert.equal(agent('u-agent').state, 'thinking');
});

test('progress, notifications and the turn result settle agents, usage and the session status', () => {
  const { sdk, start, session, agent, aggregator, clock } = setup();
  start();
  sdk(assistant([
    toolUse('u-agent', 'Agent', { description: 'Скептик', prompt: 'проверь' }),
    toolUse('u-bash', 'Bash', { command: 'sleep 60', run_in_background: true }),
  ]));
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-agent', tool_use_id: 'u-agent', description: 'Скептик', task_type: 'local_agent' });
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-bash', tool_use_id: 'u-bash', description: 'sleep 60', task_type: 'local_bash', is_backgrounded: true });
  sdk({ type: 'system', subtype: 'task_progress', task_id: 't-agent', description: 'Скептик', usage: { total_tokens: 18400, tool_uses: 12, duration_ms: 131000 }, summary: 'Сверяет цены' });
  assert.equal(agent('u-agent').tokens, 18400);
  assert.equal(agent('u-agent').toolCalls, 12);
  assert.equal(agent('u-agent').summary, 'Сверяет цены');

  // The foreground agent's tool result in the main thread is its end.
  clock.advance(1000);
  sdk(toolResult('u-agent'));
  assert.equal(agent('u-agent').state, 'done');
  assert.ok(agent('u-agent').endedAt);
  assert.equal(agent('u-agent').canStop, false);
  sdk({ type: 'system', subtype: 'task_notification', task_id: 't-agent', status: 'completed', summary: 'Готово: 3 дубля', output_file: '', usage: { total_tokens: 20000, tool_uses: 14, duration_ms: 132000 } });
  assert.equal(agent('u-agent').durationMs, 132000);

  sdk(toolResult('u-bash'));
  assert.equal(agent('u-bash').state, 'tool', 'a background command keeps running after its launch receipt');

  sdk({
    type: 'result', subtype: 'success', is_error: false, result: 'Запустил проверку', total_cost_usd: 0.42,
    modelUsage: { 'claude-opus-4-8': { inputTokens: 100, outputTokens: 2000, cacheReadInputTokens: 50000, cacheCreationInputTokens: 900, costUSD: 0.42, contextWindow: 1000000 } },
  });
  assert.equal(agent('main').state, 'done');
  assert.equal(session().status, 'background');
  assert.equal(session().usage?.costUsd, 0.42);
  assert.equal(session().usage?.outputTokens, 2000);
  assert.equal(aggregator.snapshot().stats.tokensLastHour, 3000);
  assert.equal(aggregator.snapshot().stats.doneLastHour, 1, 'the orchestrator turn is not counted as a finished agent');

  sdk({ type: 'system', subtype: 'task_notification', task_id: 't-bash', status: 'failed', summary: 'exit 1', output_file: '' });
  assert.equal(agent('u-bash').state, 'error');
  assert.equal(agent('u-bash').error, 'exit 1');
  assert.equal(session().status, 'idle');
  assert.equal(aggregator.snapshot().stats.errors, 1);

  aggregator.apply({ type: 'run_ended', provider: 'claude', sessionId: SESSION, runId: RUN, reason: 'completed', at: clock.now() });
  assert.equal(session().status, 'ended');
  assert.equal(agent('main').canStop, false);
});

test('a process end stops whatever was still running, and a replaced process is ignored', () => {
  const { sdk, start, agent, aggregator, clock, session } = setup();
  start();
  sdk(assistant([toolUse('u-agent', 'Agent', { description: 'Долгий', run_in_background: true })]));
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-agent', tool_use_id: 'u-agent', description: 'Долгий', task_type: 'local_agent', is_backgrounded: true });

  // Late events of an older process must not touch the current one.
  sdk({ type: 'system', subtype: 'task_notification', task_id: 't-agent', status: 'stopped', summary: '', output_file: '' }, [], 'run-old');
  aggregator.apply({ type: 'run_ended', provider: 'claude', sessionId: SESSION, runId: 'run-old', reason: 'completed', at: clock.now() });
  assert.equal(agent('u-agent').state, 'thinking');
  assert.notEqual(session().status, 'ended');

  aggregator.apply({ type: 'run_ended', provider: 'claude', sessionId: SESSION, runId: RUN, reason: 'aborted', at: clock.now() });
  assert.equal(agent('u-agent').state, 'stopped');
  assert.equal(agent('main').state, 'stopped');

  // Ended sessions are dropped an hour later, and the drop is announced.
  aggregator.takeDelta();
  clock.advance(61 * 60 * 1000);
  assert.equal(aggregator.prune(), true);
  const delta = aggregator.takeDelta();
  assert.deepEqual(delta?.removedSessionIds, [SESSION]);
  assert.equal(aggregator.snapshot().sessions.length, 0);
});

test('workflow progress becomes workflow agents and a phase strip', () => {
  const { sdk, start, session, agent } = setup();
  start();
  sdk(assistant([toolUse('u-wf', 'Workflow', { script: 'export const meta = {}' })]));
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-wf', tool_use_id: 'u-wf', description: 'night', task_type: 'local_workflow', workflow_name: 'ночная сборка' });
  const agents = [
    { index: 0, label: 'Сбор объявлений', phase: 'Сбор', agentId: 'a0', model: 'haiku', state: 'done', resultPreview: '212 объявлений' },
    { index: 1, label: 'скептик данных', phase: 'Проверка', agentId: 'a1', model: 'sonnet', state: 'running', lastToolName: 'Grep', lastToolSummary: 'кадастровые номера', tokens: 61800, toolCalls: 37 },
    { index: 2, label: 'Выкладка', phase: 'Выкладка', state: 'queued' },
  ];
  sdk(
    { type: 'system', subtype: 'task_progress', task_id: 't-wf', tool_use_id: 'u-wf', description: 'night', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, workflow_progress: [] },
    [{ kind: 'task_status', taskId: 't-wf', agents }],
  );

  assert.equal(agent('u-wf').kind, 'workflow');
  assert.equal(agent('u-wf').name, 'ночная сборка');
  assert.equal(agent('u-wf:0').state, 'done');
  assert.equal(agent('u-wf:0').summary, '212 объявлений');
  assert.equal(agent('u-wf:1').state, 'tool');
  assert.equal(agent('u-wf:1').currentAction, 'Grep кадастровые номера');
  assert.equal(agent('u-wf:1').parentId, 'u-wf');
  assert.equal(agent('u-wf:1').canStop, false, 'a workflow agent is stopped with its workflow');
  assert.equal(agent('u-wf:2').state, 'pending');
  assert.deepEqual(session().workflows[0].phases.map((phase) => [phase.title, phase.state]), [
    ['Сбор', 'done'],
    ['Проверка', 'running'],
    ['Выкладка', 'queued'],
  ]);
});

test('deltas carry only what changed since the previous one', () => {
  const { sdk, start, aggregator } = setup();
  start();
  const first = aggregator.takeDelta();
  assert.equal(first?.sessions.length, 1);
  assert.equal(first?.feed[0].text, 'новый ход');
  assert.equal(aggregator.takeDelta(), null);
  sdk(assistant([toolUse('u-ws', 'WebSearch', { query: 'участки Арамиль ИЖС' })]));
  const second = aggregator.takeDelta();
  assert.equal(second?.sessions[0].orchestrator.currentAction, 'WebSearch участки Арамиль ИЖС');
  assert.ok((second?.seq ?? 0) > (first?.seq ?? 0));
  assert.deepEqual(second?.feed.map((event) => event.kind), ['tool']);
});

test('tool calls read as one human line', () => {
  assert.equal(summarizeToolCall('Read', { file_path: '/srv/p/server/a.ts' }, '/srv/p'), 'server/a.ts');
  assert.equal(summarizeToolCall('Bash', { command: 'npm test\n  --watch' }), 'npm test --watch');
  assert.equal(summarizeToolCall('Grep', { pattern: 'TODO' }), '«TODO»');
  assert.equal(summarizeToolCall('Agent', { description: 'Аудит', subagent_type: 'Explore' }), 'Аудит (Explore)');
  assert.equal(summarizeToolCall('mcp__tilda__get_pages', { url: 'x' }), 'x');
  assert.ok(summarizeToolCall('Bash', { command: 'x'.repeat(500) }).length <= 140);
});

test('the orchestrator counts what Claude wrote in the run, once per API message', () => {
  const { sdk, start, agent } = setup();
  start();
  assert.equal(agent('main').outputTokens, null, 'nothing written yet');
  const usage = (output: number) => ({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: output });
  const say = (id: string, content: unknown[], output: number, parent: string | null = null) => sdk({
    type: 'assistant', parent_tool_use_id: parent,
    message: { id, model: 'claude-opus-4-8', role: 'assistant', content, usage: usage(output) },
  });
  // One API message streamed as two content blocks: the usage repeats (and grows), it is not added twice.
  say('m-1', [{ type: 'text', text: 'Смотрю' }], 40);
  say('m-1', [toolUse('u-1', 'Read', { file_path: `${PROJECT}/a.ts` })], 120);
  say('m-2', [{ type: 'text', text: 'Готово' }], 30);
  // A subagent's writing is its own.
  say('m-sub', [{ type: 'text', text: 'x' }], 999, 'u-1');
  assert.equal(agent('main').outputTokens, 150);

  // The stream reports a message's usage before it is written out: the text itself counts
  // (about four characters a token, as Claude Code's spinner estimates).
  say('m-3', [{ type: 'text', text: 'x'.repeat(400) }], 2);
  assert.equal(agent('main').outputTokens, 250);

  // A new run starts from zero.
  start();
  assert.equal(agent('main').outputTokens, null);
});

test('an end time out of the Date range from the CLI does not break snapshots and deltas', () => {
  const { sdk, start, agent, aggregator, clock } = setup();
  start();
  sdk(assistant([toolUse('u-bash', 'Bash', { command: 'sleep 1', run_in_background: true })]));
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-bash', tool_use_id: 'u-bash', description: 'sleep 1', task_type: 'local_bash', is_backgrounded: true });
  clock.advance(1000);
  aggregator.takeDelta();
  for (const endTime of [9e15, -9e15, 1e300]) {
    sdk({ type: 'system', subtype: 'task_updated', task_id: 't-bash', patch: { status: 'completed', end_time: endTime } });
    assert.doesNotThrow(() => aggregator.takeDelta());
    assert.doesNotThrow(() => aggregator.snapshot());
    assert.equal(agent('u-bash').endedAt, new Date(clock.now()).toISOString());
  }
  // A sane end time from the CLI is still taken.
  const reported = clock.now() - 500;
  sdk({ type: 'system', subtype: 'task_updated', task_id: 't-bash', patch: { status: 'completed', end_time: reported } });
  assert.equal(agent('u-bash').endedAt, new Date(reported).toISOString());
});

test('tool-call and task lookups do not grow for the life of a long session', () => {
  const { sdk, start, agent, aggregator } = setup();
  const counts = () => aggregator.debugCounts(SESSION)!;
  start();

  // The orchestrator's own tool calls are forgotten once answered.
  for (let index = 0; index < 50; index += 1) {
    sdk(assistant([toolUse(`u-read-${index}`, 'Read', { file_path: `${PROJECT}/f${index}.ts` })]));
    sdk(toolResult(`u-read-${index}`));
  }
  assert.equal(counts().toolUseOwner, 0);

  // A subagent's calls are kept while it works (its permission prompts need them), then dropped.
  sdk(assistant([toolUse('u-agent', 'Agent', { description: 'Скептик', prompt: 'проверь' })]));
  sdk({ type: 'system', subtype: 'task_started', task_id: 't-agent', tool_use_id: 'u-agent', description: 'Скептик', task_type: 'local_agent' });
  sdk(assistant([toolUse('u-sub-1', 'Bash', { command: 'npm test' })], 'u-agent'));
  aggregator.apply({
    type: 'permission_requested', provider: 'claude', sessionId: SESSION, runId: RUN, requestId: 'perm-1',
    toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'u-sub-1', agentId: null, at: Date.parse('2026-10-26T14:30:00Z'),
  });
  assert.equal(agent('u-agent').state, 'waiting', 'the prompt is still found on the subagent');
  sdk(toolResult('u-sub-1', 'u-agent'));
  sdk(toolResult('u-agent'));
  assert.equal(agent('u-agent').state, 'done');
  assert.equal(counts().toolUseOwner, 0);

  // Task ids of agents dropped past the per-session cap go with them.
  for (let index = 0; index < 120; index += 1) {
    sdk(assistant([toolUse(`u-bg-${index}`, 'Bash', { command: `sleep ${index}`, run_in_background: true })]));
    sdk({ type: 'system', subtype: 'task_started', task_id: `t-bg-${index}`, tool_use_id: `u-bg-${index}`, description: 'sleep', task_type: 'local_bash', is_backgrounded: true });
    sdk(toolResult(`u-bg-${index}`));
    sdk({ type: 'system', subtype: 'task_notification', task_id: `t-bg-${index}`, status: 'completed', summary: 'ok', output_file: '' });
  }
  assert.ok(counts().taskToNode <= counts().nodes, JSON.stringify(counts()));
  assert.equal(counts().toolUseOwner, 0);

  // A new process starts with empty lookups.
  aggregator.apply({ type: 'run_ended', provider: 'claude', sessionId: SESSION, runId: RUN, reason: 'completed', at: 0 });
  start();
  assert.deepEqual({ ...counts(), nodes: 0 }, { toolUseOwner: 0, taskToNode: 0, nodes: 0 });
});

// Keeps the event union exhaustive in this file's fixtures.
void ((event: ProviderRuntimeEvent) => event.type);
