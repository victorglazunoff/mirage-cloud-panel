import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildArtifactPublishRecord,
  normalizePublishedPath,
  readSessionArtifactPublishes,
} from '@/modules/artifacts/services/artifact-transcript.service.js';

const SCRATCH = '/tmp/claude-0/proj/session/scratchpad';

function assistantRow(id: string, input: Record<string, unknown>, timestamp: string) {
  return {
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Artifact', input }] },
  };
}

function resultRow(id: string, text: string, toolUseResult: Record<string, unknown> | undefined, timestamp: string) {
  return {
    type: 'user',
    timestamp,
    cwd: '/root/project',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    ...(toolUseResult ? { toolUseResult } : {}),
  };
}

function publication(seq: number, extra: Record<string, unknown> = {}) {
  return {
    url: 'https://claude.ai/artifact/X5y',
    artifact_id: '102fd72f-9ad1-4192-95cf-046f0d7e2d4e',
    title: 'Командный пункт',
    seq,
    version: `179298583${seq}-69e0`,
    updated: seq > 1,
    ...extra,
  };
}

test('published paths never leave the version folder', () => {
  assert.equal(normalizePublishedPath('img/a.jpg'), 'img/a.jpg');
  assert.equal(normalizePublishedPath('./project/Main.dc.html'), 'project/Main.dc.html');
  assert.equal(normalizePublishedPath('../secret'), null);
  assert.equal(normalizePublishedPath('img/../../secret'), null);
  assert.equal(normalizePublishedPath('/etc/passwd'), null);
  assert.equal(normalizePublishedPath('C:/x'), null);
  assert.equal(normalizePublishedPath(''), null);
});

test('a page published with root and a file list records every supporting file', () => {
  const record = buildArtifactPublishRecord({
    toolUseId: 't1',
    toolInput: {
      file_path: '/root/project/mockup/index.html',
      root: '/root/project/mockup',
      files: [{ path: 'data.js' }, { path: 'img/a.jpg' }, { path: '../escape.txt' }, { path: 'index.html' }],
      icon: 'chart',
      description: 'Макет',
    },
    toolUseResult: publication(1, { path: '/root/project/mockup/index.html' }),
    resultText: 'Published /root/project/mockup/index.html at https://claude.ai/artifact/X5y (Version 1)',
    publishedAt: '2026-10-26T10:00:00.000Z',
    cwd: null,
  });

  assert.ok(record);
  assert.equal(record.kind, 'page');
  assert.equal(record.icon, 'chart');
  assert.equal(record.description, 'Макет');
  assert.equal(record.sourceRoot, '/root/project/mockup');
  assert.deepEqual(record.supportingFiles, [
    { publishedPath: 'data.js', sourcePath: '/root/project/mockup/data.js' },
    { publishedPath: 'img/a.jpg', sourcePath: '/root/project/mockup/img/a.jpg' },
  ]);
});

test('a file map takes string and { from } sources and skips copies from other artifacts', () => {
  const record = buildArtifactPublishRecord({
    toolUseId: 't1',
    toolInput: {
      file_path: 'page.html',
      files: {
        'css/site.css': 'styles/site.css',
        'img/logo.svg': { from: '/root/project/brand/logo.svg' },
        'lib/x.js': { artifact: 'https://claude.ai/artifact/Other', path: 'x.js' },
        'old.js': null,
      },
    },
    toolUseResult: publication(1),
    resultText: '',
    publishedAt: null,
    cwd: '/root/project',
  });

  assert.ok(record);
  assert.equal(record.entrySourcePath, '/root/project/page.html');
  assert.deepEqual(record.supportingFiles, [
    { publishedPath: 'css/site.css', sourcePath: '/root/project/styles/site.css' },
    { publishedPath: 'img/logo.svg', sourcePath: '/root/project/brand/logo.svg' },
  ]);
});

