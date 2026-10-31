import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import type { HomeProjectsBoard } from '@/shared/types';

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined, sendMessage: () => true }),
}));

// The first render pulls in the whole Kabina layer; under a full parallel run that alone can take seconds.
vi.setConfig({ testTimeout: 30_000 });

const NOW = Date.now();
const FOLDER = '/home/user/Documents/Claude Code/Проекты';

const BOARD: HomeProjectsBoard = {
  generatedAt: new Date(NOW).toISOString(),
  projects: [
    {
      projectId: 'p-map', displayName: 'Карта участков', projectPath: `${FOLDER}/demo-map`, lastActivity: new Date(NOW).toISOString(),
      lastSessionId: 's1', lastSessionTitle: 'SEO', sessionCount: 4, activityByDay: new Array(14).fill(1), isStarred: true, isArchived: false,
    },
    {
      projectId: 'p-domo', displayName: 'Домо', projectPath: `${FOLDER}/domo`, lastActivity: new Date(NOW).toISOString(),
      lastSessionId: 's2', lastSessionTitle: null, sessionCount: 2, activityByDay: new Array(14).fill(0), isStarred: false, isArchived: false,
    },
  ],
  activity: [],
  terminalRecent: [{ path: '/home/user/Downloads/brief', lastActivity: new Date(NOW).toISOString() }],
  projectsFolder: {
    path: FOLDER,
    unadded: [{ name: 'demo-site-seo', path: `${FOLDER}/demo-site-seo`, fileCount: 214, fileCountCapped: false, isGit: true, gitBranch: 'main' }],
  },
};

