import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { KabinaFileEntry, KabinaFolderPage, KabinaProjectRef } from '@/shared/types';

// The first render pulls in the whole Kabina layer; under a full parallel run that alone can take seconds.
vi.setConfig({ testTimeout: 30_000 });

const ROOT = '/home/user/Documents/Claude Code/Проекты/demo-site';
const NOW = new Date().toISOString();

function entry(name: string, type: 'directory' | 'file', extra: Partial<KabinaFileEntry> = {}): KabinaFileEntry {
  return { name, path: `${ROOT}/${name}`, type, size: type === 'file' ? 1200 : 0, modified: NOW, isHidden: name.startsWith('.'), isSymlink: false, childCount: type === 'directory' ? 3 : null, ...extra };
}

function page(folderPath: string, entries: KabinaFileEntry[], total = entries.length, offset = 0): KabinaFolderPage {
  return {
    path: folderPath, parent: '/root', entries, total, offset, hiddenCount: 1, hiddenNames: ['.env'],
    disk: { usedBytes: 38 * 1024 ** 3, totalBytes: 80 * 1024 ** 3 },
    places: { root: '/root', archive: '/home/user/.claude/archive' },
  };
}

const bigFolder = Array.from({ length: 450 }, (_, index) => ({
  ...entry(`pkg-${String(index).padStart(3, '0')}`, 'directory'),
  path: `${ROOT}/node_modules/pkg-${String(index).padStart(3, '0')}`,
}));

const jsonResponse = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const plainResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const apiMock = vi.hoisted(() => ({
  kabinaFiles: { folder: vi.fn(), archive: vi.fn(), restore: vi.fn(), upload: vi.fn() },
  git: { status: vi.fn() },
  home: { overview: vi.fn() },
  readFile: vi.fn(),
  readFileBlob: vi.fn(),
  createFile: vi.fn(),
  renameFile: vi.fn(),
}));

const drafts = vi.hoisted(() => ({ writeDraftText: vi.fn() }));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined }),
}));

vi.mock('@/shared/api', () => ({ api: apiMock, readApiJson: async (response: Response) => response.json() }));
vi.mock('@/shared/chatDrafts', () => drafts);

const PROJECTS: KabinaProjectRef[] = [
  { projectId: 'p-zag', displayName: 'Сайт клиента', path: ROOT, isStarred: true },
  { projectId: 'p-map', displayName: 'Карта участков', path: '/home/user/Documents/Claude Code/Проекты/demo-map', isStarred: false },
];

