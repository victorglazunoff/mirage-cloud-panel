import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { registerChatSocketExtension } from '@/modules/websocket/services/chat-socket-extensions.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';

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

test('feature modules own their message types on /ws and hear about closed sockets', async () => {
  const handled: Array<[string, unknown]> = [];
  const closed: unknown[] = [];
  const unregister = registerChatSocketExtension({
    types: ['agents.subscribe'],
    handle: (_ws, data, context) => { handled.push([String(data.type), context.userId]); },
    onClose: (ws) => { closed.push(ws); },
  });
  try {
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 7 } } as never, { runtime: {} as never });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'agents.subscribe' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'agents.bogus' })));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.deepEqual(handled, [['agents.subscribe', 7]]);
    assert.deepEqual(socket.frames.map((frame) => [frame.kind, frame.code]), [['protocol_error', 'UNKNOWN_MESSAGE_TYPE']]);
    socket.emit('close');
    assert.deepEqual(closed, [socket]);
  } finally {
    unregister();
  }
});

test('an extension may not claim chat.* types', () => {
  assert.throws(() => registerChatSocketExtension({ types: ['chat.send'], handle: () => {} }));
});
