import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Mirage: a turn the server starts on its own (a queued message sent the
 * moment the previous turn ends, a scheduled one) used to have no audience:
 * the tab showing the session heard of it only after something made it
 * subscribe again, and then replayed nothing below a `lastSeq` left over from
 * the previous run. Every tab with the session open now streams such a turn
 * from its first frame, and seq numbers keep counting across a session's runs.
 */

const SESSION_ID = 'watched-session';
const OTHER_SESSION_ID = 'other-session';

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

const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });

type Writer = { send: (message: Record<string, unknown>) => void };

/** A runtime whose turns answer "reply to <command>" and complete. */
function createRuntime() {
  return {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    acceptsLiveInput: () => false,
    getPendingApprovalsForSession: () => [],
    run: async (_provider: string, command: string, _options: unknown, writer: Writer) => {
      writer.send({ kind: 'text', role: 'assistant', content: `reply to ${command}`, provider: 'claude', sessionId: 'native' });
      writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
    },
    abort: async () => true,
  } as never;
}

async function withGateway(runTest: (runtime: ReturnType<typeof createRuntime>) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-session-watchers-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    sessionsDb.createAppSession(OTHER_SESSION_ID, 'claude', tempDirectory);
    await runTest(createRuntime());
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

function openTab(runtime: ReturnType<typeof createRuntime>, sessionId: string) {
  const tab = createFakeSocket();
  handleChatConnection(tab as never, { user: { id: 1 } } as never, { runtime });
  tab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] }));
  return tab;
}

test('a turn the server starts streams to the tab that has the session open, opening with the user message', async () => {
  await withGateway(async (runtime) => {
    const tab = openTab(runtime, SESSION_ID);
    await settle();
    tab.frames.length = 0;

    const result = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'скажи ПОСЛЕ', origin: 'queue' },
      { runtime },
    );
    assert.equal(result.started, true);

    assert.deepEqual(tab.frames.map((frame) => frame.kind), ['turn_dispatched', 'text', 'complete']);
    const [dispatched] = tab.frames;
    assert.equal(dispatched.content, 'скажи ПОСЛЕ');
    assert.equal(dispatched.origin, 'queue');
    assert.equal(dispatched.role, 'user');
    assert.equal(dispatched.sessionId, SESSION_ID);
  });
});

test('seq keeps counting across a session\'s runs', async () => {
  await withGateway(async (runtime) => {
    const tab = openTab(runtime, SESSION_ID);
    await settle();
    tab.frames.length = 0;

    await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'one' }, { runtime });
    await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'two' }, { runtime });

    const seqs = tab.frames.map((frame) => frame.seq as number);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
  });
});

test('a tab that switched to another session no longer streams the first one', async () => {
  await withGateway(async (runtime) => {
    const tab = openTab(runtime, SESSION_ID);
    tab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: OTHER_SESSION_ID, lastSeq: 0 }] }));
    await settle();
    tab.frames.length = 0;

    await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'unseen' }, { runtime });
    assert.deepEqual(tab.frames, []);
  });
});

test('a closed tab is forgotten', async () => {
  await withGateway(async (runtime) => {
    const tab = openTab(runtime, SESSION_ID);
    await settle();
    tab.frames.length = 0;
    tab.readyState = 3;
    tab.emit('close');

    await runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: 'after close' }, { runtime });
    assert.deepEqual(tab.frames, []);
  });
});

test('a lastSeq from before a server restart replays the whole running turn', async () => {
  await withGateway(async (runtime) => {
    const run = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
    });
    assert.ok(run);
    run.writer.send({ kind: 'text', role: 'assistant', content: 'first', provider: 'claude', sessionId: 'native' });
    run.writer.send({ kind: 'text', role: 'assistant', content: 'second', provider: 'claude', sessionId: 'native' });

    const tab = createFakeSocket();
    handleChatConnection(tab as never, { user: { id: 1 } } as never, { runtime });
    // 40 was counted by the previous server process.
    tab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 40 }] }));
    await settle();

    assert.deepEqual(tab.frames.map((frame) => frame.kind), ['chat_subscribed', 'text', 'text']);
  });
});
