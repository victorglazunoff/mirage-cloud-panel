import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';
import type { KabinaFileEntry, KabinaFolderPage, KabinaProjectRef } from '@/shared/types';

// Mirage: an upload never replaces a file with the same name (Иван: «не перезаписывать, а
// предложить изменить имя»). The server answers 409 FILE_EXISTS with a free name; «Файлы»
// opens a window with that name selected for editing and sends the upload again under it.

vi.setConfig({ testTimeout: 30_000 });

const ROOT = '/home/user/Documents/Claude Code/Проекты/demo-site';
const NOW = new Date().toISOString();

function entry(name: string, type: 'directory' | 'file'): KabinaFileEntry {
  return { name, path: `${ROOT}/${name}`, type, size: type === 'file' ? 1200 : 0, modified: NOW, isHidden: name.startsWith('.'), isSymlink: false, childCount: type === 'directory' ? 3 : null };
}

function page(folderPath: string, entries: KabinaFileEntry[]): KabinaFolderPage {
  return {
    path: folderPath, parent: '/root', entries, total: entries.length, offset: 0, hiddenCount: 1, hiddenNames: ['.env'],
    disk: null,
    places: { root: '/root', archive: '/home/user/.claude/archive' },
  };
}

const jsonResponse = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const plainResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const apiMock = vi.hoisted(() => ({
  kabinaFiles: { folder: vi.fn(), archive: vi.fn(), restore: vi.fn(), upload: vi.fn() },
  git: { status: vi.fn() },
  home: { overview: vi.fn() },
  readFile: vi.fn(),
  readFileBlob: vi.fn(),
  createFile: vi.fn(),
  renameFile: vi.fn(),
}));

// The real readApiJson: the 409 must reach the screen as the error the server sent.
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined }),
}));
vi.mock('@/shared/api', async (importOriginal) => ({ ...(await importOriginal<typeof SharedApi>()), api: apiMock }));
vi.mock('@/shared/chatDrafts', () => ({ writeDraftText: vi.fn() }));

const PROJECTS: KabinaProjectRef[] = [
  { projectId: 'p-zag', displayName: 'Сайт клиента', path: ROOT, isStarred: true },
];

const uploads: string[][] = [];

function conflictResponse(conflicts: Array<{ index: number; name: string; suggestedName: string }>) {
  return plainResponse({
    error: `"${conflicts[0].name}" is already in demo-site/ — upload it under another name`,
    code: 'FILE_EXISTS',
    details: { targetPath: ROOT, conflicts },
  }, 409);
}

