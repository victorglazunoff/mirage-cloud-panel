import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readSessionIdParam } from '@/modules/context-usage/context-usage.routes.js';
import {
  contextWindowFor,
  createContextUsageService,
  inferContextWindow,
  mapLiveContextUsage,
  scanClaudeTranscript,
  splitFilePath,
} from '@/modules/context-usage/services/context-usage.service.js';
import type { LiveContextUsageReading } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const SESSION = 'ctx-session';

const LIVE_READING: LiveContextUsageReading = {
  detail: 'full',
  usage: {
    categories: [
      { id: 'messages', name: 'Messages', tokens: 96400, color: 'claude', kind: 'used' },
      { id: 'mcp_tools', name: 'MCP tools', tokens: 31200, color: 'warning', kind: 'used' },
      { id: 'skills', name: 'Skills', tokens: 9800, color: 'x', kind: 'used' },
      { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33000, color: 'y', kind: 'buffer' },
      { name: 'Free space', tokens: 829600, color: 'z', kind: 'free' },
    ],
    totalTokens: 137400,
    maxTokens: 1000000,
    rawMaxTokens: 1000000,
    percentage: 13.7,
    model: 'claude-opus-4-8',
    memoryFiles: [{ path: '/root/.claude/CLAUDE.md', type: 'User', tokens: 2100 }],
    mcpTools: [
      { name: 'mcp__tilda__get_pages', serverName: 'tilda', tokens: 9000, isLoaded: true },
      { name: 'mcp__tilda__add_record', serverName: 'tilda', tokens: 3400 },
      { name: 'mcp__telegram__post', serverName: 'telegram', tokens: 8100, isLoaded: false },
    ],
    agents: [{ agentType: 'code-reviewer', source: 'user', tokens: 400 }],
    skills: { totalSkills: 2, includedSkills: 2, tokens: 9800, skillFrontmatter: [
      { name: 'seo', source: 'user', tokens: 2100 },
      { name: 'frontend-design', source: 'user', tokens: 2600 },
    ] },
    autoCompactThreshold: 906400,
    isAutoCompactEnabled: true,
    messageBreakdown: { toolCallTokens: 1, toolResultTokens: 2, attachmentTokens: 3, assistantMessageTokens: 4, userMessageTokens: 5 },
    apiUsage: null,
  },
};

test('the live breakdown maps onto the sidebar contract', () => {
  const mapped = mapLiveContextUsage(SESSION, LIVE_READING);
  assert.equal(mapped.source, 'live');
  assert.equal(mapped.estimated, false);
  assert.equal(mapped.tokensUntilAutoCompact, 906400 - 137400);
  assert.equal(mapped.categories[0].percentage, 9.6);
  assert.equal(mapped.categories[4].id, 'free_space', 'a category without id gets a slug of its name');
  assert.deepEqual(mapped.categories[1].items, [{ name: 'tilda', tokens: 12400 }, { name: 'telegram', tokens: 8100 }]);
  assert.deepEqual(mapped.categories[2].items.map((item) => item.name), ['frontend-design', 'seo']);
  assert.equal(mapped.heavyMcpTools[0].name, 'mcp__tilda__get_pages');
  assert.equal(mapped.heavyMcpTools[1].isLoaded, false);
  assert.equal(mapped.heavySkills[0].name, 'frontend-design');
  assert.equal(mapped.memoryFiles[0].tokens, 2100);
  assert.equal(mapped.agents[0].agentType, 'code-reviewer');
  assert.equal(mapped.messageBreakdown?.userMessageTokens, 5);
});