const jsonResponse = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const apiMock = vi.hoisted(() => ({
  home: { projects: vi.fn(), folderInfo: vi.fn() },
  projectPathCheck: vi.fn(),
  createProject: vi.fn(),
  toggleProjectStar: vi.fn(),
  deleteProject: vi.fn(),
  restoreProject: vi.fn(),
  renameProject: vi.fn(),
  saveFile: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: apiMock,
  readApiJson: async (response: Response) => response.json(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderScreen() {
  apiMock.home.projects.mockImplementation(async () => jsonResponse(BOARD));
  const onProjectsChanged = vi.fn();
  const { ProjectsScreen } = await import('@/modules/kabina-projects');
  render(
    <MemoryRouter>
      <ProjectsScreen onProjectsChanged={onProjectsChanged} />
    </MemoryRouter>,
  );
  await flush();
  return { onProjectsChanged };
}

test('lists starred and other projects in sections and links each to its chat', async () => {
  await renderScreen();
  const favourites = screen.getByRole('region', { name: 'ИЗБРАННЫЕ' });
  assert.equal(within(favourites).getByRole('link', { name: 'Карта участков' }).getAttribute('href'), '/p/p-map');
  assert.ok(screen.getByRole('region', { name: 'ОСТАЛЬНЫЕ' }));
  assert.ok(screen.getByText('В папке Проекты ещё 1 папка без проекта — их можно добавить через «Новый проект».'));
});

test('search with no match shows the empty state; archive asks the server and offers «Вернуть»', async () => {
  const { onProjectsChanged } = await renderScreen();
  fireEvent.change(screen.getByLabelText('Найти проект по имени или папке'), { target: { value: 'нет-такого' } });
  assert.ok(screen.getByText('НИЧЕГО НЕ НАШЛОСЬ'));
  fireEvent.click(screen.getByRole('button', { name: 'Сбросить поиск' }));

  apiMock.deleteProject.mockImplementation(async () => okResponse({ success: true }));
  apiMock.restoreProject.mockImplementation(async () => okResponse({ success: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Действия с проектом «Домо»' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'В архив' }));
  await flush();
  assert.deepEqual(apiMock.deleteProject.mock.calls[0], ['p-domo', false], 'archive, never a hard delete');
  assert.ok(screen.getByText('«Домо» в архиве. Папка и чаты на сервере не тронуты.'));
  assert.equal(onProjectsChanged.mock.calls.length, 1);

  fireEvent.click(screen.getByRole('button', { name: 'Вернуть' }));
  await flush();
  assert.deepEqual(apiMock.restoreProject.mock.calls[0], ['p-domo']);
});

test('rename in place saves the display name only', async () => {
  await renderScreen();
  apiMock.renameProject.mockImplementation(async () => okResponse({ success: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Действия с проектом «Домо»' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Переименовать' }));
  fireEvent.change(screen.getByLabelText('Новое имя проекта'), { target: { value: 'Домо · сайт' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await flush();
  assert.deepEqual(apiMock.renameProject.mock.calls[0], ['p-domo', 'Домо · сайт']);
  assert.ok(screen.getByText('Переименовано: «Домо · сайт». Папка осталась domo'));
});

test('wizard: refused folder shows the server reason; a suggested folder goes through to «Готово»', async () => {
  await renderScreen();
  apiMock.projectPathCheck.mockImplementation(async (projectPath: string) => jsonResponse(projectPath.startsWith('/tmp')
    ? { valid: false, code: 'X', title: '/tmp — системная папка', reason: 'Её очищают при перезагрузке.', resolvedPath: null, exists: false, existingProject: null }
    : { valid: true, code: null, title: null, reason: null, resolvedPath: projectPath, exists: true, existingProject: null }));
  apiMock.createProject.mockImplementation(async () => okResponse({ success: true, project: { projectId: 'p-new' } }));
  apiMock.toggleProjectStar.mockImplementation(async () => okResponse({ success: true, isStarred: true }));

  fireEvent.click(screen.getByRole('button', { name: 'Новый проект' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Папка на сервере'), { target: { value: '/tmp/x' } });
  await flush(300);
  assert.ok(within(dialog).getByText('/tmp — системная папка'));
  assert.ok(within(dialog).getByText('Её очищают при перезагрузке.'));

  fireEvent.change(within(dialog).getByLabelText('Папка на сервере'), { target: { value: `${FOLDER}/demo` } });
  fireEvent.click(within(dialog).getByRole('button', { name: /demo-site-seo\// }));
  await flush(300);
  assert.ok(within(dialog).getByText('214 файлов · git · ветка main'));

  fireEvent.click(within(dialog).getByRole('button', { name: /Далее/ }));
  assert.equal((within(dialog).getByLabelText('Как назвать') as HTMLInputElement).value, 'demo-site-seo');
  fireEvent.click(within(dialog).getByRole('button', { name: /Далее/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: /Создать проект/ }));
  await flush();

  assert.deepEqual(apiMock.createProject.mock.calls[0], [{ path: `${FOLDER}/demo-site-seo`, customName: 'demo-site-seo' }]);
  assert.deepEqual(apiMock.toggleProjectStar.mock.calls[0], ['p-new'], 'the star is on by default');
  assert.equal(apiMock.saveFile.mock.calls.length, 0, 'an existing folder is not touched');
  assert.ok(within(dialog).getByText('«demo-site-seo» в панели'));
  assert.equal(within(dialog).getByRole('link', { name: /Открыть чат/ }).getAttribute('href'), '/p/p-new');
});

test('wizard: a changed folder drops the old verdict at once; the board poll does not re-check it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    await renderScreen();
    apiMock.projectPathCheck.mockImplementation(async (projectPath: string) => jsonResponse(
      { valid: true, code: null, title: null, reason: null, resolvedPath: projectPath, exists: true, existingProject: null },
    ));
    apiMock.home.folderInfo.mockImplementation(async () => jsonResponse(null));

    fireEvent.click(screen.getByRole('button', { name: 'Новый проект' }));
    const dialog = screen.getByRole('dialog');
    const pathInput = within(dialog).getByLabelText('Папка на сервере');
    fireEvent.change(pathInput, { target: { value: `${FOLDER}/a` } });
    await flush(300);
    assert.ok(within(dialog).getByText('Папка есть'));
    const checksBefore = apiMock.projectPathCheck.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    await flush(300);
    assert.ok(apiMock.home.projects.mock.calls.length >= 2, 'the board polled');
    assert.equal(apiMock.projectPathCheck.mock.calls.length, checksBefore, 'an unchanged folder is not re-validated on every poll');

    fireEvent.change(pathInput, { target: { value: `${FOLDER}/b` } });
    const nextButton = within(dialog).getByRole('button', { name: /Далее/ });
    fireEvent.click(nextButton);
    assert.ok(within(dialog).queryByLabelText('Как назвать') === null, 'folder A must not be carried on while folder B is being checked');
    assert.equal(nextButton.getAttribute('aria-disabled'), 'true');
    await flush(300);
    fireEvent.click(nextButton);
    assert.equal((within(dialog).getByLabelText('Как назвать') as HTMLInputElement).value, 'b');
  } finally {
    vi.useRealTimers();
  }
});

test('⋯ menu keeps the arrow-key choice when the board poll re-renders the screen', async () => {
  // Fake timers before the render, so the board's 10 s poll interval is ours to advance.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Действия с проектом «Домо»' }));
    const menu = screen.getByRole('menu', { name: 'Действия с проектом «Домо»' });
    assert.equal(document.activeElement?.textContent, 'Переименовать', 'the first item gets focus on open');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    assert.equal(document.activeElement?.textContent, 'В архив');

    const pollsBefore = apiMock.home.projects.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    assert.ok(apiMock.home.projects.mock.calls.length > pollsBefore, 'the board polled and re-rendered');
    assert.equal(document.activeElement?.textContent, 'В архив', 'focus must not jump back to «Переименовать»');
  } finally {
    vi.useRealTimers();
  }
});