beforeEach(() => {
  uploads.length = 0;
  apiMock.kabinaFiles.folder.mockImplementation(async (folderPath: string) => (
    folderPath === ROOT
      ? jsonResponse(page(ROOT, [entry('docs', 'directory'), entry('README.md', 'file'), entry('deploy.sh', 'file')]))
      : jsonResponse(page(folderPath, []))
  ));
  apiMock.git.status.mockImplementation(async () => plainResponse({ branch: 'main', modified: [], added: [], untracked: [] }));
  apiMock.home.overview.mockImplementation(async () => jsonResponse({ activity: [] }));
  apiMock.readFile.mockImplementation(async () => plainResponse({ content: '# Сайт клиента' }));
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderFiles() {
  const { FilesScreen } = await import('@/modules/kabina-files');
  render(
    <MemoryRouter initialEntries={['/files?project=p-zag']}>
      <Routes>
        <Route path="/files" element={<FilesScreen projects={PROJECTS} routeProjectId="p-zag" />} />
      </Routes>
    </MemoryRouter>,
  );
  await flush();
  await flush();
}

/** Answers the uploads in turn, recording the names each one was sent under. */
function answerUploads(...responses: Array<() => Response>) {
  apiMock.kabinaFiles.upload.mockImplementation(async (_projectId: string, formData: FormData) => {
    uploads.push(JSON.parse(String(formData.get('relativePaths'))) as string[]);
    const next = responses[uploads.length - 1];
    return next ? next() : plainResponse({ success: true, uploadedCount: uploads[uploads.length - 1].length });
  });
}

async function pickFiles(...names: string[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, 'the hidden file input is there');
  fireEvent.change(input, { target: { files: names.map((name) => new File(['new'], name, { type: 'text/plain' })) } });
  await flush();
  await flush(10);
}

test('a taken name opens «Файл уже есть» with the free name selected; Enter uploads under it', async () => {
  await renderFiles();
  answerUploads(() => conflictResponse([{ index: 0, name: 'README.md', suggestedName: 'README (2).md' }]));
  await pickFiles('README.md');

  const dialog = screen.getByRole('dialog', { name: 'ФАЙЛ УЖЕ ЕСТЬ' });
  assert.ok(within(dialog).getByText('README.md'), 'the taken name is named');
  assert.ok(within(dialog).getByText('demo-site/'), 'and the folder');
  assert.equal(screen.queryByText(/Загружено/), null, 'nothing reports success');

  const field = within(dialog).getByLabelText('НОВОЕ ИМЯ') as HTMLInputElement;
  assert.equal(field.value, 'README (2).md');
  await flush(10);
  assert.equal(document.activeElement, field, 'the field has the focus');
  assert.deepEqual([field.selectionStart, field.selectionEnd], [0, 'README (2)'.length], 'the name without «.md» is selected');

  fireEvent.change(field, { target: { value: 'README-сайт.md' } });
  fireEvent.submit(field.form as HTMLFormElement);
  await flush();
  await flush(10);

  assert.deepEqual(uploads, [['README.md'], ['README-сайт.md']]);
  assert.equal(screen.queryByRole('dialog'), null);
  assert.ok(screen.getByText('Загружено 1 файл в demo-site/ — как README-сайт.md'));
});

test('a new name that is also taken or invalid is not sent', async () => {
  await renderFiles();
  answerUploads(() => conflictResponse([{ index: 0, name: 'README.md', suggestedName: 'README (2).md' }]));
  await pickFiles('README.md');
  const dialog = screen.getByRole('dialog', { name: 'ФАЙЛ УЖЕ ЕСТЬ' });
  const field = within(dialog).getByLabelText('НОВОЕ ИМЯ') as HTMLInputElement;

  for (const [value, problem] of [
    ['deploy.sh', 'Это имя тоже занято'],
    ['README.md', 'Это имя тоже занято'],
    ['.env', 'Это имя тоже занято'],
    ['docs/README.md', 'Только имя файла — без / и \\'],
    ['   ', 'Впиши имя'],
    ['..', 'Имя из одних точек нельзя'],
  ]) {
    fireEvent.change(field, { target: { value } });
    fireEvent.submit(field.form as HTMLFormElement);
    await flush();
    assert.equal(within(dialog).getByRole('alert').textContent, problem, value);
    assert.equal(field.getAttribute('aria-invalid'), 'true');
  }
  assert.deepEqual(uploads, [['README.md']], 'only the first, refused upload went out');
});

test('Esc and «Отмена» close the window without uploading anything', async () => {
  await renderFiles();
  answerUploads(
    () => conflictResponse([{ index: 0, name: 'README.md', suggestedName: 'README (2).md' }]),
    () => conflictResponse([{ index: 0, name: 'README.md', suggestedName: 'README (2).md' }]),
  );
  await pickFiles('README.md');
  fireEvent.keyDown(document, { key: 'Escape' });
  await flush();
  assert.equal(screen.queryByRole('dialog'), null);

  await pickFiles('README.md');
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Отмена' }));
  await flush();
  assert.equal(screen.queryByRole('dialog'), null);
  assert.deepEqual(uploads, [['README.md'], ['README.md']], 'no upload under another name');
});

test('several taken names are listed together; the other files go with them', async () => {
  await renderFiles();
  answerUploads(() => conflictResponse([
    { index: 0, name: 'README.md', suggestedName: 'README (2).md' },
    { index: 2, name: 'deploy.sh', suggestedName: 'deploy (2).sh' },
  ]));
  await pickFiles('README.md', 'fresh.txt', 'deploy.sh');

  const dialog = screen.getByRole('dialog', { name: 'ФАЙЛЫ УЖЕ ЕСТЬ' });
  assert.ok(within(dialog).getByText('ещё 1 файл без совпадений загрузится вместе с ними'));
  const fields = within(dialog).getAllByRole('textbox') as HTMLInputElement[];
  assert.deepEqual(fields.map((field) => field.value), ['README (2).md', 'deploy (2).sh']);

  // Two fields may not end up with one name, nor take the name of the file that goes along.
  fireEvent.change(fields[1], { target: { value: 'README (2).md' } });
  fireEvent.submit(fields[0].form as HTMLFormElement);
  await flush();
  assert.equal(within(dialog).getAllByRole('alert').length, 2);
  fireEvent.change(fields[1], { target: { value: 'fresh.txt' } });
  fireEvent.submit(fields[0].form as HTMLFormElement);
  await flush();
  assert.deepEqual(uploads, [['README.md', 'fresh.txt', 'deploy.sh']]);

  fireEvent.change(fields[1], { target: { value: 'deploy-old.sh' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Загрузить под этими именами' }));
  await flush();
  await flush(10);
  assert.deepEqual(uploads[1], ['README (2).md', 'fresh.txt', 'deploy-old.sh']);
  assert.ok(screen.getByText('Загружено 3 файла в demo-site/ — 2 под новыми именами'));
});

test('a name taken while the window was open brings the window back with a new free name', async () => {
  await renderFiles();
  answerUploads(
    () => conflictResponse([{ index: 0, name: 'README.md', suggestedName: 'README (2).md' }]),
    () => conflictResponse([{ index: 0, name: 'README (2).md', suggestedName: 'README (2) (2).md' }]),
  );
  await pickFiles('README.md');
  fireEvent.submit((within(screen.getByRole('dialog')).getByLabelText('НОВОЕ ИМЯ') as HTMLInputElement).form as HTMLFormElement);
  await flush();
  await flush(10);

  const field = within(screen.getByRole('dialog')).getByLabelText('НОВОЕ ИМЯ') as HTMLInputElement;
  assert.equal(field.value, 'README (2) (2).md');
  assert.equal(screen.queryByText(/Загружено/), null);
});
