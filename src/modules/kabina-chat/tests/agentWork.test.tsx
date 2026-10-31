import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, test } from 'vitest';

import { browserTimeZone, setPanelTimeZone } from '@/modules/kabina';
import ChatStatusLine from '@/modules/kabina-chat/ChatStatusLine';
import { AgentCard, TodoCard } from '@/modules/kabina-chat/ChatWork';
import { agentMetaLine, backgroundWork, describeAgent, describeTurnActivity, formatWorkTime } from '@/modules/kabina-chat/utils/agentWork';
import { buildChatFeed, describeStepResult } from '@/modules/kabina-chat/utils/chatFeed';
import type { ChatMessage, LiveAgentNode } from '@/shared/types';

/** The turn's work as in Claude Code: subagent cards, the TodoWrite plan, the ✻ line, background jobs. */

const T = (minute: number, second = 0) => new Date(2026, 9, 27, 14, minute, second).toISOString();

beforeAll(() => setPanelTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
afterAll(() => setPanelTimeZone(browserTimeZone()));
afterEach(cleanup);

function tool(toolName: string, toolInput: unknown, toolResult: ChatMessage['toolResult'], minute: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    type: 'assistant', isToolUse: true, toolName, toolInput: JSON.stringify(toolInput), toolResult,
    toolId: `${toolName}-${minute}`, timestamp: T(minute), ...extra,
  };
}

const todos = (...states: Array<'pending' | 'in_progress' | 'completed'>) => ({
  todos: states.map((status, index) => ({ content: `Пункт ${index + 1}`, activeForm: `Делаю пункт ${index + 1}`, status })),
});

const AGENT_DONE = tool('Agent', { description: 'Обзор файлов', subagent_type: 'general-purpose', model: 'haiku', prompt: '…' }, {
  content: 'ok',
  toolUseResult: {
    status: 'completed', resolvedModel: 'claude-haiku-5-5', totalDurationMs: 42_000, totalTokens: 12_400, totalToolUseCount: 6,
    handbackReport: { text: 'Прочитал README.md — первое значимое: «Мираж».\nДальше детали.' },
  },
}, 12, {
  subagent: { id: 'a1', status: 'completed', description: 'Обзор файлов', activityCount: 6 },
  subagentActivity: [
    { kind: 'tool', toolId: 's1', toolName: 'Bash', toolInput: { command: 'ls -la' }, toolResult: { content: 'a\nb', isError: false } },
    { kind: 'text', content: 'думаю' },
    { kind: 'tool', toolId: 's2', toolName: 'Read', toolInput: { file_path: '/repo/README.md' }, toolResult: { content: '1\n2\n3', isError: false } },
  ],
});

test('feed: a subagent is its own card between journals, the plan one card with its latest state', () => {
  const messages: ChatMessage[] = [
    { type: 'user', content: 'План, агент и фон', timestamp: T(10) },
    tool('TodoWrite', todos('in_progress', 'pending', 'pending'), { content: 'ok' }, 10),
    tool('Read', { file_path: '/repo/a.ts' }, { content: 'x' }, 11),
    AGENT_DONE,
    tool('TodoWrite', todos('completed', 'in_progress', 'pending'), { content: 'ok' }, 13),
    tool('Bash', { command: 'sleep 20', run_in_background: true }, { content: 'Command running in background with ID: b1' }, 14),
  ];
  const feed = buildChatFeed(messages, Date.parse(T(15)));
  assert.deepEqual(feed.items.map((item) => item.kind), ['user', 'todos', 'journal', 'agent', 'journal']);
  const plan = feed.items[1];
  assert.ok(plan.kind === 'todos');
  assert.deepEqual(plan.items.map((item) => item.status), ['completed', 'in_progress', 'pending'], 'latest state, first place');
  assert.equal(plan.updates, 2);
  assert.deepEqual(feed.turnTodos?.map((item) => item.status), ['completed', 'in_progress', 'pending']);
  // Every call is still a step of the turn: 2 plans + Read + agent + Bash.
  assert.equal(feed.lastTurnSteps, 5);

  // A new turn starts without a plan.
  const next = buildChatFeed([...messages, { type: 'user', content: 'Дальше', timestamp: T(20) }], Date.parse(T(21)));
  assert.equal(next.turnTodos, null);
});

