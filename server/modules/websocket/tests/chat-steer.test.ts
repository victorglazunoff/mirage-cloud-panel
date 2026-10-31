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

/**
 * Mirage Х1: `chat.steer` folds a message into the turn a session is running.
 * The gateway checks there is a running turn, hands the message to the
 * provider runtime, and announces it on the run's stream as `chat_steered`;
 * anything that cannot take it answers `STEER_UNAVAILABLE`.
 */

const SESSION_ID = 'steer-session';

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

type SteerCall = { provider: string; sessionId: string; content: string; options: Record<string, unknown> };

async function withGateway(
  steerResult: boolean,
  runTest: (context: { socket: ReturnType<typeof createFakeSocket>; steers: SteerCall[] }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-steer-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const steers: SteerCall[] = [];
  const socket = createFakeSocket();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          steer: async (provider: string, sessionId: string, content: string, options: Record<string, unknown>) => {
            steers.push({ provider, sessionId, content, options });
            return steerResult;
          },
        } as never,
      },
    );

    await runTest({ socket, steers });
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

function startRun(socket: ReturnType<typeof createFakeSocket>) {
  return chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider: 'claude',
    providerSessionId: null,
    connection: socket as never,
    userId: 1,
  });
}

test('a steer into a running turn reaches the runtime and is announced on the run stream', async () => {
  await withGateway(true, async ({ socket, steers }) => {
    startRun(socket);
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, content: 'also check the logs' }));
    await settle();

    assert.equal(steers.length, 1);
    assert.equal(steers[0].provider, 'claude');
    assert.equal(steers[0].content, 'also check the logs');

    const steered = socket.frames.find((frame) => frame.kind === 'chat_steered');
    assert.ok(steered, 'chat_steered is sent');
    assert.equal(steered.type, 'chat.steered');
    assert.equal(steered.sessionId, SESSION_ID);
    assert.equal(steered.content, 'also check the logs');
    assert.equal(typeof steered.at, 'string');
    assert.equal(typeof steered.seq, 'number', 'sequenced, so a mid-run replay shows it');
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true, 'the turn keeps running');
  });
});

test('a steer with no turn in progress is refused without reaching the runtime', async () => {
  await withGateway(true, async ({ socket, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, content: 'hello' }));
    await settle();

    assert.equal(steers.length, 0);
    assert.equal(socket.frames.at(-1)?.kind, 'protocol_error');
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal(socket.frames.at(-1)?.sessionId, SESSION_ID);
  });
});

test('a steer the runtime cannot take answers STEER_UNAVAILABLE', async () => {
  await withGateway(false, async ({ socket, steers }) => {
    startRun(socket);
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, content: 'hello' }));
    await settle();

    assert.equal(steers.length, 1);
    assert.equal(socket.frames.some((frame) => frame.kind === 'chat_steered'), false);
    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
  });
});

test('steer attachments outside the upload store are dropped before the runtime sees them', async () => {
  await withGateway(true, async ({ socket, steers }) => {
    startRun(socket);
    socket.emit('message', JSON.stringify({
      type: 'chat.steer',
      sessionId: SESSION_ID,
      content: 'look at this',
      options: { images: [{ path: '/etc/passwd' }] },
    }));
    await settle();

    assert.equal(steers.length, 1);
    assert.deepEqual(steers[0].options.images, []);
  });
});

test('a steerId the client sends comes back on chat_steered', async () => {
  await withGateway(true, async ({ socket }) => {
    startRun(socket);
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, content: 'one more', steerId: 'steer-1' }));
    await settle();

    const steered = socket.frames.find((frame) => frame.kind === 'chat_steered');
    assert.equal(steered?.steerId, 'steer-1');
  });
});

test('a steerId the client sends comes back on STEER_UNAVAILABLE', async () => {
  await withGateway(false, async ({ socket }) => {
    startRun(socket);
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, content: 'one more', steerId: 'steer-2' }));
    await settle();

    const refusal = socket.frames.at(-1);
    assert.equal(refusal?.kind, 'protocol_error');
    assert.equal(refusal?.code, 'STEER_UNAVAILABLE');
    assert.equal(refusal?.sessionId, SESSION_ID);
    assert.equal(refusal?.steerId, 'steer-2');
  });
});

test('a steer without a steerId is answered without one', async () => {
  await withGateway(false, async ({ socket }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, content: 'hello' }));
    await settle();

    assert.equal(socket.frames.at(-1)?.code, 'STEER_UNAVAILABLE');
    assert.equal('steerId' in (socket.frames.at(-1) ?? {}), false);
  });
});
