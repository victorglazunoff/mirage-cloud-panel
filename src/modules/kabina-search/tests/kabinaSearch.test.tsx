import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import { resetSearchMemoryCache } from '@/modules/kabina-search/utils/searchMemory';
import type { KabinaProjectRef, SearchResponse, SearchResultItem } from '@/shared/types';
import type * as KabinaModule from '@/modules/kabina';

const showToast = vi.fn();
const writeDraftText = vi.fn();

function hit(type: SearchResultItem['type'], id: string, title: string, extra: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    type, id, title, score: 10,
    subtitle: null, projectId: null, projectName: null, path: null, sessionId: null, provider: null,
    snippet: null, role: null, timestamp: null, commandName: null, actionId: null,
    ...extra,
  };
}

const RESPONSE: SearchResponse = {
  query: 'карта',
  tookMs: 40,
  total: 3,
  truncated: false,
  groups: [
    { type: 'project', label: 'Проекты', count: 1, items: [hit('project', 'p-map', 'Карта участков', { projectId: 'p-map', path: '/home/user/demo-map' })] },
    { type: 'session', label: 'Диалоги', count: 1, items: [hit('session', 'session:s1', 'Цены на карте', { sessionId: 's1', projectId: 'p-map', projectName: 'Карта участков', snippet: { text: 'обнови карта цены', matchStart: 7, matchEnd: 12 } })] },
    { type: 'file', label: 'Файлы', count: 0, items: [] },
    { type: 'command', label: 'Команды', count: 1, items: [hit('command', 'builtin:/compact', '/compact', { commandName: '/compact', subtitle: 'Сжать контекст диалога' })] },
    { type: 'action', label: 'Действия', count: 0, items: [] },
  ],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    search: vi.fn(async () => json(RESPONSE)),
    commandsCatalog: vi.fn(async () => json({ groups: [], commands: [], count: 0 })),
    home: { overview: vi.fn(async () => json({ data: { activity: [], projectCount: 2 } })) },
    projectSessions: vi.fn(async () => json({ sessions: [{ id: 's1', summary: 'Цены на карте', lastActivity: new Date().toISOString() }], sessionMeta: { total: 7 } })),
    git: { status: vi.fn(async () => json({ branch: 'seo-texts' })) },
    providers: { sessionMessages: vi.fn(async () => json({ data: { messages: [] } })) },
    readFile: vi.fn(async () => json({ content: '' })),
    compactSession: vi.fn(async () => json({ data: { queued: true } })),
  },
  readApiJson: async (response: Response) => response.json(),
}));

vi.mock('@/shared/chatDrafts', () => ({
  readDraftText: () => '',
  writeDraftText: (scope: string, text: string) => writeDraftText(scope, text),
  addToDraftText: (scope: string, text: string) => writeDraftText(scope, text),
}));

vi.mock('@/modules/kabina', async (importOriginal) => ({
  ...(await importOriginal<typeof KabinaModule>()),
  useKabinaToasts: () => ({ show: showToast, dismiss: vi.fn() }),
}));

const PROJECTS: KabinaProjectRef[] = [
  { projectId: 'p-home', displayName: 'Мираж', path: '/root', isStarred: true },
  { projectId: 'p-map', displayName: 'Карта участков', path: '/home/user/demo-map', isStarred: false },
];

const probe = { location: '' };
function LocationProbe() {
  const location = useLocation();
  useEffect(() => {
    probe.location = `${location.pathname}${location.search}`;
  }, [location]);
  return null;
}

async function renderSearch(onClose = vi.fn()) {
  const { KabinaSearch } = await import('@/modules/kabina-search');
  render(
    <MemoryRouter initialEntries={['/?search']}>
      <KabinaSearch onClose={onClose} projects={PROJECTS} />
      <LocationProbe />
    </MemoryRouter>,
  );
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: 'карта' } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
  return { input, onClose };
}

beforeAll(async () => {
  // The first import pulls the whole Kabina layer; keep it out of the first test's time budget.
  await import('@/modules/kabina-search');
}, 30_000);

