import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import { buildNavProjects, buildNavSections, focusableItems, parentProjectKey } from '@/modules/kabina-chat/utils/navigatorModel';
import type { HomeProjectsBoard, NavSession, Project, ProjectSession } from '@/shared/types';

vi.setConfig({ testTimeout: 30_000 });

const NOW = Date.parse('2026-10-27T06:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const BOARD: HomeProjectsBoard = {
  generatedAt: iso(0),
  projects: [
    { projectId: 'p-quiet', displayName: 'Тихий', projectPath: '/home/user/quiet', lastActivity: iso(5000), lastSessionId: null, lastSessionTitle: null, sessionCount: 2, activityByDay: [], isStarred: false, isArchived: false },
    { projectId: 'p-here', displayName: 'Общая', projectPath: '/home/user/common', lastActivity: iso(60), lastSessionId: 's1', lastSessionTitle: 'Фид', sessionCount: 2, activityByDay: [], isStarred: true, isArchived: false },
    { projectId: 'p-map', displayName: 'Карта участков', projectPath: '/home/user/demo-map', lastActivity: iso(10), lastSessionId: 'm1', lastSessionTitle: 'SEO', sessionCount: 3, activityByDay: [], isStarred: true, isArchived: false },
    { projectId: 'p-old', displayName: 'Архивный', projectPath: '/home/user/old', lastActivity: null, lastSessionId: null, lastSessionTitle: null, sessionCount: 0, activityByDay: [], isStarred: true, isArchived: true },
  ],
  activity: [
    { sessionId: 'm1', provider: 'claude', projectId: 'p-map', projectName: 'Карта участков', sessionTitle: 'SEO', state: 'waiting', startedAt: NOW - 60_000, external: false, permission: null, tasks: [] },
  ],
  terminalRecent: [],
  projectsFolder: null,
};

const HERE: NavSession[] = [
  { id: 's1', projectId: 'p-here', title: 'Фид Авито', lastActivity: iso(60) },
  { id: 's2', projectId: 'p-here', title: 'Служебная', lastActivity: iso(600) },
];

