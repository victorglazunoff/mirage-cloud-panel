import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectsFolderService } from '@/modules/home/services/projects-folder.service.js';

test('the projects folder lists sub-folders that no project points at, with file count and branch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-folder-'));
  try {
    for (const name of ['demo-map', 'demo-site', 'new-seo', '.hidden']) {
      await mkdir(path.join(root, name));
    }
    const repoDir = path.join(root, 'new-seo', '.git');
    await writeFile(path.join(root, 'new-seo', 'a.md'), 'a');
    await mkdir(path.join(root, 'new-seo', 'node_modules'));
    await writeFile(path.join(root, 'new-seo', 'node_modules', 'skip.js'), 'x');
    await mkdir(repoDir);
    await writeFile(path.join(repoDir, 'HEAD'), 'ref: refs/heads/dev\n');

    const service = createProjectsFolderService();
    const folder = await service.describeProjectsFolder([path.join(root, 'demo-map'), path.join(root, 'demo-site')]);

    assert.equal(folder?.path, root);
    assert.deepEqual(folder?.unadded.map((entry) => entry.name), ['new-seo']);
    const [entry] = folder?.unadded ?? [];
    assert.equal(entry.fileCount, 1, 'only a.md: dependencies and the repository folder are skipped');
    assert.equal(entry.isGit, true);
    assert.equal(entry.gitBranch, 'dev');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('folders that are not in the panel come most recently changed first', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'projects-folder-'));
  try {
    for (const name of ['demo-map', 'demo-site', 'alpha-old', 'beta-fresh']) {
      await mkdir(path.join(root, name));
    }
    await writeFile(path.join(root, 'alpha-old', 'a.md'), 'a');
    await writeFile(path.join(root, 'beta-fresh', 'b.md'), 'b');
    const old = new Date('2026-01-01T00:00:00Z');
    await utimes(path.join(root, 'alpha-old', 'a.md'), old, old);
    await utimes(path.join(root, 'alpha-old'), old, old);

    const service = createProjectsFolderService();
    const folder = await service.describeProjectsFolder([path.join(root, 'demo-map'), path.join(root, 'demo-site')]);

    assert.deepEqual(folder?.unadded.map((entry) => entry.name), ['beta-fresh', 'alpha-old']);
    assert.equal(folder?.unadded[1].modifiedAt, old.toISOString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no projects folder is guessed from a single project', async () => {
  const service = createProjectsFolderService();
  assert.equal(await service.describeProjectsFolder(['/root/one']), null);
});