test('feed: the newer TaskCreate / TaskUpdate plan is kept item by item, across turns', () => {
  const create = (subject: string, minute: number, id: string) => tool('TaskCreate', { subject, description: subject, activeForm: `${subject}…` }, {
    content: `Task #${id} created successfully: ${subject}`, toolUseResult: { task: { id, subject } },
  }, minute, { toolId: `create-${id}` });
  const update = (taskId: string, status: string, minute: number) => tool('TaskUpdate', { taskId, status }, { content: 'ok' }, minute, { toolId: `update-${taskId}-${status}` });
  const turnOne: ChatMessage[] = [
    { type: 'user', content: 'План', timestamp: T(10) },
    create('Фон', 10, '1'),
    create('Агент', 10, '2'),
    // A create whose result has not come yet: numbered next.
    tool('TaskCreate', { subject: 'Итог' }, null, 10, { toolId: 'create-pending' }),
    update('1', 'in_progress', 11),
    tool('TaskGet', { taskId: '1' }, { content: '…' }, 11, { toolId: 'get-1' }),
  ];
  const first = buildChatFeed(turnOne, Date.parse(T(12)));
  assert.deepEqual(first.items.map((item) => item.kind), ['user', 'todos']);
  assert.deepEqual(first.turnTodos?.map((item) => `${item.id}:${item.content}:${item.status}`), ['1:Фон:in_progress', '2:Агент:pending', '3:Итог:pending']);
  assert.equal(first.lastTurnSteps, 5, 'plan calls are steps of the turn');

  // The next turn updates tasks created in the first one and shows its own card.
  const second = buildChatFeed([
    ...turnOne,
    { type: 'user', content: 'Дальше', timestamp: T(20) },
    update('1', 'completed', 21),
    update('2', 'deleted', 21),
  ], Date.parse(T(22)));
  const cards = second.items.filter((item) => item.kind === 'todos');
  assert.equal(cards.length, 2);
  assert.deepEqual(second.turnTodos?.map((item) => `${item.id}:${item.status}`), ['1:completed', '3:pending']);
});

test('a finished subagent reads its totals, model and report from the transcript', () => {
  const view = describeAgent(AGENT_DONE, Date.parse(T(30)));
  assert.equal(view.name, 'Обзор файлов');
  assert.equal(view.agentType, null, 'general-purpose is not worth a word');
  assert.equal(view.model, 'haiku');
  assert.equal(view.state, 'done');
  assert.equal(view.summary, 'Прочитал README.md — первое значимое: «Мираж».');
  assert.equal(agentMetaLine(view), '6 вызовов · 12.4k ток. · 42 с');
  assert.deepEqual(view.steps.map((step) => `${step.tool} ${step.arg} ${step.res}`), ['Bash ls -la ok', 'Read repo/README.md 3 стр.']);
  assert.equal(view.current, null);
});

test('a running subagent follows the live tree: current call, calls, tokens, time ticking on', () => {
  const running = tool('Agent', { description: 'Сбор цен', subagent_type: 'Explore', prompt: '…' }, null, 12);
  const node = {
    id: 'Agent-12', kind: 'subagent', toolUseId: 'Agent-12', state: 'tool', currentAction: 'Bash curl -s example.com',
    toolCalls: 3, tokens: 5_100, durationMs: 20_000, model: 'claude-sonnet-5', backgrounded: false, summary: null, error: null,
  } as unknown as LiveAgentNode;
  const receivedAt = Date.parse(T(13));
  const view = describeAgent(running, receivedAt + 5_000, { node, receivedAt });
  assert.equal(view.state, 'run');
  assert.equal(view.agentType, 'Explore');
  assert.equal(view.model, 'sonnet');
  assert.equal(view.current, 'Bash curl -s example.com');
  assert.equal(agentMetaLine(view), '3 вызова · 5.1k ток. · 25 с');

  // Without the live tree: the last call of its timeline, time from the launch.
  const offline = describeAgent({ ...running, subagentActivity: [{ kind: 'tool', toolName: 'Grep', toolInput: { pattern: 'цена' } }] }, Date.parse(T(13)));
  assert.equal(offline.current, 'Grep «цена»');
  assert.equal(offline.durationMs, 60_000);

  // Interrupted by the user: stopped, said so.
  const cut = describeAgent(tool('Agent', { description: 'x' }, { content: '[Request interrupted by user for tool use]', isError: true }, 12), Date.parse(T(13)));
  assert.equal(cut.state, 'stopped');
  assert.equal(cut.summary, 'прерван до ответа');
});

