import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureArtifactVersion,
  isDeniedSourcePath,
  readStoredFile,
  readStoredVersions,
  readVersionDirName,
} from '@/modules/artifacts/services/artifact-store.service.js';
import type { ArtifactPublishRecord } from '@/shared/types.js';

const ARTIFACT_ID = '2033aaaa-1111-2222-3333-444455556666';

type Sandbox = { root: string; allowed: string; outside: string; store: string };

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-'));
  const sandbox = {
    root,
    allowed: path.join(root, 'scratchpad'),
    outside: path.join(root, 'outside'),
    store: path.join(root, 'store'),
  };
  await mkdir(sandbox.allowed, { recursive: true });
  await mkdir(sandbox.outside, { recursive: true });
  try {
    await run(sandbox);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeRecord(overrides: Partial<ArtifactPublishRecord>): ArtifactPublishRecord {
  return {
    artifactId: ARTIFACT_ID,
    url: 'https://claude.ai/artifact/AbC',
    title: 'Сводка',
    version: '1792669304-f0fa',
    seq: 1,
    updated: false,
    icon: null,
    localPath: null,
    toolUseId: 't1',
    publishedAt: '2026-10-26T10:00:00.000Z',
    kind: 'page',
    label: null,
    description: null,
    entrySourcePath: null,
    sourceRoot: null,
    supportingFiles: [],
    ownFiles: [],
    ...overrides,
  };
}

test('a version name is the claude.ai version id, or seq-N when unsafe', () => {
  assert.equal(readVersionDirName({ version: '1792669304-f0fa', seq: 3 }), '1792669304-f0fa');
  assert.equal(readVersionDirName({ version: '../x', seq: 3 }), 'seq-3');
  assert.equal(readVersionDirName({ version: '..', seq: null }), null);
});

test('secrets are never copied, even under an allowed root', () => {
  assert.equal(isDeniedSourcePath('/root/.ssh/id_ed25519'), true);
  assert.equal(isDeniedSourcePath('/root/.claude/.mirage.env'), true);
  assert.equal(isDeniedSourcePath('/root/project/.env.local'), true);
  assert.equal(isDeniedSourcePath('/root/.cloudcli/auth.db'), true);
  assert.equal(isDeniedSourcePath('/home/user/.mirage/auth.db'), true);
  assert.equal(isDeniedSourcePath('/root/project/site/index.html'), false);
});

test('a page and its supporting files are copied into <store>/<id>/<version>/files', async () => {
  await withSandbox(async ({ allowed, store }) => {
    await mkdir(path.join(allowed, 'mockup', 'img'), { recursive: true });
    await writeFile(path.join(allowed, 'mockup', 'index.html'), '<html><body>v1</body></html>');
    await writeFile(path.join(allowed, 'mockup', 'img', 'a.svg'), '<svg/>');

    const manifest = await captureArtifactVersion({
      storeRoot: store,
      allowedRoots: [allowed],
      origin: 'live',
      record: makeRecord({
        entrySourcePath: path.join(allowed, 'mockup', 'index.html'),
        sourceRoot: path.join(allowed, 'mockup'),
        supportingFiles: [{ publishedPath: 'img/a.svg', sourcePath: path.join(allowed, 'mockup', 'img', 'a.svg') }],
      }),
    });

    assert.ok(manifest);
    assert.equal(manifest.entryPath, 'index.html');
    assert.deepEqual(manifest.files, ['img/a.svg', 'index.html']);
    assert.deepEqual(manifest.skipped, []);
    const stored = await readFile(path.join(store, ARTIFACT_ID, '1792669304-f0fa', 'files', 'img', 'a.svg'), 'utf8');
    assert.equal(stored, '<svg/>');
    assert.equal((await readStoredFile(store, manifest, 'img/a.svg'))?.toString(), '<svg/>');
  });
});

test('files outside the allowed roots, behind escaping links, secret or too large are refused', async () => {
  await withSandbox(async ({ allowed, outside, store }) => {
    await writeFile(path.join(allowed, 'page.html'), '<p>ok</p>');
    await writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(allowed, 'link.txt'));
    await writeFile(path.join(allowed, '.env'), 'TOKEN=1');
    const big = await open(path.join(allowed, 'big.bin'), 'w');
    await big.truncate(16 * 1024 * 1024 + 1);
    await big.close();

    const manifest = await captureArtifactVersion({
      storeRoot: store,
      allowedRoots: [allowed],
      origin: 'live',
      record: makeRecord({
        entrySourcePath: path.join(allowed, 'page.html'),
        sourceRoot: allowed,
        supportingFiles: [
          { publishedPath: 'outside.txt', sourcePath: path.join(outside, 'secret.txt') },
          { publishedPath: 'link.txt', sourcePath: path.join(allowed, 'link.txt') },
          { publishedPath: 'env', sourcePath: path.join(allowed, '.env') },
          { publishedPath: 'big.bin', sourcePath: path.join(allowed, 'big.bin') },
          { publishedPath: 'missing.js', sourcePath: path.join(allowed, 'missing.js') },
        ],
      }),
    });

    assert.ok(manifest);
    assert.deepEqual(manifest.files, ['page.html']);
    assert.deepEqual(manifest.skipped, [
      { path: 'outside.txt', reason: 'outside-allowed-roots' },
      { path: 'link.txt', reason: 'outside-allowed-roots' },
      { path: 'env', reason: 'denied' },
      { path: 'big.bin', reason: 'too-large' },
      { path: 'missing.js', reason: 'missing' },
    ]);
    // Reading back is limited to the manifest's own files: no traversal.
    assert.equal(await readStoredFile(store, manifest, '../manifest.json'), null);
    assert.equal(await readStoredFile(store, manifest, 'outside.txt'), null);
  });
});

