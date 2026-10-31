import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createArtifactsService } from '@/modules/artifacts/services/artifacts.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

const PAGE_ID = '2033aaaa-1111-2222-3333-444455556666';
const CANVAS_ID = '102fd72f-9ad1-4192-95cf-046f0d7e2d4e';

type Fixture = {
  root: string;
  scratch: string;
  store: string;
  jsonlPath: string;
  published: Array<{ sessionId: string; event: NormalizedMessage }>;
  service: ReturnType<typeof createArtifactsService>;
};

function call(id: string, input: Record<string, unknown>, timestamp: string) {
  return { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Artifact', input }] } };
}

function result(id: string, text: string, toolUseResult: Record<string, unknown>, timestamp: string) {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    toolUseResult,
  };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifacts-service-'));
  const scratch = path.join(root, 'claude-0', 'scratchpad');
  const store = path.join(root, 'store');
  await mkdir(path.join(scratch, 'site', 'img'), { recursive: true });
  await mkdir(path.join(scratch, 'canvas', 'project'), { recursive: true });
  await writeFile(path.join(scratch, 'site', 'index.html'), '<!doctype html><html><head><title>t</title></head><body>v2</body></html>');
  await writeFile(path.join(scratch, 'site', 'img', 'logo.svg'), '<svg/>');
  await writeFile(path.join(scratch, 'canvas', 'project', 'canvas.json'), '{}');
  await writeFile(path.join(scratch, 'canvas', 'project', 'Main.dc.html'), '<x-dc/>');

  const pageResult = (seq: number) => ({
    url: 'https://claude.ai/artifact/Page1',
    artifact_id: PAGE_ID,
    title: 'Сводка',
    seq,
    version: `100000000${seq}-abcd`,
    updated: seq > 1,
    path: path.join(scratch, 'site', 'index.html'),
  });
  const rows = [
    call('p1', { file_path: path.join(scratch, 'site', 'index.html'), root: path.join(scratch, 'site'), files: [{ path: 'img/logo.svg' }], icon: 'chart' }, '2026-10-26T09:00:00.000Z'),
    result('p1', 'Published', pageResult(1), '2026-10-26T09:00:01.000Z'),
    call('k1', { action: 'publish', root: path.join(scratch, 'canvas'), file_path: path.join(scratch, 'canvas', 'project', 'canvas.json') }, '2026-10-26T09:30:00.000Z'),
    result('k1', 'Its page comes from the Artifact type https://claude.ai/artifact/T. Its own files now: "project/Main.dc.html", "project/canvas.json". Done.', {
      url: 'https://claude.ai/artifact/Canvas1',
      artifact_id: CANVAS_ID,
      title: 'Холст',
      seq: 1,
      version: '1000000100-cccc',
      path: path.join(scratch, 'canvas', 'project', 'canvas.json'),
    }, '2026-10-26T09:30:01.000Z'),
    call('p2', { file_path: path.join(scratch, 'site', 'index.html'), label: 'Вторая' }, '2026-10-26T10:00:00.000Z'),
    result('p2', 'Published', pageResult(2), '2026-10-26T10:00:01.000Z'),
  ];
  const jsonlPath = path.join(root, 'session.jsonl');
  await writeFile(jsonlPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const published: Fixture['published'] = [];
  const sessions: Record<string, { provider: string; jsonlPath: string | null; projectPath: string | null }> = {
    s1: { provider: 'claude', jsonlPath, projectPath: path.join(root, 'project') },
    codex: { provider: 'codex', jsonlPath, projectPath: null },
  };
  const service = createArtifactsService({
    storeRoot: () => store,
    getSession: (sessionId) => sessions[sessionId] ?? null,
    listProjectPaths: () => [],
    listScratchpadRoots: async () => [path.join(root, 'claude-0')],
    publishToRun: (sessionId, event) => {
      published.push({ sessionId, event });
      return true;
    },
    logger: { warn: () => undefined },
  });

  try {
    await run({ root, scratch, store, jsonlPath, published, service });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a session lists its artifacts newest first, collapsed by id, and stores the newest versions', async () => {
  await withFixture(async ({ service, store }) => {
    assert.equal(await service.listSessionArtifacts('missing'), null);
    assert.deepEqual(await service.listSessionArtifacts('codex'), { sessionId: 'codex', artifacts: [] });

    const listed = await service.listSessionArtifacts('s1');
    assert.ok(listed);
    assert.deepEqual(listed.artifacts.map((artifact) => artifact.artifactId), [PAGE_ID, CANVAS_ID]);

    const [page, canvas] = listed.artifacts;
    assert.equal(page.title, 'Сводка');
    assert.equal(page.kind, 'page');
    assert.equal(page.icon, 'chart');
    assert.equal(page.seq, 2);
    assert.equal(page.label, 'Вторая');
    assert.equal(page.versionsCount, 2);
    assert.equal(page.localPathExists, true);
    assert.equal(page.stored, true);
    assert.deepEqual(page.versions.map((version) => [version.seq, version.stored]), [[2, true], [1, false]]);

    assert.equal(canvas.kind, 'typed');
    assert.deepEqual(canvas.screens, ['Main']);
    assert.equal(canvas.stored, true);

    await access(path.join(store, PAGE_ID, '1000000002-abcd', 'files', 'index.html'));
    await access(path.join(store, CANVAS_ID, '1000000100-cccc', 'files', 'project', 'Main.dc.html'));
  });
});

test('a view ticket serves the stored page with the shim, its files, and cards for the rest', async () => {
  await withFixture(async ({ service }) => {
    const ticket = await service.createViewTicket({ artifactId: PAGE_ID, version: null, sessionId: 's1' });
    assert.ok(ticket);
    assert.equal(ticket.seq, 2);
    const match = /^\/api\/artifacts\/[^/]+\/frame\/([^/]+)\/$/.exec(ticket.url);
    assert.ok(match);

    const entry = await service.renderFrame({ artifactId: PAGE_ID, ticket: match[1], filePath: '' });
    assert.ok(entry?.isDocument);
    const html = entry.body.toString('utf8');
    assert.ok(html.startsWith('<!doctype html><html><head><script>'));
    assert.ok(html.includes('<body>v2</body>'));

    const logo = await service.renderFrame({ artifactId: PAGE_ID, ticket: match[1], filePath: 'img/logo.svg' });
    assert.equal(logo?.body.toString(), '<svg/>');
    assert.match(logo?.contentType ?? '', /^image\/svg\+xml/);
    assert.equal(await service.renderFrame({ artifactId: PAGE_ID, ticket: match[1], filePath: '../manifest.json' }), null);
    assert.equal(await service.renderFrame({ artifactId: CANVAS_ID, ticket: match[1], filePath: '' }), null, 'ticket is per artifact');

    // An older version was never stored (the file on disk is the newest one): a card says so.
    const older = await service.createViewTicket({ artifactId: PAGE_ID, version: '1', sessionId: 's1' });
    assert.ok(older);
    const olderTicket = older.url.split('/')[5];
    const olderPage = await service.renderFrame({ artifactId: PAGE_ID, ticket: olderTicket, filePath: '' });
    assert.ok(olderPage?.body.toString().includes('Локальная копия этой версии не сохранилась'));

    const canvas = await service.createViewTicket({ artifactId: CANVAS_ID, version: null, sessionId: 's1' });
    assert.ok(canvas);
    const card = await service.renderFrame({ artifactId: CANVAS_ID, ticket: canvas.url.split('/')[5], filePath: '' });
    assert.ok(card?.body.toString().includes('Открыть на claude.ai'));
    assert.ok(card?.body.toString().includes('<li>Main</li>'));
  });
});

test('a view by artifact id finds its session again, and only while the session exists', async () => {
  await withFixture(async ({ service }) => {
    assert.equal(await service.createViewTicket({ artifactId: PAGE_ID, version: null, sessionId: null }), null, 'never listed');
    assert.equal(await service.createViewTicket({ artifactId: PAGE_ID, version: null, sessionId: 'missing' }), null);
    assert.equal(await service.createViewTicket({ artifactId: '../etc', version: null, sessionId: 's1' }), null);

    await service.listSessionArtifacts('s1');
    const ticket = await service.createViewTicket({ artifactId: PAGE_ID, version: null, sessionId: null });
    assert.equal(ticket?.artifactId, PAGE_ID);
    assert.equal(await service.createViewTicket({ artifactId: PAGE_ID, version: '9', sessionId: 's1' }), null);
  });
});

test('a live Artifact result is stored and announced as artifact_published', async () => {
  await withFixture(async ({ service, scratch, store, published }) => {
    const livePath = path.join(scratch, 'live.html');
    await writeFile(livePath, '<p>live</p>');
    const liveId = '33333333-4444-5555-6666-777777777777';

    service.handleLiveEvent('s1', {
      id: 'a',
      sessionId: 's1',
      timestamp: '2026-10-26T11:00:00.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'Artifact',
      toolId: 'live-1',
      toolInput: { file_path: livePath, icon: 'photo' },
    });
    service.handleLiveEvent('s1', {
      id: 'b',
      sessionId: 's1',
      timestamp: '2026-10-26T11:00:01.000Z',
      provider: 'claude',
      kind: 'tool_result',
      toolId: 'live-1',
      content: 'Published',
      toolUseResult: {
        url: 'https://claude.ai/artifact/Live1',
        artifact_id: liveId,
        title: 'Живой',
        seq: 3,
        version: '1000000300-eeee',
        path: livePath,
      },
    });
    // Unrelated results are ignored.
    service.handleLiveEvent('s1', {
      id: 'c', sessionId: 's1', timestamp: '', provider: 'claude', kind: 'tool_result', toolId: 'x', content: 'ok',
    });
    await service.whenIdle();

    await access(path.join(store, liveId, '1000000300-eeee', 'files', 'live.html'));
    assert.equal(published.length, 1);
    const [{ sessionId, event }] = published;
    assert.equal(sessionId, 's1');
    assert.equal(event.kind, 'artifact_published');
    assert.equal(event.toolId, 'live-1');
    const artifact = event.artifact as Record<string, unknown>;
    assert.equal(artifact.artifactId, liveId);
    assert.equal(artifact.title, 'Живой');
    assert.equal(artifact.icon, 'photo');
    assert.equal(artifact.stored, true);
    assert.equal(artifact.versionsCount, 3);
  });
});