test('a background command is «в фоне» while it runs and «фон: готово» when it reported', () => {
  const launched = tool('Bash', { command: 'sleep 20', run_in_background: true }, { content: 'Command running in background with ID: b1' }, 14, {
    taskStatus: { status: 'running', taskId: 'b1', taskType: 'local_bash' },
  });
  assert.deepEqual(describeStepResult(launched, Date.parse(T(14, 12))), { res: 'в фоне 0:12', tone: 'run' });
  const done = { ...launched, taskStatus: undefined, toolResult: { content: 'Background command "sleep" completed (exit code 0)' } };
  assert.deepEqual(describeStepResult(done, Date.parse(T(15))), { res: 'фон: готово', tone: 'ok' });

  assert.deepEqual(backgroundWork([
    { taskId: 'b1', toolUseId: 'u1', taskType: 'local_bash', description: 'sleep 20', startedAt: 1_000 },
    { taskId: 'n1', toolUseId: 'u2', taskType: 'local_agent', description: 'вложенный', startedAt: 1_000, nested: true },
  ], 13_000), [{ key: 'b1', label: 'Bash sleep 20', elapsedMs: 12_000 }]);
  assert.equal(formatWorkTime(192_000), '3:12');
});

test('the ✻ line says what the turn does now', () => {
  const now = Date.parse(T(15));
  const base = { waits: false, mainAction: null, now, live: () => null };
  const running = buildChatFeed([
    { type: 'user', content: 'go', timestamp: T(10) },
    tool('Bash', { command: 'npm test' }, null, 11),
  ], now).items;
  assert.equal(describeTurnActivity(running, base), 'Bash npm test');
  assert.equal(describeTurnActivity(running, { ...base, waits: true }), 'ждёт твоего решения');

  const writing = buildChatFeed([
    { type: 'user', content: 'go', timestamp: T(10) },
    { type: 'assistant', content: 'Пишу…', isStreaming: true, timestamp: T(11) },
  ], now).items;
  assert.equal(describeTurnActivity(writing, base), 'пишет ответ');

  const agent = buildChatFeed([
    { type: 'user', content: 'go', timestamp: T(10) },
    tool('Agent', { description: 'Сбор цен' }, null, 11, { subagentActivity: [{ kind: 'tool', toolName: 'Read', toolInput: { file_path: '/r/a.csv' } }] }),
  ], now).items;
  assert.equal(describeTurnActivity(agent, base), 'агент «Сбор цен» · Read r/a.csv');
  assert.equal(describeTurnActivity([], { ...base, mainAction: null }), 'думает');
});

test('cards: the subagent with ⎿ and its numbers; the plan folds and unfolds', () => {
  render(<AgentCard message={AGENT_DONE} live={null} now={Date.parse(T(30))} isPhone={false} />);
  assert.ok(screen.getByText('АГЕНТ'));
  assert.ok(screen.getByText('⎿'));
  assert.ok(screen.getByText(/6 вызовов · 12\.4k ток\. · 42 с/));
  const head = screen.getByRole('button', { name: /Субагент «Обзор файлов» — готово/ });
  fireEvent.click(head);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByText('ls -la'));

  cleanup();
  render(<TodoCard items={todos('completed', 'in_progress', 'pending').todos} live />);
  const plan = screen.getByRole('button', { name: /ПЛАН/ });
  assert.equal(plan.getAttribute('aria-expanded'), 'true');
  assert.match(plan.textContent ?? '', /1\/3/);
  // The current line speaks in its «doing» form while the turn is on it.
  assert.ok(screen.getByText('Делаю пункт 2'));
  fireEvent.click(plan);
  assert.equal(plan.getAttribute('aria-expanded'), 'false');
  assert.match(plan.textContent ?? '', /Делаю пункт 2/);
});

test('the turn line: ✻ activity with time and tokens, the «план / фон» chip opens the list', () => {
  render(
    <MemoryRouter>
      <ChatStatusLine
        isPhone={false}
        compact={false}
        turn={{ running: true, elapsed: '00:12', steps: 3, statusText: '· работает', tone: 'run', activity: 'Bash sleep 20', activityMeta: '12 с · ↓ 1.2k ток.' }}
        queue={{ items: [], editItem: () => undefined, removeItem: () => undefined, moveItem: () => undefined }}
        onStop={() => undefined}
        when={null}
        notice={null}
        hint={null}
        agentsCount={0}
        clockInHud
        work={{ todos: todos('completed', 'in_progress', 'pending').todos, background: [{ key: 'b1', label: 'Bash sleep 20', elapsedMs: 12_000 }] }}
      />
    </MemoryRouter>,
  );
  const status = screen.getByRole('status');
  assert.match(status.textContent ?? '', /✻Bash sleep 20…\(12 с · ↓ 1\.2k ток\.\)/);
  const chip = screen.getByRole('button', { name: /План: сделано 1 из 3, в фоне: 1/ });
  fireEvent.click(chip);
  const list = screen.getByRole('dialog', { name: 'План и фоновая работа' });
  assert.match(list.textContent ?? '', /ПЛАН · 1\/3/);
  assert.match(list.textContent ?? '', /В ФОНЕ · 1.*Bash sleep 20.*12 с/);
});
