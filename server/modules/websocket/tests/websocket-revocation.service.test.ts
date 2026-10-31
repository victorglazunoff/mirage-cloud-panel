import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { readWebSocketToken } from '@/modules/websocket/services/websocket-auth.service.js';
import { attachWebSocketRevocationCheck } from '@/modules/websocket/services/websocket-server.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    terminateCount: number;
    terminate: () => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.terminateCount = 0;
  socket.terminate = () => {
    socket.terminateCount += 1;
  };
  return socket;
}

function createScheduler() {
  let callback: (() => void) | null = null;
  let wasCleared = false;
  return {
    setInterval(nextCallback: () => void) {
      callback = nextCallback;
      return 1 as unknown as NodeJS.Timeout;
    },
    clearInterval() {
      wasCleared = true;
    },
    tick() {
      callback?.();
    },
    cleared() {
      return wasCleared;
    },
  };
}

test('a socket whose sign-in was revoked is terminated on the next check', () => {
  const socket = createFakeSocket();
  const scheduler = createScheduler();
  let active = true;
  attachWebSocketRevocationCheck(socket as never, () => active, 15_000, scheduler);

  scheduler.tick();
  assert.equal(socket.terminateCount, 0);

  active = false;
  scheduler.tick();
  assert.equal(socket.terminateCount, 1);
  assert.equal(scheduler.cleared(), true);
});

test('the check stops with the socket and skips sockets that are not open', () => {
  const socket = createFakeSocket();
  const scheduler = createScheduler();
  let checks = 0;
  attachWebSocketRevocationCheck(socket as never, () => {
    checks += 1;
    return false;
  }, 15_000, scheduler);

  socket.readyState = WebSocket.CLOSING;
  scheduler.tick();
  assert.equal(checks, 0);
  assert.equal(socket.terminateCount, 0);

  socket.emit('close');
  assert.equal(scheduler.cleared(), true);
});

test('the socket token is read from ?token= first, then the Authorization header', () => {
  assert.equal(readWebSocketToken({ url: '/ws?token=abc', headers: { authorization: 'Bearer def' } } as never), 'abc');
  assert.equal(readWebSocketToken({ url: '/ws', headers: { authorization: 'Bearer def' } } as never), 'def');
  assert.equal(readWebSocketToken({ url: '/ws', headers: {} } as never), null);
});