const baseInput = {
  query: '',
  currentProjectId: 'p-here',
  currentSessions: HERE,
  currentHasMore: false,
  expanded: new Set<string>(),
  pages: new Map(),
  archived: [],
  isArchiveOpen: false,
  titleHits: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('projects: archived left out, favourites first, waiting before quiet, with status words', () => {
  const rows = buildNavProjects(BOARD, new Date(NOW));
  assert.deepEqual(rows.map((row) => row.id), ['p-map', 'p-here', 'p-quiet']);
  assert.equal(rows[0].status, 'wait');
  assert.equal(rows[0].statusWord, 'ждёт тебя');
  assert.equal(rows[2].statusWord, 'тихо');
});

test('«Этот проект»: new dialog, the dialogs; the archive row only when something is archived', () => {
  const projects = buildNavProjects(BOARD, new Date(NOW));
  let sections = buildNavSections({ ...baseInput, tab: 'here', projects });
  assert.deepEqual(focusableItems(sections).map((item) => item.kind), ['new', 'session', 'session']);
  sections = buildNavSections({ ...baseInput, tab: 'here', projects, archived: [{ id: 'a1', projectId: 'p-here', title: 'Старый', lastActivity: null }] });
  assert.equal(focusableItems(sections).at(-1)?.kind, 'archive');
});

test('«Все проекты»: favourites and the rest; an unfolded project lists its dialogs under it', () => {
  const projects = buildNavProjects(BOARD, new Date(NOW));
  const pages = new Map([['p-map', { sessions: [{ id: 'm1', projectId: 'p-map', title: 'SEO', lastActivity: iso(10) }], total: 3, hasMore: true, loading: false }]]);
  const sections = buildNavSections({ ...baseInput, tab: 'all', projects, pages, expanded: new Set(['p-map']) });
  assert.deepEqual(sections.map((section) => section.title), ['ИЗБРАННЫЕ', 'ОСТАЛЬНЫЕ']);
  const items = focusableItems(sections);
  assert.deepEqual(items.slice(0, 5).map((item) => item.key), ['p:p-map', 'p:p-map:new', 'p:p-map:s:m1', 'p:p-map:more', 'p:p-here']);
  assert.equal(parentProjectKey(items[2]), 'p:p-map');
  const more = items[3];
  assert.ok(more.kind === 'more' && more.remaining === 2);
});

test('search: dialogs of this project, matching projects and other projects\' dialogs found by title', () => {
  const projects = buildNavProjects(BOARD, new Date(NOW));
  const sections = buildNavSections({
    ...baseInput,
    tab: 'here',
    projects,
    query: 'карт',
    titleHits: [
      { id: 'x1', projectId: 'p-quiet', title: 'Карточки товаров', lastActivity: null },
      { id: 's1', projectId: 'p-here', title: 'Карта (тут)', lastActivity: null },
    ],
  });
  assert.deepEqual(sections.map((section) => section.id), ['projects', 'others']);
  const others = sections[1].items;
  assert.equal(others.length, 1, 'a hit in the open project is not repeated as «other»');
  assert.ok(others[0].kind === 'session' && others[0].session.projectName === 'Тихий');
});

// ------------------------------------------------------------- the component

const apiMock = vi.hoisted(() => ({
  home: { projects: vi.fn() },
  projectSessions: vi.fn(),
  getArchivedSessions: vi.fn(),
  restoreSession: vi.fn(),
  deleteSession: vi.fn(),
  searchConversationsUrl: vi.fn(() => '/search'),
}));

vi.mock('@/shared/api', () => ({
  api: apiMock,
  readApiJson: async (response: Response) => response.json(),
}));

const probe = { location: '' };
function LocationProbe() {
  const location = useLocation();
  useEffect(() => {
    probe.location = location.pathname;
  }, [location]);
  return null;
}

const PROJECT: Project = { projectId: 'p-here', displayName: 'Общая', fullPath: '/home/user/common' };
const SESSIONS: ProjectSession[] = [
  { id: 's1', summary: 'Фид Авито', lastActivity: iso(60) },
  { id: 's2', summary: 'Служебная', lastActivity: iso(600) },
];

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderNavigator(initialTab: 'here' | 'all', focusProjectId: string | null = null) {
  apiMock.home.projects.mockImplementation(async () => new Response(JSON.stringify({ data: BOARD })));
  apiMock.getArchivedSessions.mockImplementation(async () => new Response(JSON.stringify({ data: { sessions: [] } })));
  apiMock.projectSessions.mockImplementation(async () => new Response(JSON.stringify({
    sessions: [{ id: 'm1', summary: 'SEO-тексты' }, { id: 'm2', summary: 'Брони' }],
    sessionMeta: { total: 3, hasMore: true },
  })));
  const handlers = {
    onSelectCurrent: vi.fn(),
    onNew: vi.fn(),
    onClose: vi.fn(),
  };
  const { default: ChatNavigator } = await import('@/modules/kabina-chat/ChatNavigator');
  render(
    <MemoryRouter initialEntries={['/p/p-here/s/s1']}>
      <ChatNavigator
        isPhone={false}
        project={PROJECT}
        sessions={SESSIONS}
        hasMore={false}
        currentSessionId="s1"
        attentionSessionIds={new Set()}
        processingSessions={new Map()}
        currentWaits={false}
        initialTab={initialTab}
        focusProjectId={focusProjectId}
        onNewWithSummary={vi.fn()}
        onRename={vi.fn(async () => true)}
        onArchived={vi.fn()}
        onLoadMore={vi.fn()}
        onRestored={vi.fn()}
        {...handlers}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
  await flush();
  return handlers;
}

test('opens on this project with the search focused; ↓ ↵ opens a dialog of this project', async () => {
  const handlers = await renderNavigator('here');
  const search = screen.getByRole('combobox', { name: 'Найти проект или диалог' });
  assert.equal(document.activeElement, search);
  assert.equal(screen.getByRole('tab', { name: /Этот проект/ }).getAttribute('aria-selected'), 'true');
  // The open dialog is where the keyboard starts.
  assert.match(screen.getByRole('option', { selected: true }).textContent ?? '', /Фид Авито/);
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  fireEvent.keyDown(search, { key: 'Enter' });
  assert.equal(handlers.onSelectCurrent.mock.calls[0][0].id, 's2');
  assert.equal(handlers.onClose.mock.calls.length, 1);
});

test('→ goes to «Все проекты»; a project unfolds in place and its dialog opens without a page between', async () => {
  const handlers = await renderNavigator('here');
  const search = screen.getByRole('combobox', { name: 'Найти проект или диалог' });
  fireEvent.keyDown(search, { key: 'ArrowRight' });
  await flush();
  assert.equal(screen.getByRole('tab', { name: /Все проекты/ }).getAttribute('aria-selected'), 'true');
  const map = screen.getByRole('option', { name: /Карта участков/ });
  assert.match(map.textContent ?? '', /ждёт тебя · 3 диалога/);
  fireEvent.click(map);
  await flush();
  assert.equal(apiMock.projectSessions.mock.calls[0][0], 'p-map');
  assert.equal(map.getAttribute('aria-expanded'), 'true');
  fireEvent.click(screen.getByRole('option', { name: /SEO-тексты/ }));
  await flush();
  assert.equal(probe.location, '/p/p-map/s/m1');
  assert.equal(handlers.onClose.mock.calls.length, 1);
});

test('the project crumb opens on «Все проекты» with this project unfolded; ← folds it', async () => {
  await renderNavigator('here', 'p-here');
  const here = screen.getByRole('option', { name: /Общая/ });
  assert.equal(here.getAttribute('aria-expanded'), 'true');
  assert.equal(here.getAttribute('aria-selected'), 'true');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowLeft' });
  assert.equal(here.getAttribute('aria-expanded'), 'false');
});

test('«+ Новый диалог» on top of «Этот проект» starts a dialog in this project and closes the list', async () => {
  const handlers = await renderNavigator('here');
  fireEvent.click(screen.getByRole('option', { name: /^Новый диалог/ }));
  assert.deepEqual(handlers.onNew.mock.calls, [['p-here']]);
  assert.equal(handlers.onClose.mock.calls.length, 1);

  // ↵ on the first row does the same from the keyboard.
  cleanup();
  const again = await renderNavigator('here');
  const search = screen.getByRole('combobox', { name: 'Найти проект или диалог' });
  fireEvent.keyDown(search, { key: 'Home' });
  fireEvent.keyDown(search, { key: 'ArrowUp' });
  fireEvent.keyDown(search, { key: 'Enter' });
  assert.deepEqual(again.onNew.mock.calls, [['p-here']]);
});

test('«+ Новый диалог в X» of an unfolded project starts a dialog there; search narrows the list', async () => {
  const handlers = await renderNavigator('all');
  const list = screen.getByRole('listbox');
  fireEvent.click(within(list).getByRole('option', { name: /Карта участков/ }));
  await flush();
  fireEvent.click(screen.getByRole('option', { name: 'Новый диалог в Карта участков' }));
  await flush();
  assert.deepEqual(handlers.onNew.mock.calls, [['p-map']]);
  assert.equal(handlers.onClose.mock.calls.length, 1);

  cleanup();
  await renderNavigator('here');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'служ' } });
  await flush();
  const options = screen.getAllByRole('option');
  assert.equal(options.length, 1);
  assert.match(options[0].textContent ?? '', /Служебная/);
  assert.equal(screen.queryByRole('tab'), null, 'search replaces the tabs');
});