beforeEach(() => {
  // Every test starts from an empty search: the query, section and row persist on purpose.
  window.sessionStorage.clear();
  resetSearchMemoryCache();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('tabs carry the server counters and rows are grouped with the ask row last', async () => {
  await renderSearch();
  const tabs = screen.getAllByRole('tab');
  assert.deepEqual(tabs.map((tab) => tab.textContent), ['Всё3', 'Проекты1', 'Диалоги1', 'Файлы0', 'Команды1', 'Действия0']);
  const options = screen.getAllByRole('option');
  assert.match(options[0].textContent ?? '', /Карта участков/);
  assert.match(options.at(-1)?.textContent ?? '', /Спросить Claude: «карта»/);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
});

test('Tab moves to the next section, arrows move the selection', async () => {
  const { input } = await renderSearch();
  fireEvent.keyDown(input, { key: 'Tab' });
  assert.equal(screen.getByRole('tab', { selected: true }).textContent, 'Проекты1');
  assert.equal(screen.getAllByRole('option').length, 2);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  assert.match(screen.getByRole('option', { selected: true }).textContent ?? '', /Спросить Claude/);
});

test('Enter opens the selected project; ⌘Enter puts the question into the main assistant', async () => {
  const { input } = await renderSearch();
  fireEvent.keyDown(input, { key: 'Enter' });
  assert.equal(probe.location, '/p/p-map');

  cleanup();
  const second = await renderSearch();
  fireEvent.keyDown(second.input, { key: 'Enter', metaKey: true });
  assert.equal(writeDraftText.mock.calls.at(-1)?.[0], 'project:p-home');
  assert.match(String(writeDraftText.mock.calls.at(-1)?.[1]), /карта$/);
  assert.equal(probe.location, '/p/p-home');
});

test('Esc closes the overlay without a «Поиск закрыт» entry in the bell', async () => {
  const { onClose } = await renderSearch();
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(onClose.mock.calls.length, 1);
  assert.equal(showToast.mock.calls.length, 0);
});

test('a question put into the assistant composer is not echoed into the bell', async () => {
  const { input } = await renderSearch();
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  assert.equal(probe.location, '/p/p-home');
  assert.equal(showToast.mock.calls.length, 0);
});

test('a remount (phone ↔ desktop shell swap) keeps the query, the section and the results', async () => {
  const { input } = await renderSearch();
  fireEvent.keyDown(input, { key: 'Tab' });
  assert.equal(screen.getByRole('tab', { selected: true }).textContent, 'Проекты1');
  cleanup();

  const { KabinaSearch } = await import('@/modules/kabina-search');
  render(
    <MemoryRouter initialEntries={['/?search']}>
      <KabinaSearch onClose={vi.fn()} projects={PROJECTS} />
    </MemoryRouter>,
  );
  const reopened = screen.getByRole('combobox') as HTMLInputElement;
  assert.equal(reopened.value, 'карта');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
  // Selected, so a new word replaces it instead of being glued on («картаabc»).
  assert.equal(document.activeElement, reopened);
  assert.deepEqual([reopened.selectionStart, reopened.selectionEnd], [0, 'карта'.length]);
  assert.equal(screen.getByRole('tab', { selected: true }).textContent, 'Проекты1');
  assert.match(screen.getAllByRole('option')[0].textContent ?? '', /Карта участков/);
});

test('while the next query loads, the old rows and counters are not shown', async () => {
  const { api } = await import('@/shared/api');
  const { input } = await renderSearch();
  assert.ok(screen.getAllByRole('option').length > 1);

  // The answer to the new query is held back: the list must not keep «карта» rows under «цены».
  let release: (value: Response) => void = () => undefined;
  vi.mocked(api.search).mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  fireEvent.change(input, { target: { value: 'цены' } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
  assert.equal(screen.queryAllByRole('option').length, 0);
  assert.equal(screen.getByRole('listbox').getAttribute('aria-busy'), 'true');
  assert.deepEqual(screen.getAllByRole('tab').map((tab) => tab.textContent), ['Всё·', 'Проекты·', 'Диалоги·', 'Файлы·', 'Команды·', 'Действия·']);

  await act(async () => {
    release(json({ ...RESPONSE, query: 'цены' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(screen.getAllByRole('option').length > 1);
  assert.equal(screen.getByRole('listbox').getAttribute('aria-busy'), 'false');
});

test('phone width: short placeholder, preview folded into a sheet that opens and folds back (Esc)', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 760px)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  try {
    const { input, onClose } = await renderSearch();
    assert.equal(input.getAttribute('placeholder'), 'Проект, диалог, файл…');

    const handle = screen.getByRole('button', { name: /ПРЕВЬЮ/ });
    assert.equal(handle.getAttribute('aria-expanded'), 'false');
    assert.match(handle.textContent ?? '', /Карта участков/, 'the handle names the selected row');
    assert.equal(document.getElementById('kbs-preview-body')?.hidden, true);

    fireEvent.click(handle);
    assert.equal(handle.getAttribute('aria-expanded'), 'true');
    assert.equal(document.getElementById('kbs-preview-body')?.hidden, false);

    // First Esc folds the sheet, the second closes search.
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(handle.getAttribute('aria-expanded'), 'false');
    assert.equal(onClose.mock.calls.length, 0);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(onClose.mock.calls.length, 1);
  } finally {
    vi.unstubAllGlobals();
  }
});
