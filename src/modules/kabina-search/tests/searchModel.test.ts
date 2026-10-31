import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'vitest';

import { setPanelTimeZone } from '@/modules/kabina';
import { setServerHomeDir } from '@/shared/utils';

// The fixtures are built from local fields, so the panel zone is the process zone here.
beforeAll(() => setPanelTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
// The fixture server runs as root: its home is /root (the server reports it in the settings view).
beforeAll(() => setServerHomeDir('/root'));
afterAll(() => setServerHomeDir(null));

import { clipAround, dialogAroundMatch, fileAroundMatch } from '@/modules/kabina-search/hooks/useSearchPreview';
import { pickAssistantProject } from '@/modules/kabina-search/hooks/useSearchRunner';
import { buildGroups, countLabel, scopeCount, shortProjectPath, shortWhen, shortenHome, toRow } from '@/modules/kabina-search/utils/searchModel';
import { splitMatch } from '@/shared/utils';
import type { SearchResponse, SearchResultItem } from '@/shared/types';

function hit(type: SearchResultItem['type'], id: string, title: string, extra: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    type, id, title, score: 10,
    subtitle: null, projectId: null, projectName: null, path: null, sessionId: null, provider: null,
    snippet: null, role: null, timestamp: null, commandName: null, actionId: null,
    ...extra,
  };
}

const RESPONSE: SearchResponse = {
  query: 'сайт',
  tookMs: 120,
  total: 9,
  truncated: false,
  groups: [
    { type: 'project', label: 'Проекты', count: 5, items: ['a', 'b', 'c', 'd', 'e'].map((id) => hit('project', id, `Сайт ${id}`, { projectId: id, path: `/root/${id}` })) },
    { type: 'session', label: 'Диалоги', count: 1, items: [hit('session', 's1', 'Редизайн', { sessionId: 's1', projectId: 'a', projectName: 'Сайт a', snippet: { text: '…новый сайт агентства', matchStart: 7, matchEnd: 11 } })] },
    { type: 'file', label: 'Файлы', count: 0, items: [] },
    { type: 'command', label: 'Команды', count: 0, items: [] },
    { type: 'action', label: 'Действия', count: 3, items: [hit('action', 'open_calendar', 'Открыть календарь', { actionId: 'open_calendar' })] },
  ],
};

const CONTEXT = { query: 'сайт', projectPaths: new Map([['a', '/root/a']]), liveByProject: new Map(), catalogById: new Map() };

test('«Всё» cuts each group to its limit, offers «ещё N» and always ends with «Спросить Claude»', () => {
  const groups = buildGroups(RESPONSE, 'all', CONTEXT);
  assert.deepEqual(groups.map((group) => group.id), ['project', 'session', 'action', 'ask']);
  assert.equal(groups[0].rows.length, 3);
  assert.equal(groups[0].more, 2);
  assert.equal(groups[2].more, 2, 'count from the server, not the items length');
  assert.equal(groups.at(-1)?.rows[0].title.before, 'Спросить Claude: «сайт»');
});

test('a single tab shows every returned row of its type', () => {
  const groups = buildGroups(RESPONSE, 'project', CONTEXT);
  assert.deepEqual(groups.map((group) => group.id), ['project', 'ask']);
  assert.equal(groups[0].rows.length, 5);
  assert.equal(scopeCount(RESPONSE, 'all'), 9);
  assert.equal(scopeCount(RESPONSE, 'file'), 0);
});

test('a dialog row keeps the server match offsets inside the quotes', () => {
  const row = toRow(RESPONSE.groups[1].items[0], CONTEXT);
  assert.deepEqual(row.sub, { before: '«…новый ', match: 'сайт', after: ' агентства»' });
  assert.equal(row.projectChip, 'Сайт a');
});

test('a dialog row is dated by the session\'s last activity, not by the matching message', () => {
  const now = new Date(2026, 9, 26, 14, 40);
  const item = hit('session', 's9', 'Задача demo-villa', {
    sessionId: 's9', timestamp: new Date(2026, 8, 11, 10, 0).toISOString(), lastActivity: new Date(2026, 9, 2, 18, 0).toISOString(),
  });
  assert.equal(toRow(item, CONTEXT).meta, shortWhen(item.lastActivity));
  assert.equal(shortWhen(item.lastActivity, now), '2 окт');
  assert.notEqual(shortWhen(item.timestamp, now), '2 окт');
  // An item from an older server without lastActivity falls back to the message time.
  assert.equal(toRow({ ...item, lastActivity: undefined }, CONTEXT).meta, shortWhen(item.timestamp));
});