beforeEach(() => {
  apiMock.kabinaFiles.folder.mockImplementation(async (folderPath: string, options: { offset?: number; limit?: number } = {}) => {
    if (folderPath === ROOT) return jsonResponse(page(ROOT, [entry('docs', 'directory'), entry('node_modules', 'directory'), entry('README.md', 'file'), entry('deploy.sh', 'file')]));
    if (folderPath === `${ROOT}/node_modules`) {
      const offset = options.offset ?? 0;
      return jsonResponse(page(folderPath, bigFolder.slice(offset, offset + (options.limit ?? 200)), 450, offset));
    }
    if (folderPath === '/home/user/Documents/Claude Code/Проекты') return jsonResponse(page(folderPath, [entry('demo-site', 'directory', { path: ROOT })]));
    if (folderPath === `${ROOT}/docs`) return jsonResponse(page(folderPath, [entry('api', 'directory', { path: `${ROOT}/docs/api` }), entry('intro.md', 'file', { path: `${ROOT}/docs/intro.md` })]));
    if (folderPath === `${ROOT}/docs/api`) return jsonResponse(page(folderPath, [entry('routes.md', 'file', { path: `${ROOT}/docs/api/routes.md` })]));
    return jsonResponse(page(folderPath, [], 7));
  });
  apiMock.git.status.mockImplementation(async () => plainResponse({ branch: 'main', modified: ['deploy.sh'], added: [], untracked: [] }));
  apiMock.home.overview.mockImplementation(async () => jsonResponse({ activity: [] }));
  apiMock.readFile.mockImplementation(async () => plainResponse({ content: '# Сайт клиента\n\nСайт и кабинет.\n\n## Запуск\n\n- ./deploy.sh' }));
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname}</span>;
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderFiles(url = '/files?project=p-zag', routeProjectId: string | null = 'p-zag') {
  const { FilesScreen } = await import('@/modules/kabina-files');
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/files" element={<FilesScreen projects={PROJECTS} routeProjectId={routeProjectId} />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  await flush();
  await flush();
}

test('the project opens with its README previewed, git marks and the disk', async () => {
  await renderFiles();
  assert.ok(screen.getByRole('heading', { level: 1, name: 'demo-site' }));
  assert.ok(screen.getByText('1 изменение не закоммичено'));
  assert.ok(screen.getByText('/ 80 ГБ', { exact: false }));
  const tree = screen.getByRole('tree');
  assert.ok(within(tree).getByText('изменён, не закоммичен'), 'deploy.sh carries the M mark');
  assert.ok(screen.getByRole('heading', { level: 3, name: 'Сайт клиента' }), 'README rendered as Markdown');
  assert.ok(screen.getByText('скрыто 1: .env'));
});

test('«Скрытые» reloads the tree with hidden=1 instead of emptying it', async () => {
  await renderFiles();
  apiMock.kabinaFiles.folder.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Скрытые' }));
  await flush();
  await flush();
  const rootCalls = apiMock.kabinaFiles.folder.mock.calls.filter((call) => call[0] === ROOT);
  assert.ok(rootCalls.some((call) => call[1]?.hidden === true), 'the open folder is asked again with hidden files');
  assert.ok(within(screen.getByRole('tree')).getByText('README.md'), 'the tree is not left empty');
});

test('a big folder loads 200 at a time and says how many are left (no silent cut)', async () => {
  await renderFiles();
  fireEvent.click(screen.getByRole('treeitem', { name: /node_modules/ }));
  await flush();
  assert.ok(screen.getByText('показано 200 из 450'));
  fireEvent.click(screen.getByRole('button', { name: 'показать ещё 200' }));
  await flush();
  assert.ok(screen.getByText('показано 400 из 450'));
  fireEvent.click(screen.getByRole('button', { name: 'показать ещё 50' }));
  await flush();
  assert.ok(screen.getByText('показаны все 450'));
  assert.equal(apiMock.kabinaFiles.folder.mock.calls.filter((call) => call[0] === `${ROOT}/node_modules`).length, 3);
});

test('«В архив» moves the file through the server and «Вернуть» brings it back', async () => {
  await renderFiles();
  apiMock.kabinaFiles.archive.mockImplementation(async () => jsonResponse({ originalPath: `${ROOT}/deploy.sh`, archivedPath: '/home/user/.claude/archive/files/2026-10-26/demo-site/deploy.sh' }));
  apiMock.kabinaFiles.restore.mockImplementation(async () => jsonResponse({ restoredPath: `${ROOT}/deploy.sh` }));
  apiMock.readFile.mockImplementation(async () => plainResponse({ content: '#!/usr/bin/env bash\nset -e' }));

  fireEvent.click(screen.getByRole('treeitem', { name: /deploy\.sh/ }));
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'В архив' }));
  await flush();
  assert.deepEqual(apiMock.kabinaFiles.archive.mock.calls[0], ['p-zag', `${ROOT}/deploy.sh`]);
  assert.ok(screen.getByText('перенесён в', { exact: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Вернуть' }));
  await flush();
  assert.deepEqual(apiMock.kabinaFiles.restore.mock.calls[0], ['p-zag', '/home/user/.claude/archive/files/2026-10-26/demo-site/deploy.sh', `${ROOT}/deploy.sh`]);
});

test('«Скачать» of a file gone from the server says so instead of saving the error as the file', async () => {
  await renderFiles();
  apiMock.readFileBlob.mockImplementation(async () => new Response(JSON.stringify({ error: 'File not found' }), { status: 404 }));
  const createUrl = vi.fn(() => 'blob:x');
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = createUrl;
  try {
    fireEvent.click(screen.getByRole('button', { name: /Скачать/ }));
    await flush();
    assert.equal(createUrl.mock.calls.length, 0, 'no download of the error body');
    assert.equal(screen.getByRole('alert').textContent, 'Файла больше нет на сервере.');
  } finally {
    URL.createObjectURL = originalCreate;
  }
});

test('a recent file of another project opens in that project, unfolded and previewed', async () => {
  const nested = entry('routes.md', 'file', { path: `${ROOT}/docs/api/routes.md` });
  window.localStorage.setItem('mirage.kabina.files.recent', JSON.stringify([{ entry: nested, projectId: 'p-zag', projectName: 'demo-site', at: Date.now() }]));
  apiMock.readFile.mockImplementation(async () => plainResponse({ content: '# Маршруты API' }));
  const { FilesScreen } = await import('@/modules/kabina-files');
  // As in the app: the project comes from the address, so a navigation re-roots the screen.
  function FromAddress() {
    const [params] = useSearchParams();
    return <FilesScreen projects={PROJECTS} routeProjectId={params.get('project')} />;
  }
  render(
    <MemoryRouter initialEntries={['/files?project=p-map']}>
      <Routes><Route path="/files" element={<FromAddress />} /></Routes>
    </MemoryRouter>,
  );
  await flush();
  fireEvent.click(screen.getByRole('button', { name: /^routes\.md/ }));
  await flush();
  await flush();
  await flush();
  const tree = screen.getByRole('tree', { name: 'Файлы: demo-site' });
  const selected = within(tree).getByRole('treeitem', { selected: true });
  assert.match(selected.textContent ?? '', /^routes\.md/, 'the nested file is selected, not the README');
  assert.ok(screen.getByRole('heading', { level: 1 + 2, name: 'Маршруты API' }));
});

test('«Спросить Claude про файл» opens the project chat with the @-link typed in', async () => {
  await renderFiles();
  fireEvent.change(screen.getByLabelText('СПРОСИТЬ CLAUDE ПРО ФАЙЛ'), { target: { value: 'Что поменялось?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос Claude' }));
  await flush();
  assert.deepEqual(drafts.writeDraftText.mock.calls[0], ['project:p-zag', '@README.md Что поменялось?']);
  assert.equal(screen.getByTestId('where').textContent, '/p/p-zag');
});

test('a .env file is never read for the preview', async () => {
  apiMock.kabinaFiles.folder.mockImplementation(async () => jsonResponse(page(ROOT, [entry('.env', 'file')])));
  await renderFiles();
  fireEvent.click(screen.getByRole('treeitem', { name: /\.env/ }));
  await flush();
  assert.ok(screen.getByText('БЕЗ ПРЕВЬЮ · СЕКРЕТЫ'));
  assert.equal(apiMock.readFile.mock.calls.length, 0);
  assert.equal(apiMock.readFileBlob.mock.calls.length, 0);
});

test('?file= (relative to the project) opens the tree down to the file and previews it', async () => {
  apiMock.readFile.mockImplementation(async () => plainResponse({ content: '# Маршруты API' }));
  await renderFiles('/files?project=p-zag&file=docs%2Fapi%2Froutes.md');
  await flush();
  const tree = screen.getByRole('tree');
  const row = within(tree).getByRole('treeitem', { name: /routes\.md/ });
  assert.equal(row.getAttribute('aria-selected'), 'true');
  assert.equal(within(tree).getByRole('treeitem', { name: /^.*docs/ }).getAttribute('aria-expanded'), 'true');
  assert.ok(apiMock.readFile.mock.calls.length > 0, 'the preview asked for the file');
  assert.ok(screen.getByRole('heading', { level: 3, name: 'Маршруты API' }));
});

test('?file= with an absolute path works without ?project=, and a missing file leaves the tree as usual', async () => {
  apiMock.readFile.mockImplementation(async () => plainResponse({ content: '# Вступление' }));
  await renderFiles(`/files?file=${encodeURIComponent(`${ROOT}/docs/intro.md`)}`, null);
  await flush();
  assert.equal(within(screen.getByRole('tree')).getByRole('treeitem', { name: /intro\.md/ }).getAttribute('aria-selected'), 'true');
});

test('?file= pointing at nothing does not break the screen', async () => {
  await renderFiles('/files?project=p-zag&file=docs%2Fnope.md');
  await flush();
  assert.ok(within(screen.getByRole('tree')).getByRole('treeitem', { name: /deploy\.sh/ }));
});

test('phone: no preview column; a file picked by hand opens the preview sheet', async () => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 720px'), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    await renderFiles();
    // The README chosen on entry does not pop a sheet over the tree.
    assert.equal(screen.queryByRole('dialog', { name: 'ПРЕВЬЮ' }), null);
    assert.equal(screen.queryByRole('heading', { level: 2, name: 'ПРЕВЬЮ' }), null);
    fireEvent.click(within(screen.getByRole('tree')).getByRole('treeitem', { name: /deploy\.sh/ }));
    await flush();
    const sheet = screen.getByRole('dialog', { name: 'ПРЕВЬЮ' });
    assert.ok(within(sheet).getByText('deploy.sh'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Закрыть' }));
    assert.equal(screen.queryByRole('dialog', { name: 'ПРЕВЬЮ' }), null);
  } finally {
    window.matchMedia = original;
  }
});

test('while the project list is loading, no /root page is read and no «Сервер» root flashes', async () => {
  const { FilesScreen } = await import('@/modules/kabina-files');
  const tree = (projects: KabinaProjectRef[], isLoadingProjects: boolean) => (
    <MemoryRouter initialEntries={['/files']}>
      <Routes>
        <Route path="/files" element={<FilesScreen projects={projects} routeProjectId={null} isLoadingProjects={isLoadingProjects} />} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(tree([], true));
  await flush();
  await flush();
  assert.equal(apiMock.kabinaFiles.folder.mock.calls.some(([folderPath]) => folderPath === '~'), false);

  // The list arrived: the tree opens in the projects folder straight away.
  view.rerender(tree(PROJECTS, false));
  await flush();
  await flush();
  const pages = apiMock.kabinaFiles.folder.mock.calls
    .filter(([, options]) => (options as { limit?: number } | undefined)?.limit !== 1)
    .map(([folderPath]) => folderPath);
  assert.deepEqual([...new Set(pages)], ['/home/user/Documents/Claude Code/Проекты']);
});
