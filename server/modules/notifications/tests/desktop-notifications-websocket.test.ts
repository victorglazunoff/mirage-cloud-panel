import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, notificationChannelEndpointsDb, userDb } from '@/modules/database/index.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'desktop-notifications-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();
  userDb.createUser('alice', 'hash');
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

type FakeSocket = EventEmitter & { OPEN: 1; readyState: number; sent: unknown[]; send(data: string): void; close(): void };

function createFakeSocket(send?: (data: string) => void): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.OPEN = 1;
  socket.readyState = 1;
  socket.sent = [];
  socket.send = send ?? ((data: string) => {
    socket.sent.push(JSON.parse(data));
  });
  socket.close = () => {
    socket.readyState = 3;
    socket.emit('close');
  };
  return socket;
}

const request = { user: { id: 1, username: 'alice' } } as unknown as AuthenticatedWebSocketRequest;
const register = Buffer.from(JSON.stringify({ type: 'register', deviceId: 'mac-1', label: 'MacBook' }));

test('a device switched off stays off when its app reconnects', async () => {
  await withIsolatedDatabase(() => {
    const first = createFakeSocket();
    handleDesktopNotificationsConnection(first as unknown as WebSocket, request);
    first.emit('message', register);
    assert.deepEqual(first.sent, [{ type: 'registered', deviceId: 'mac-1', enabled: true }]);

    assert.equal(notificationChannelEndpointsDb.setEndpointEnabled(1, 'desktop', 'mac-1', false), true);
    first.close();

    const again = createFakeSocket();
    handleDesktopNotificationsConnection(again as unknown as WebSocket, request);
    again.emit('message', register);
    assert.deepEqual(again.sent, [{ type: 'registered', deviceId: 'mac-1', enabled: false }]);
    assert.equal(notificationChannelEndpointsDb.getEndpoint(1, 'desktop', 'mac-1')?.enabled, 0);
    again.close();
  });
});

test('an error while handling a desktop socket message is logged, not thrown', async () => {
  await withIsolatedDatabase(() => {
    const broken = createFakeSocket(() => {
      throw new Error('socket write failed');
    });
    handleDesktopNotificationsConnection(broken as unknown as WebSocket, request);
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      assert.doesNotThrow(() => broken.emit('message', register));
    } finally {
      console.error = originalError;
    }
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /desktop/i);
    broken.close();
  });
});