test('an entry outside the roots leaves a manifest without entry; a later capture retries', async () => {
  await withSandbox(async ({ allowed, outside, store }) => {
    await writeFile(path.join(outside, 'page.html'), '<p>outside</p>');
    const record = makeRecord({ entrySourcePath: path.join(outside, 'page.html'), sourceRoot: outside });

    const first = await captureArtifactVersion({ storeRoot: store, record, allowedRoots: [allowed], origin: 'backfill' });
    assert.equal(first?.entryPath, null);

    const second = await captureArtifactVersion({ storeRoot: store, record, allowedRoots: [outside], origin: 'backfill' });
    assert.equal(second?.entryPath, 'page.html');
    assert.equal((await readStoredVersions(store, ARTIFACT_ID)).length, 1);
  });
});

test('a new version keeps the files the publish did not resend', async () => {
  await withSandbox(async ({ allowed, store }) => {
    await mkdir(path.join(allowed, 'canvas', 'project'), { recursive: true });
    await writeFile(path.join(allowed, 'canvas', 'project', 'Main.dc.html'), 'main v1');
    await writeFile(path.join(allowed, 'canvas', 'project', 'canvas.json'), '{}');
    const root = path.join(allowed, 'canvas');

    await captureArtifactVersion({
      storeRoot: store,
      allowedRoots: [allowed],
      origin: 'live',
      record: makeRecord({
        kind: 'typed',
        entrySourcePath: path.join(root, 'project', 'canvas.json'),
        sourceRoot: root,
        supportingFiles: [{ publishedPath: 'project/Main.dc.html', sourcePath: path.join(root, 'project', 'Main.dc.html') }],
      }),
    });

    await rm(path.join(root, 'project', 'Main.dc.html'));
    await writeFile(path.join(root, 'project', 'Phone.dc.html'), 'phone v2');
    const second = await captureArtifactVersion({
      storeRoot: store,
      allowedRoots: [allowed],
      origin: 'live',
      record: makeRecord({
        kind: 'typed',
        seq: 2,
        version: '1792669999-aaaa',
        entrySourcePath: path.join(root, 'project', 'Phone.dc.html'),
        sourceRoot: root,
      }),
    });

    assert.deepEqual(second?.files, ['project/Main.dc.html', 'project/Phone.dc.html', 'project/canvas.json']);
    const versions = await readStoredVersions(store, ARTIFACT_ID);
    assert.deepEqual(versions.map((manifest) => manifest.seq), [2, 1]);
  });
});
