import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  createWebSocketServer,
  WEBSOCKET_MAX_PAYLOAD_BYTES,
} from '@/modules/websocket/services/websocket-server.service.js';

/**
 * Mirage: one frame from a signed-in client must not be able to make the
 * server buffer ws's default 100 MB. Attachments travel over HTTP
 * (POST /api/assets/images) — the socket only carries text and descriptors.
 */
test('the websocket gateway refuses frames above the payload limit and keeps normal ones', async () => {
  assert.ok(WEBSOCKET_MAX_PAYLOAD_BYTES <= 16 * 1024 * 1024);
  assert.ok(WEBSOCKET_MAX_PAYLOAD_BYTES >= 4 * 1024 * 1024, 'a long pasted prompt must still fit');

  const server = createServer();
  const wss = createWebSocketServer(server, {
    verifyClient: {
      isPlatform: true,
      authenticateWebSocket: () => ({ id: 1, username: 'alice' }),
    } as never,
    chat: {} as never,
    shell: {} as never,
    getPluginPort: () => null,
  });
  // The routes are not under test: swap them for an echo.
  wss.removeAllListeners('connection');
  wss.on('connection', (ws) => {
    // The gateway's heartbeat listens for 'error' on every socket; so does the echo.
    ws.on('error', () => undefined);
    ws.on('message', (data) => ws.send(`got ${(data as Buffer).length}`));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    assert.equal(wss.options.maxPayload, WEBSOCKET_MAX_PAYLOAD_BYTES);

    const client = new WebSocket(`ws://127.0.0.1:${port}/echo-test`);
    await once(client, 'open');
    client.send('x'.repeat(1024 * 1024));
    const [reply] = await once(client, 'message');
    assert.equal(String(reply), `got ${1024 * 1024}`);

    client.send(Buffer.alloc(WEBSOCKET_MAX_PAYLOAD_BYTES + 1));
    const [code] = await once(client, 'close');
    assert.equal(code, 1009);
  } finally {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.close();
  }
});
