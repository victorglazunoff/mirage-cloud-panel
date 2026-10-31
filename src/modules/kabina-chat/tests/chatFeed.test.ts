import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'vitest';

import { browserTimeZone, setPanelTimeZone } from '@/modules/kabina';
import { buildChatFeed, describeStepArgument, describeStepResult, readApiError, summarizeSteps } from '@/modules/kabina-chat/utils/chatFeed';
import { formatMegabytes, formatPercent, formatSessionTime, formatTokens } from '@/modules/kabina-chat/utils/chatFormat';
import type { ChatMessage } from '@/shared/types';

const T = (minute: number) => new Date(2026, 9, 26, 14, minute).toISOString();

// Fixtures are local wall times; the feed shows the panel zone, set here to the machine's own.
beforeAll(() => setPanelTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
afterAll(() => setPanelTimeZone(browserTimeZone()));

function tool(toolName: string, toolInput: unknown, result: ChatMessage['toolResult'], minute = 9, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { type: 'assistant', isToolUse: true, toolName, toolInput, toolResult: result, toolId: `${toolName}-${minute}-${JSON.stringify(toolInput).length}`, timestamp: T(minute), ...extra };
}

test('a run of tool calls becomes one journal with numbered steps after the reply', () => {
  const messages: ChatMessage[] = [
    { type: 'user', content: 'Обнови цены', timestamp: T(5) },
    { type: 'assistant', content: 'Взял таблицу.', timestamp: T(9) },
    tool('Read', { file_path: '/home/user/demo-site/data/prices-oct.csv' }, { content: 'a\nb\nc' }),
    tool('Grep', { pattern: 'Берёзовая', path: 'data/villages.json' }, { content: 'x\ny' }),
    tool('Edit', { file_path: 'data/villages.json', old_string: 'a\nb', new_string: 'c\nd\ne' }, { content: 'ok' }),
  ];
  const { items, lastTurnSteps } = buildChatFeed(messages, Date.parse(T(10)));
  assert.deepEqual(items.map((item) => item.kind), ['user', 'assistant', 'journal']);
  const journal = items[2];
  assert.equal(journal.kind, 'journal');
  if (journal.kind !== 'journal') return;
  assert.deepEqual(journal.steps.map((step) => step.n), [1, 2, 3]);
  assert.equal(journal.steps[0].arg, 'demo-site/data/prices-oct.csv');
  assert.equal(journal.steps[0].res, '3 стр.');
  assert.equal(journal.steps[1].res, '2 совп.');
  assert.equal(journal.steps[2].res, '+3 −2');
  assert.equal(journal.steps[2].tone, 'ok');
  assert.equal(journal.total, '3 шага');
  assert.equal(journal.summary, 'Read prices-oct.csv · Grep «Берёзовая» · 1 правка');
  assert.equal(lastTurnSteps, 3);
});

test('a steered message carries the step it arrived at and does not restart the count', () => {
  const messages: ChatMessage[] = [
    { type: 'user', content: 'Старт', timestamp: T(1) },
    tool('Bash', { command: 'npm test' }, { content: 'ok' }, 2),
    tool('Bash', { command: 'npm run build' }, { content: 'ok' }, 3),
    { type: 'user', content: 'Не трогай «Сосновый берег»', steered: true, timestamp: T(4) },
    tool('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, null, 5),
  ];
  const { items, lastTurnSteps } = buildChatFeed(messages, Date.parse(T(6)));
  const steered = items.find((item) => item.kind === 'user' && item.steeredAtStep !== null);
  assert.ok(steered && steered.kind === 'user');
  assert.equal(steered.steeredAtStep, 2);
  assert.equal(lastTurnSteps, 3);
  const last = items[items.length - 1];
  assert.ok(last.kind === 'journal');
  assert.equal(last.total, 'идёт');
  assert.equal(last.steps[0].n, 3);
});

test('stopped turns, errors and artifacts get their own feed rows', () => {
  const messages: ChatMessage[] = [
    { type: 'user', content: 'Сделай сводку', timestamp: T(1) },
    tool('Artifact', { title: 'Сводка' }, { content: 'published' }, 2, {
      artifact: { artifactId: 'abc', title: 'Утренняя сводка', url: 'https://claude.ai/artifact/abc', version: 'v1' },
    }),
    { type: 'assistant', isTurnStopped: true, timestamp: T(3) },
    { type: 'error', content: 'Лимит', timestamp: T(4) },
  ];
  const { items } = buildChatFeed(messages);
  assert.deepEqual(items.map((item) => item.kind), ['user', 'journal', 'artifact', 'stopped', 'note']);
  const artifact = items[2];
  assert.ok(artifact.kind === 'artifact');
  assert.equal(artifact.artifact.title, 'Утренняя сводка');
});

test('step arguments and results read the common tools', () => {
  assert.equal(describeStepArgument(tool('Bash', { command: 'bash deploy.sh --prod\nsecond' }, null)), 'bash deploy.sh --prod');
  assert.equal(describeStepArgument(tool('Task', { description: 'сверить цены' }, null)), 'субагент · сверить цены');
  assert.deepEqual(describeStepResult(tool('Bash', {}, { content: 'boom', isError: true }), 0), { res: 'ошибка', tone: 'err' });
  const running = tool('Task', { description: 'x' }, null, 0);
  assert.equal(describeStepResult(running, Date.parse(T(1)) + 12_000).res, 'идёт 1:12');
  assert.equal(summarizeSteps([]), '');
});

test('chat number formats match the mock-up', () => {
  assert.equal(formatTokens(165_000), '165k');
  assert.equal(formatTokens(1_000_000), '1M');
  assert.equal(formatTokens(2_400_000), '2.4M');
  assert.equal(formatTokens(96_400), '96.4k');
  assert.equal(formatPercent(9.64), '9.6%');
  assert.equal(formatPercent(17.2), '17%');
  assert.equal(formatMegabytes(340 * 1024 * 1024), '340 МБ');
  const now = new Date(2026, 9, 26, 14, 32);
  assert.equal(formatSessionTime(new Date(2026, 9, 25, 19, 40).toISOString(), now), 'вчера 19:40');
  assert.equal(formatSessionTime(new Date(2026, 9, 18, 10, 0).toISOString(), now), '18 окт');
});

test('the stop mark knows the step, the files kept and the step it cut', () => {
  const messages: ChatMessage[] = [
    { type: 'user', content: 'Обнови цены', timestamp: T(1) },
    tool('Edit', { file_path: '/home/user/z/a.ts', old_string: 'a', new_string: 'b' }, { content: 'ok' }, 2),
    tool('Write', { file_path: '/home/user/z/b.ts', content: 'x' }, { content: 'ok' }, 3),
    tool('Edit', { file_path: '/home/user/z/a.ts', old_string: 'b', new_string: 'c' }, { content: 'ok' }, 4),
    tool('Bash', { command: 'npm run shots' }, { content: '[Request interrupted by user for tool use]', isError: true }, 5),
    { type: 'assistant', isTurnStopped: true, timestamp: T(6) },
  ];
  const { items } = buildChatFeed(messages);
  const mark = items[items.length - 1];
  assert.ok(mark.kind === 'stopped');
  assert.deepEqual(mark.stop, { step: 4, editedFiles: 2, interrupted: 'Bash npm run shots' });
  assert.equal(mark.at?.getMinutes(), 6);
});

test('API failures become E1 cards; a retry stays only until the reply resumes', () => {
  assert.equal(readApiError('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'), 529);
  assert.equal(readApiError('API Error: Request timed out.'), 'stream');
  assert.equal(readApiError('Claude Code is not installed'), null);

  const retry = { attempt: 2, maxRetries: 10, retryDelayMs: 20_000, errorStatus: 529, error: 'server_error' };
  const retrying: ChatMessage[] = [
    { type: 'user', content: 'Сверь цены', timestamp: T(1) },
    tool('Read', { file_path: 'a.csv' }, { content: 'x' }, 2),
    { type: 'assistant', content: '', apiRetry: retry, timestamp: T(3) },
  ];
  const live = buildChatFeed(retrying).items;
  const card = live[live.length - 1];
  assert.ok(card.kind === 'apiError');
  assert.equal(card.error, 529);
  assert.equal(card.savedStep, 1);
  assert.equal(card.retry?.attempt, 2);

  // The reply came back: the retry notice is gone.
  const resumed = buildChatFeed([...retrying, { type: 'assistant', content: 'Готово.', timestamp: T(4) }]).items;
  assert.deepEqual(resumed.map((item) => item.kind), ['user', 'journal', 'assistant']);

  // Retries ran out: the final «API Error» is the card; the dialog moving on folds it to a quiet line.
  const failed: ChatMessage[] = [...retrying, { type: 'assistant', content: 'API Error: 529 overloaded', timestamp: T(5) }];
  const last = buildChatFeed(failed).items.at(-1);
  assert.ok(last?.kind === 'apiError' && last.retry === null && last.error === 529);
  const later = buildChatFeed([...failed, { type: 'user', content: 'Ещё раз', timestamp: T(6) }]).items;
  const folded = later.find((item) => item.kind === 'note');
  assert.ok(folded && folded.kind === 'note');
  assert.equal(folded.text, 'Claude не ответил · API 529 · перегружен');
  assert.equal(later.filter((item) => item.kind === 'apiError').length, 0);
});
