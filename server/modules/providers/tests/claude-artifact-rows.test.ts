import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SESSION_ID = 'artifact-rows-session';
const TOOL_USE_ID = 'toolu_artifact_1';

const ARTIFACT_RESULT = {
  url: 'https://claude.ai/artifact/AbC123',
  path: '/tmp/claude-0/x/scratchpad/page.html',
  artifact_id: '2033aaaa-1111-2222-3333-444455556666',
  title: 'Сводка',
  updated: false,
  owned: true,
  seq: 1,
  version: '1792669304-f0fa',
  capabilities: { db: {} },
};

async function withIsolatedDatabase(runTest: (tempRoot: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-artifact-rows-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(tempRoot);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('a live Artifact tool result carries the publication for the "Open beside" card', () => {
  const provider = new ClaudeSessionsProvider();
  const rows = provider.normalizeMessage({
    type: 'user',
    uuid: 'live-1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'Published …' }],
    },
    tool_use_result: ARTIFACT_RESULT,
  }, SESSION_ID);

  const result = rows.find((row) => row.kind === 'tool_result');
  assert.ok(result);
  assert.deepEqual(result.artifact, {
    artifactId: ARTIFACT_RESULT.artifact_id,
    url: ARTIFACT_RESULT.url,
    title: 'Сводка',
    version: '1792669304-f0fa',
    seq: 1,
    updated: false,
    icon: null,
    localPath: ARTIFACT_RESULT.path,
  });
  // The raw structured result still reaches the client as before.
  assert.equal((result.toolUseResult as Record<string, unknown>).artifact_id, ARTIFACT_RESULT.artifact_id);
});

test('a non-Artifact tool result keeps its exact shape (no artifact key)', () => {
  const rows = new ClaudeSessionsProvider().normalizeMessage({
    type: 'user',
    uuid: 'live-2',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
    tool_use_result: { stdout: 'ok' },
  }, SESSION_ID);

  const result = rows.find((row) => row.kind === 'tool_result');
  assert.ok(result);
  assert.equal(Object.hasOwn(result, 'artifact'), false);
});

test('history puts the publication on the Artifact tool_use row', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tempRoot) => {
    const jsonlPath = path.join(tempRoot, `${SESSION_ID}.jsonl`);
    const rows = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: '2026-10-26T10:00:00.000Z',
        message: { role: 'user', content: 'Сделай сводку' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: SESSION_ID,
        timestamp: '2026-10-26T10:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'Artifact', input: { file_path: ARTIFACT_RESULT.path } }],
        },
      },
      {
        type: 'user',
        uuid: 'r1',
        parentUuid: 'a1',
        sessionId: SESSION_ID,
        timestamp: '2026-10-26T10:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'Published …' }] },
        toolUseResult: ARTIFACT_RESULT,
      },
    ];
    await writeFile(jsonlPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Artifact session', now, now, jsonlPath);

    const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, { providerSessionId: SESSION_ID });
    const call = history.messages.find((message) => message.kind === 'tool_use' && message.toolId === TOOL_USE_ID);

    assert.ok(call, 'the Artifact call must be in the transcript');
    assert.equal(call.artifact?.artifactId, ARTIFACT_RESULT.artifact_id);
    assert.equal(call.artifact?.title, 'Сводка');
    assert.equal(call.artifact?.url, ARTIFACT_RESULT.url);
    assert.equal(call.artifact?.version, '1792669304-f0fa');
    assert.equal((call.toolResult?.toolUseResult as Record<string, unknown> | undefined)?.artifact_id, ARTIFACT_RESULT.artifact_id);
  });
});