test('the transcript scan counts each assistant message once and lists files read since the last compaction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctx-scan-'));
  try {
    const file = path.join(directory, 's.jsonl');
    const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 };
    const rows = [
      { type: 'assistant', message: { id: 'm0', model: 'claude', content: [{ type: 'tool_use', id: 'r0', name: 'Read', input: { file_path: '/p/old.md' } }], usage } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r0', content: 'x'.repeat(400) }] } },
      { type: 'system', subtype: 'compact_boundary' },
      // Two streamed rows of one message share its usage.
      { type: 'assistant', message: { id: 'm1', model: 'claude', content: [{ type: 'text', text: 'hi' }], usage } },
      { type: 'assistant', message: { id: 'm1', model: 'claude', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/data/villages.json' } }], usage } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: [{ type: 'text', text: 'y'.repeat(8000) }] }] } },
      // A subagent's rows are not the conversation's.
      { type: 'assistant', isSidechain: true, message: { id: 'm2', model: 'claude', content: [], usage } },
      'not json',
    ];
    await writeFile(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n'));
    const scan = await scanClaudeTranscript(file, '/p');
    assert.deepEqual(scan?.totals, { inputTokens: 20, outputTokens: 200, cacheReadTokens: 2000, cacheCreationTokens: 10, assistantTurns: 2 });
    assert.deepEqual(scan?.files, [{ path: '/p/data/villages.json', dir: 'data/', name: 'villages.json', tokens: 2000 }]);
    assert.equal(scan?.model, 'claude');
    assert.equal(await scanClaudeTranscript(path.join(directory, 'missing.jsonl'), null), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function setup(options: {
  live?: LiveContextUsageReading | null;
  queued?: Array<{ userId: number; content: string }>;
  processing?: boolean;
  model?: string | null;
  reported?: number | null;
} = {}) {
  let now = 1_000_000;
  const queue = [...(options.queued ?? [])];
  const calls = { live: 0, dispatch: 0, appended: [] as string[], cleared: 0 };
  const service = createContextUsageService({
    now: () => now,
    getSession: (sessionId) => (sessionId === SESSION
      ? { session_id: SESSION, provider: 'claude', project_path: '/p', jsonl_path: '/p/s.jsonl', provider_session_id: 'n' } as never
      : null),
    getLiveContextUsage: async () => { calls.live += 1; return options.live ?? null; },
    estimateTokenUsage: async () => ({ used: 50000, total: 200000 }),
    getLiveCostUsd: () => (options.live ? 0.37 : null),
    getReportedContextWindow: () => options.reported ?? null,
    resolveTranscriptPath: () => '/p/s.jsonl',
    scanTranscript: async () => ({
      totals: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, assistantTurns: 5 },
      files: [{ path: '/p/a.ts', dir: '', name: 'a.ts', tokens: 10 }],
      model: options.model ?? null,
    }),
    listQueuedFor: () => queue,
    appendQueuedMessage: (userId, _sessionId, content) => {
      if (queue.length > 0) return false;
      queue.push({ userId, content });
      calls.appended.push(content);
      return true;
    },
    clearQueuedMessage: () => { queue.length = 0; calls.cleared += 1; },
    isSessionProcessing: () => options.processing ?? false,
    dispatchQueue: () => { calls.dispatch += 1; },
  });
  return { service, calls, advance: (ms: number) => { now += ms; } };
}

test('a live session answers from the process, with files and cost, cached for 10 s', async () => {
  const { service, calls, advance } = setup({ live: LIVE_READING });
  const first = await service.getContextUsage(SESSION);
  assert.equal(first.source, 'live');
  assert.equal(first.detail, 'full');
  assert.equal(first.files[0].name, 'a.ts');
  assert.equal(first.session.costUsd, 0.37);
  assert.equal(first.session.assistantTurns, 5);
  await service.getContextUsage(SESSION);
  assert.equal(calls.live, 1, 'served from the cache');
  advance(10_001);
  await service.getContextUsage(SESSION);
  assert.equal(calls.live, 2);
  await service.getContextUsage(SESSION, { fresh: true });
  assert.equal(calls.live, 3);
});

test('without a live process the context is estimated from the transcript', async () => {
  const { service } = setup({ live: null });
  const usage = await service.getContextUsage(SESSION);
  assert.equal(usage.source, 'transcript');
  assert.equal(usage.estimated, true);
  assert.equal(usage.totalTokens, 50000);
  assert.equal(usage.percentage, 25);
  assert.deepEqual(usage.categories.map((category) => [category.id, category.tokens]), [['messages', 50000], ['free_space', 150000]]);
  assert.equal(usage.session.costUsd, null);
  await assert.rejects(service.getContextUsage('unknown'), (error: unknown) => error instanceof AppError && error.statusCode === 404);
});

test('a Haiku 4.5 transcript reads against a 200k window, not the 160k default nor 1M', async () => {
  const { service } = setup({ live: null, model: 'claude-haiku-4-5-20251001' });
  const usage = await service.getContextUsage(SESSION);
  assert.equal(usage.maxTokens, 200_000);
  assert.equal(usage.estimated, false);
  assert.equal(usage.model, 'claude-haiku-4-5-20251001');
});

test('the window the SDK reported wins over the model guess and is not an estimate', async () => {
  const { service } = setup({ live: null, model: 'claude-opus-4-7', reported: 1_000_000 });
  const usage = await service.getContextUsage(SESSION);
  assert.equal(usage.maxTokens, 1_000_000);
  assert.equal(usage.percentage, 5);
  assert.equal(usage.estimated, false);
});

test('contextWindowFor: reported, [1m], Haiku, other Claude models, unknown', () => {
  assert.deepEqual(contextWindowFor('claude-opus-4-7', 50_000, 160_000, 1_000_000), { maxTokens: 1_000_000, known: true });
  assert.deepEqual(contextWindowFor('claude-sonnet-4-6[1m]', 50_000, 160_000, null), { maxTokens: 1_000_000, known: true });
  assert.deepEqual(contextWindowFor('claude-haiku-4-5', 60_900, 160_000, null), { maxTokens: 200_000, known: true });
  // A newer Haiku states its own window: without a report it is a guess, the report wins.
  assert.deepEqual(contextWindowFor('claude-haiku-5-5', 60_900, 160_000, null), { maxTokens: 200_000, known: false });
  assert.deepEqual(contextWindowFor('claude-haiku-5-5', 60_900, 160_000, 1_000_000), { maxTokens: 1_000_000, known: true });
  assert.deepEqual(contextWindowFor('claude-opus-4-7', 60_000, 160_000, null), { maxTokens: 200_000, known: false });
  assert.deepEqual(contextWindowFor('claude-opus-4-7', 242_000, 160_000, null), { maxTokens: 1_000_000, known: false });
  assert.deepEqual(contextWindowFor(null, 120_000, 160_000, null), { maxTokens: 160_000, known: false });
});

test('files outside the project are shown short: ~ for home, the last folders after …/', () => {
  assert.deepEqual(splitFilePath('/p/site/core.py', '/p', '/root'), { dir: 'site/', name: 'core.py' });
  assert.deepEqual(splitFilePath('/root/.claude/notes.md', '/p', '/root'), { dir: '~/.claude/', name: 'notes.md' });
  assert.deepEqual(
    splitFilePath('/tmp/claude-0/-root/2608d09c/tasks/b5homg50j.output', '/p', '/root'),
    { dir: '…/tasks/', name: 'b5homg50j.output' },
  );
  assert.deepEqual(splitFilePath('/tmp/v66look/zap3_c.jpg', '/p', '/root'), { dir: '/tmp/v66look/', name: 'zap3_c.jpg' });
});

test('compact is queued after the turn through the message queue and can be taken back', async () => {
  const busy = setup({ processing: true });
  assert.deepEqual(busy.service.queueCompact(7, SESSION), { queued: true, dispatchedNow: false });
  assert.deepEqual(busy.calls.appended, ['/compact']);
  assert.equal(busy.calls.dispatch, 1);
  // Queuing twice is harmless.
  busy.service.queueCompact(7, SESSION);
  assert.deepEqual(busy.calls.appended, ['/compact']);
  assert.equal((await busy.service.getContextUsage(SESSION)).compactQueued, true);
  assert.deepEqual(busy.service.cancelCompact(7, SESSION), { queued: false, dispatchedNow: false });
  assert.equal(busy.calls.cleared, 1);

  const idle = setup();
  assert.equal(idle.service.queueCompact(7, SESSION).dispatchedNow, true);

  const occupied = setup({ queued: [{ userId: 7, content: 'проверь цены' }] });
  assert.throws(() => occupied.service.queueCompact(7, SESSION), (error: unknown) => error instanceof AppError && error.statusCode === 409);
  occupied.service.cancelCompact(7, SESSION);
  assert.equal(occupied.calls.cleared, 0, 'someone else\'s queued message is left alone');
});

test('the session id path segment is validated', () => {
  assert.equal(readSessionIdParam(' abc '), 'abc');
  assert.throws(() => readSessionIdParam(''), AppError);
  assert.throws(() => readSessionIdParam('x'.repeat(201)), AppError);
});

test('inferContextWindow keeps the configured window unless the reading overflows it', () => {
  assert.equal(inferContextWindow(120_000, 160_000), 160_000);
  assert.equal(inferContextWindow(180_000, 160_000), 200_000);
  assert.equal(inferContextWindow(242_000, 160_000), 1_000_000);
  assert.equal(inferContextWindow(0, undefined), 0);
});

test('the transcript size is one stat of the session file; no file or another provider answers null', async () => {
  const sessions: Record<string, unknown> = {
    big: { session_id: 'big', provider: 'claude', project_path: '/p', jsonl_path: '/p/big.jsonl' },
    fresh: { session_id: 'fresh', provider: 'claude', project_path: '/p', jsonl_path: '/p/fresh.jsonl' },
    codex: { session_id: 'codex', provider: 'codex', project_path: '/p', jsonl_path: '/p/codex.jsonl' },
  };
  const statted: string[] = [];
  const service = createContextUsageService({
    getSession: (sessionId) => (sessions[sessionId] as never) ?? null,
    resolveTranscriptPath: (session) => session.jsonl_path ?? null,
    statFile: async (filePath) => {
      statted.push(filePath);
      return filePath === '/p/big.jsonl' ? { size: 340 * 1024 * 1024, mtimeMs: Date.UTC(2026, 9, 26, 9, 30) } : null;
    },
  });

  assert.deepEqual(await service.getTranscriptSize('big'), {
    sessionId: 'big',
    bytes: 340 * 1024 * 1024,
    modifiedAt: '2026-10-26T09:30:00.000Z',
  });
  assert.deepEqual(await service.getTranscriptSize('fresh'), { sessionId: 'fresh', bytes: null, modifiedAt: null });
  assert.deepEqual(await service.getTranscriptSize('codex'), { sessionId: 'codex', bytes: null, modifiedAt: null });
  assert.deepEqual(statted, ['/p/big.jsonl', '/p/fresh.jsonl'], 'a non-Claude session is not read');
  await assert.rejects(service.getTranscriptSize('missing'), (error: unknown) => error instanceof AppError && error.statusCode === 404);
});