test('service calls and asset uploads are not publishes', () => {
  for (const toolInput of [
    { action: 'read', url: 'https://claude.ai/artifact/X5y' },
    { action: 'list' },
    { asset: true, url: 'https://claude.ai/artifact/X5y', file_path: '/tmp/a.png' },
  ]) {
    assert.equal(buildArtifactPublishRecord({
      toolUseId: 't',
      toolInput,
      toolUseResult: publication(1),
      resultText: '',
      publishedAt: null,
      cwd: null,
    }), null);
  }
  assert.equal(buildArtifactPublishRecord({
    toolUseId: 't',
    toolInput: { file_path: '/tmp/a.html' },
    toolUseResult: { url: 'https://claude.ai/artifact/X5y' },
    resultText: '',
    publishedAt: null,
    cwd: null,
  }), null);
});

test('a transcript lists every publish of a typed canvas and a markdown file, deduplicated', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'artifact-transcript-'));
  try {
    const typedText = (files: string[]) => [
      'Updated the Artifact at https://claude.ai/artifact/X5y (Version 2, version id 1) with canvas.json.',
      'Its page comes from the Artifact type https://claude.ai/artifact/QKN (release 1) and can\'t be changed here.',
      `Its own files now: ${files.map((file) => `"${file}"`).join(', ')}. The type's files are fixed.`,
    ].join(' ');
    const rows = [
      assistantRow('c1', {
        action: 'publish',
        url: 'https://claude.ai/artifact/X5y',
        root: `${SCRATCH}/canvas`,
        file_path: `${SCRATCH}/canvas/project/canvas.json`,
        files: { 'project/Main.dc.html': 'project/Main.dc.html' },
        label: 'Первый экран',
      }, '2026-10-26T10:00:00.000Z'),
      resultRow('c1', typedText(['project/Main.dc.html', 'project/canvas.json']), {
        ...publication(1, { path: `${SCRATCH}/canvas/project/canvas.json` }),
      }, '2026-10-26T10:00:01.000Z'),
      // An update naming only one file: the root is derived from the own-files list.
      assistantRow('c2', { url: 'https://claude.ai/artifact/X5y', file_path: `${SCRATCH}/canvas/project/Phone.dc.html` }, '2026-10-26T11:00:00.000Z'),
      resultRow('c2', typedText(['project/Main.dc.html', 'project/Phone.dc.html', 'project/canvas.json']), {
        ...publication(2, { path: `${SCRATCH}/canvas/project/Phone.dc.html` }),
      }, '2026-10-26T11:00:01.000Z'),
      // The same publish repeated (a forked transcript) is kept once.
      resultRow('c2', typedText(['project/Main.dc.html']), publication(2), '2026-10-26T11:00:02.000Z'),
      assistantRow('m1', { file_path: `${SCRATCH}/notes.md` }, '2026-10-26T12:00:00.000Z'),
      resultRow('m1', 'Published', {
        url: 'https://claude.ai/code/artifact/811f551c-59fd-4d34-ae3d-7c31bb9b26d2',
        artifact_id: '811f551c-59fd-4d34-ae3d-7c31bb9b26d2',
        title: 'Заметки',
        seq: 1,
        version: '1789133094-f51f',
        path: `${SCRATCH}/notes.md`,
      }, '2026-10-26T12:00:01.000Z'),
      assistantRow('l1', { action: 'list' }, '2026-10-26T12:30:00.000Z'),
      resultRow('l1', 'Your artifacts: …', undefined, '2026-10-26T12:30:01.000Z'),
    ];
    const jsonlPath = path.join(directory, 'session.jsonl');
    await writeFile(jsonlPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n{"half-written`, 'utf8');

    const records = await readSessionArtifactPublishes(jsonlPath, null);

    assert.equal(records.length, 3);
    const [first, second, markdown] = records;
    assert.equal(first.kind, 'typed');
    assert.equal(first.label, 'Первый экран');
    assert.equal(first.publishedAt, '2026-10-26T10:00:01.000Z');
    assert.equal(second.seq, 2);
    assert.equal(second.sourceRoot, `${SCRATCH}/canvas`);
    assert.deepEqual(second.ownFiles, ['project/Main.dc.html', 'project/Phone.dc.html', 'project/canvas.json']);
    assert.deepEqual(
      second.supportingFiles.map((file) => file.publishedPath),
      ['project/Main.dc.html', 'project/canvas.json'],
    );
    assert.equal(markdown.kind, 'markdown');
    assert.equal(markdown.artifactId, '811f551c-59fd-4d34-ae3d-7c31bb9b26d2');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
