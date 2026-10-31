import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readPageNumber } from '@/modules/kabina-files/kabina-files.routes.js';
import { createKabinaFilesService } from '@/modules/kabina-files/kabina-files.service.js';
import { AppError } from '@/shared/utils.js';

async function withWorkspace(run: (context: { root: string; project: string; archive: string; outside: string }) => Promise<void>) {
  const base = await mkdtemp(path.join(tmpdir(), 'kabina-files-'));
  const root = path.join(base, 'workspace');
  const project = path.join(root, 'demo-site');
  const archive = path.join(base, 'archive');
  const outside = path.join(base, 'outside');
  await mkdir(project, { recursive: true });
  await mkdir(outside);
  try {
    await run({ root, project, archive, outside });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function serviceFor(root: string, project: string, archive: string) {
  return createKabinaFilesService({
    workspaceRoot: root,
    archiveRoot: archive,
    getProjectPathById: (projectId) => (projectId === 'p1' ? project : null),
    now: () => new Date('2026-10-26T09:00:00Z'),
  });
}

test('a folder page lists folders first, counts everything and pages without a silent cut', async () => {
  await withWorkspace(async ({ root, project, archive }) => {
    await mkdir(path.join(project, 'docs'));
    await writeFile(path.join(project, 'docs', 'a.md'), '# A');
    await writeFile(path.join(project, '.env'), 'SECRET=1');
    await mkdir(path.join(project, 'node_modules'));
    for (let index = 0; index < 450; index += 1) {
      await writeFile(path.join(project, 'node_modules', `pkg-${String(index).padStart(3, '0')}.js`), '');
    }
    await writeFile(path.join(project, 'README.md'), 'hello');
    const service = serviceFor(root, project, archive);

    const top = await service.listFolder({ path: project });
    assert.deepEqual(top.entries.map((entry) => entry.name), ['docs', 'node_modules', 'README.md']);
    assert.equal(top.total, 3);
    assert.equal(top.hiddenCount, 1);
    assert.deepEqual(top.hiddenNames, ['.env']);
    assert.equal(top.entries[1].childCount, 450);
    assert.equal(top.entries[2].size, 5);

    const withHidden = await service.listFolder({ path: project, showHidden: true });
    assert.equal(withHidden.total, 4);

    const first = await service.listFolder({ path: path.join(project, 'node_modules'), limit: 200 });
    const third = await service.listFolder({ path: path.join(project, 'node_modules'), offset: 400, limit: 200 });
    assert.equal(first.entries.length, 200);
    assert.equal(first.total, 450);
    assert.equal(third.entries.length, 50, 'the last page holds the rest');
  });
});

test('folders outside the workspace root are refused, also through a symlink', async () => {
  await withWorkspace(async ({ root, project, archive, outside }) => {
    await symlink(outside, path.join(project, 'escape'));
    const service = serviceFor(root, project, archive);
    await assert.rejects(service.listFolder({ path: outside }), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    await assert.rejects(service.listFolder({ path: path.join(project, 'escape') }), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    const rootPage = await service.listFolder({ path: root });
    assert.equal(rootPage.parent, null, 'the workspace root has no way up');
    // `~` is the workspace root, whatever its path on this server.
    const tildePage = await service.listFolder({ path: '~', limit: 1 });
    assert.equal(tildePage.path, rootPage.path);
    assert.equal(tildePage.places.root, rootPage.places.root);
  });
});

test('«В архив» moves into the archive and «Вернуть» puts it back; nothing outside the project is touched', async () => {
  await withWorkspace(async ({ root, project, archive, outside }) => {
    await mkdir(path.join(project, 'docs'));
    await writeFile(path.join(project, 'docs', 'ТЗ.md'), 'ТЗ');
    await writeFile(path.join(outside, 'x.txt'), 'x');
    const service = serviceFor(root, project, archive);

    const archived = await service.archiveEntry({ projectId: 'p1', path: 'docs/ТЗ.md' });
    assert.equal(archived.archivedPath, path.join(archive, 'files', '2026-10-26', 'demo-site', 'docs', 'ТЗ.md'));
    assert.equal(await readFile(archived.archivedPath, 'utf8'), 'ТЗ');
    await assert.rejects(readFile(path.join(project, 'docs', 'ТЗ.md')));

    // A second archive of the same name the same day does not overwrite the first.
    await writeFile(path.join(project, 'docs', 'ТЗ.md'), 'ТЗ v2');
    const second = await service.archiveEntry({ projectId: 'p1', path: path.join(project, 'docs', 'ТЗ.md') });
    assert.ok(second.archivedPath.endsWith('ТЗ (2).md'));

    const restored = await service.restoreEntry({ projectId: 'p1', archivedPath: archived.archivedPath, originalPath: archived.originalPath });
    assert.equal(await readFile(restored.restoredPath, 'utf8'), 'ТЗ');

    await assert.rejects(service.archiveEntry({ projectId: 'p1', path: '../../outside/x.txt' }), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    await assert.rejects(service.archiveEntry({ projectId: 'p1', path: '.' }), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    await assert.rejects(
      service.restoreEntry({ projectId: 'p1', archivedPath: path.join(outside, 'x.txt'), originalPath: path.join(project, 'x.txt') }),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );
    await assert.rejects(service.archiveEntry({ projectId: 'nope', path: 'docs' }), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  });
});

test('«Вернуть» does not write through a symlinked folder to outside the project', async () => {
  await withWorkspace(async ({ root, project, archive, outside }) => {
    await writeFile(path.join(project, 'note.md'), 'заметка');
    await symlink(outside, path.join(project, 'escape'));
    const service = serviceFor(root, project, archive);
    const archived = await service.archiveEntry({ projectId: 'p1', path: 'note.md' });

    for (const originalPath of [
      path.join(project, 'escape', 'note.md'),
      // A folder that does not exist under the link — it would be created outside.
      path.join(project, 'escape', 'new-folder', 'note.md'),
    ]) {
      await assert.rejects(
        service.restoreEntry({ projectId: 'p1', archivedPath: archived.archivedPath, originalPath }),
        (error: unknown) => error instanceof AppError && error.statusCode === 403,
      );
    }
    await assert.rejects(readFile(path.join(outside, 'note.md')));
    assert.equal(await readFile(archived.archivedPath, 'utf8'), 'заметка');

    // A folder that is gone is recreated inside the project.
    const restored = await service.restoreEntry({
      projectId: 'p1',
      archivedPath: archived.archivedPath,
      originalPath: path.join(project, 'gone', 'note.md'),
    });
    assert.equal(restored.restoredPath, path.join(project, 'gone', 'note.md'));
    assert.equal(await readFile(restored.restoredPath, 'utf8'), 'заметка');
  });
});

test('page numbers in the query must be non-negative integers', () => {
  assert.equal(readPageNumber(undefined, 'offset'), undefined);
  assert.equal(readPageNumber('200', 'offset'), 200);
  assert.throws(() => readPageNumber('-1', 'offset'));
  assert.throws(() => readPageNumber('abc', 'limit'));
});
