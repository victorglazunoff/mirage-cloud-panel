import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { CommandCatalogEntry, SearchDialogHit } from '@/shared/types.js';

import { createSearchRouter } from '../search.routes.js';
import { buildSnippet, createSearchService, parseSearchRequest, scoreNameMatch } from '../search.service.js';

const command = (name: string, description: string): CommandCatalogEntry => ({
  id: `builtin:${name}`, name, description, args: '', group: 'session', groupLabel: 'Сессия',
  shortcut: null, execution: 'sdk', panelAction: null, source: 'builtin', path: null,
});

function createService(overrides: { hits?: SearchDialogHit[]; files?: string[] | null; listFilesCalls?: string[] } = {}) {
  return createSearchService({
    listProjects: () => [
      { projectId: 'p1', path: '/work/mirage-panel', displayName: 'Мираж панель', isStarred: true },
      { projectId: 'p2', path: '/work/karta', displayName: 'Карта', isStarred: false },
    ],
    findSession: (id) => (id === 's-known'
      ? { sessionId: 'app-1', provider: 'claude', title: 'Починка поиска', projectPath: '/work/karta', lastActivity: '2026-10-25T08:00:00Z' }
      : null),
    getCatalog: async () => ({
      groups: [], count: 2,
      commands: [command('/compact', 'Сжать контекст'), command('/cost', 'Расход токенов')],
    }),
    searchDialogs: async () => ({ hits: overrides.hits ?? [], truncated: false }),
    listFiles: async (projectPath) => {
      overrides.listFilesCalls?.push(projectPath);
      return overrides.files === undefined ? ['src/search.ts', 'docs/readme.md', 'search'] : overrides.files;
    },
    now: Date.now,
  });
}

test('«показать лимиты» is offered only while the limits counter is on', async () => {
  const previous = process.env.MIRAGE_SUBSCRIPTION_LIMITS;
  const usageIds = async () => {
    const response = await createService().search(parseSearchRequest({ q: 'лимиты' }));
    return (response.groups.find((group) => group.type === 'action')?.items ?? []).map((item) => item.actionId);
  };
  try {
    delete process.env.MIRAGE_SUBSCRIPTION_LIMITS;
    assert.equal((await usageIds()).includes('show_usage'), false);
    process.env.MIRAGE_SUBSCRIPTION_LIMITS = '1';
    assert.equal((await usageIds()).includes('show_usage'), true);
  } finally {
    if (previous === undefined) delete process.env.MIRAGE_SUBSCRIPTION_LIMITS;
    else process.env.MIRAGE_SUBSCRIPTION_LIMITS = previous;
  }
});

test('scoreNameMatch ranks exact above prefix above word start above substring', () => {
  assert.equal(scoreNameMatch('Карта', 'карта'), 100);
  assert.equal(scoreNameMatch('Карта участков', 'карта'), 80);
  assert.equal(scoreNameMatch('Моя карта', 'карта'), 60);
  assert.equal(scoreNameMatch('Подкарта', 'карта'), 40);
  assert.equal(scoreNameMatch('Мираж', 'карта'), 0);
});

test('buildSnippet returns ~160 chars with match offsets, case-insensitive', () => {
  const text = `${'слово '.repeat(60)}ИСКОМОЕ значение ${'хвост '.repeat(60)}`;
  const snippet = buildSnippet(text, 'искомое');
  assert.ok(snippet);
  assert.ok(snippet.text.length <= 162);
  assert.equal(snippet.text.slice(snippet.matchStart, snippet.matchEnd), 'ИСКОМОЕ');
  assert.equal(buildSnippet('нет тут ничего', 'xyz'), null);
});

test('parseSearchRequest validates types and clamps the limit', () => {
  assert.deepEqual(parseSearchRequest({ q: '  привет ', types: 'file,bogus,session', limit: '999' }), {
    query: 'привет', types: ['file', 'session'], limit: 50,
  });
  assert.deepEqual(parseSearchRequest({}).types, ['project', 'session', 'file', 'command', 'action']);
  assert.equal(parseSearchRequest({ limit: '0' }).limit, 1);
});

