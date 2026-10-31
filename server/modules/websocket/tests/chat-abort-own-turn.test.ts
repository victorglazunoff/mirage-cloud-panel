import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

// Mirage: «Стоп» on a turn the CLI runs on its own after the client's turn
// ended (a background task reporting back) — no chat run covers it.

const SESSION_ID = 'relay-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

async function withGateway(
  runtime: { canAbort?: (sessionId: string) => boolean; abort: (provider: string, sessionId: string) => Promise<boolean> },
  runTest: (socket: ReturnType<typeof createFakeSocket>) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-abort-own-turn-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });
    await runTest(socket);
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

/** A client turn that has already ended, as the CLI's own turn finds it. */
function completedRun() {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION_ID, provider: 'claude', providerSessionId: null, connection: null, userId: null,
  });
  assert.ok(run);
  run.writer.sendComplete({ exitCode: 0 });
  assert.equal(run.status, 'completed');
  return run;
}

test('chat.abort stops a turn of our process that no chat run covers, and every tab hears it end', async () => {
  const aborts: Array<[string, string]> = [];
  await withGateway({
    canAbort: (sessionId) => sessionId === SESSION_ID,
    abort: async (provider, sessionId) => { aborts.push([provider, sessionId]); return true; },
  }, async (socket) => {
    const run = completedRun();
    const seqBefore = run.lastSeq;

    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(aborts, [['claude', SESSION_ID]]);
    const complete = socket.frames.find((frame) => frame.kind === 'complete');
    assert.ok(complete, 'the stopped turn ends with a complete');
    assert.equal(complete.aborted, true);
    assert.equal(complete.sessionId, SESSION_ID);
    assert.equal(complete.seq, seqBefore + 1, 'it goes through the run, so it is replayed and numbered');
    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});

test('chat.abort still reports the stop when the session has no registered run left', async () => {
  await withGateway({ canAbort: () => true, abort: async () => true }, async (socket) => {
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();

    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].kind, 'complete');
    assert.equal(socket.frames[0].aborted, true);
  });
});

test('a session with nothing of ours running is refused with NO_ACTIVE_RUN', async () => {
  const aborts: string[] = [];
  await withGateway({
    canAbort: () => false,
    abort: async (_provider, sessionId) => { aborts.push(sessionId); return true; },
  }, async (socket) => {
    completedRun();
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(aborts, []);
    assert.equal(socket.frames.at(-1)?.code, 'NO_ACTIVE_RUN');
  });
});