test('project rows show the folder as the other screens do: «Проекты/site-2»', () => {
  assert.equal(shortProjectPath('/home/me/My Projects/Проекты/site-2'), 'Проекты/site-2');
  assert.equal(shortProjectPath('/root/demo-site'), '~/demo-site');
  assert.equal(shortProjectPath('/root/work/site'), '~/work/site');
  assert.equal(shortProjectPath('/root'), '~');
  assert.equal(shortProjectPath('/srv/projects/karta'), 'projects/karta');
  const row = toRow(hit('project', 'p', 'site-2', { projectId: 'p', path: '/home/me/My Projects/Проекты/site-2' }), { ...CONTEXT, query: 'site' });
  assert.equal(`${row.sub.before}${row.sub.match}${row.sub.after}`, 'Проекты/site-2');
});

test('helpers: highlight ignores case and ё, home is shortened, counters are Russian', () => {
  assert.deepEqual(splitMatch('Берёзки', 'березки'), { before: '', match: 'Берёзки', after: '' });
  assert.equal(shortenHome('/root/demo-map'), '~/demo-map');
  assert.equal(countLabel('', 0), 'недавнее');
  assert.equal(countLabel('сайт', 22), '22 совпадения');
  const now = new Date(2026, 9, 26, 14, 40);
  assert.equal(shortWhen(new Date(2026, 9, 26, 14, 31).toISOString(), now), '14:31');
  assert.equal(shortWhen(new Date(2026, 9, 25, 9, 0).toISOString(), now), 'вчера');
  assert.equal(shortWhen(new Date(2026, 9, 10, 9, 0).toISOString(), now), '10 окт');
});

test('dialog preview: the matching message with one line on each side', () => {
  const messages = [
    { kind: 'text', role: 'user', content: 'Что осталось?', timestamp: '1' },
    { kind: 'tool_use', role: 'assistant', content: 'grep', timestamp: '2' },
    { kind: 'text', role: 'assistant', content: 'Перенёс страницы сайта', timestamp: '3' },
    { kind: 'text', role: 'user', content: 'Формы проверь сам', timestamp: '4' },
    { kind: 'text', role: 'assistant', content: 'Сайт держится', timestamp: '5' },
  ];
  const preview = dialogAroundMatch(messages, 'сайт', '3');
  assert.deepEqual(preview.lines.map((line) => line.text), ['Что осталось?', 'Перенёс страницы сайта', 'Формы проверь сам']);
  assert.equal(preview.lines[1].isHit, true);
  assert.equal(preview.hitCount, 2);
  assert.equal(preview.messageCount, 4);
});

test('file preview starts a few lines above the first mention', () => {
  const content = Array.from({ length: 30 }, (_, index) => (index === 10 ? 'title: сайт' : `line ${index + 1}`)).join('\n');
  const preview = fileAroundMatch(content, 'сайт');
  assert.equal(preview.kind, 'file');
  if (preview.kind === 'file') {
    assert.equal(preview.firstLine, 8);
    assert.equal(preview.lines[3], 'title: сайт');
  }
});

test('the main assistant is the home-folder project when there is one', () => {
  const projects = [
    { projectId: 'p1', displayName: 'Карта', path: '/root/demo-map', isStarred: true },
    { projectId: 'p2', displayName: 'root', path: '/root', isStarred: false },
  ];
  assert.equal(pickAssistantProject(projects)?.projectId, 'p2');
  assert.equal(pickAssistantProject(projects.slice(0, 1))?.projectId, 'p1');
  assert.equal(pickAssistantProject([]), null);
  // Another server user: its own home is the assistant, /root is just a folder.
  const alice = [...projects, { projectId: 'p3', displayName: 'alice', path: '/home/alice/', isStarred: false }];
  assert.equal(pickAssistantProject(alice, '/home/alice')?.projectId, 'p3');
  assert.equal(pickAssistantProject(projects, null)?.projectId, 'p1');
});

test('home shortening follows the home the server reported, not a guess', () => {
  assert.equal(shortenHome('/home/alice/site', '/home/alice'), '~/site');
  assert.equal(shortenHome('/root/site', '/home/alice'), '/root/site');
  assert.equal(shortProjectPath('/home/alice', '/home/alice'), '~');
  // Before the server answered: any /home/<user> or /Users/<user> counts, /root does not.
  assert.equal(shortenHome('/Users/bob/x', null), '~/x');
  assert.equal(shortenHome('/root/x', null), '/root/x');
});

test('a long hit line is cut around the match, not from the start', () => {
  const text = `${'а'.repeat(500)} сайт ${'б'.repeat(500)}`;
  const clipped = clipAround(text, 'сайт', 300);
  assert.ok(clipped.startsWith('…') && clipped.endsWith('…'));
  assert.ok(clipped.includes('сайт'));
  assert.ok(clipped.length <= 302);
});