test('search groups results with counters and ranks exact name first', async () => {
  const service = createService();
  const response = await service.search(parseSearchRequest({ q: 'карта' }));

  const projects = response.groups.find((group) => group.type === 'project')!;
  assert.equal(projects.count, 1);
  assert.equal(projects.items[0].title, 'Карта');
  const actions = response.groups.find((group) => group.type === 'action')!;
  assert.ok(actions.items.some((item) => item.title === 'Новый диалог в Карта' && item.projectId === 'p2'));
  assert.equal(response.total, response.groups.reduce((sum, group) => sum + group.count, 0));
});

test('files are matched by name, ranked exact first, and cached between calls', async () => {
  const calls: string[] = [];
  const service = createService({ listFilesCalls: calls });
  const first = await service.search(parseSearchRequest({ q: 'search', types: 'file' }));
  const items = first.groups[0].items;
  assert.equal(items[0].title, 'search');
  assert.equal(items[2].title, 'search.ts');
  assert.equal(items[0].path, '/work/mirage-panel/search');

  await service.search(parseSearchRequest({ q: 'readme', types: 'file' }));
  assert.equal(calls.length, 2, 'one listing per project, not per query');
});

test('a failed file listing marks the response as truncated instead of failing', async () => {
  const service = createService({ files: null });
  const response = await service.search(parseSearchRequest({ q: 'search', types: 'file' }));
  assert.equal(response.truncated, true);
  assert.equal(response.groups[0].count, 0);
});

test('dialog hits become one result per session with snippet, role, time and project', async () => {
  const hits: SearchDialogHit[] = [
    { providerSessionId: 's-known', filePath: '/a.jsonl', role: 'user', text: 'давай починим Поиск по диалогам', timestamp: '2026-10-20T10:00:00Z', cwd: null },
    { providerSessionId: 's-known', filePath: '/a.jsonl', role: 'assistant', text: 'Поиск готов', timestamp: '2026-10-21T10:00:00Z', cwd: null },
    { providerSessionId: 's-new', filePath: '/b.jsonl', role: 'assistant', text: 'другой поиск', timestamp: '2026-10-22T10:00:00Z', cwd: '/work/mirage-panel' },
    { providerSessionId: 's-escaped', filePath: '/c.jsonl', role: 'user', text: 'совсем другое', timestamp: null, cwd: null },
  ];
  const service = createService({ hits });
  const response = await service.search(parseSearchRequest({ q: 'поиск', types: 'session' }));
  const group = response.groups[0];

  assert.equal(group.count, 2);
  assert.equal(group.items[0].sessionId, 's-new');
  assert.equal(group.items[0].projectId, 'p1');
  assert.equal(group.items[1].sessionId, 'app-1');
  assert.equal(group.items[1].title, 'Починка поиска');
  assert.equal(group.items[1].role, 'assistant');
  assert.equal(group.items[1].projectName, 'Карта');
  const snippet = group.items[1].snippet!;
  assert.equal(snippet.text.slice(snippet.matchStart, snippet.matchEnd).toLowerCase(), 'поиск');
  // One date per dialog: the session's last activity, not the matching message's time.
  assert.equal(group.items[1].timestamp, '2026-10-21T10:00:00Z');
  assert.equal(group.items[1].lastActivity, '2026-10-25T08:00:00Z');
  // A transcript the panel does not know yet falls back to its newest matching message.
  assert.equal(group.items[0].lastActivity, '2026-10-22T10:00:00Z');
});

test('a leading slash searches only commands', async () => {
  const service = createService();
  const response = await service.search(parseSearchRequest({ q: '/co' }));
  const command = response.groups.find((group) => group.type === 'command')!;
  assert.deepEqual(command.items.map((item) => item.commandName), ['/cost', '/compact']);
  assert.equal(response.groups.find((group) => group.type === 'project')!.count, 0);
});

test('route returns JSON groups', async () => {
  const app = express();
  app.use('/search', createSearchRouter({ searchService: createService() }));
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/search?q=${encodeURIComponent('мираж')}&types=project&limit=3`;
    const body = await (await fetch(url)).json() as { groups: Array<{ type: string; count: number }> };
    assert.deepEqual(body.groups.map((group) => group.type), ['project']);
    assert.equal(body.groups[0].count, 1);
  } finally {
    server.close();
  }
});
