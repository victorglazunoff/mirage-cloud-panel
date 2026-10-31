import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useChatEcho } from '@/modules/kabina-chat/hooks/useChatEcho';
import { announceChatEcho } from '@/shared/utils';

const markSessionProcessing = vi.fn();
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useSessionProtectionActions: () => ({ markSessionProcessing }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function renderChat(sessionId: string | null) {
  const addMessage = vi.fn();
  const setIsUserScrolledUp = vi.fn();
  const view = renderHook(() => useChatEcho({ sessionId, addMessage, setIsUserScrolledUp, scrollToBottom: vi.fn() }));
  return { addMessage, setIsUserScrolledUp, unmount: view.unmount };
}

test('a voice message that started a new turn shows in the open chat at once', () => {
  const chat = renderChat('s-1');
  const other = renderChat('s-2');
  act(() => announceChatEcho({ sessionId: 's-1', content: 'Проверь цены на Берёзовой', at: '2026-10-26T09:00:00.000Z', via: 'sent' }));

  assert.equal(chat.addMessage.mock.calls.length, 1);
  const line = chat.addMessage.mock.calls[0][0];
  assert.equal(line.type, 'user');
  assert.equal(line.content, 'Проверь цены на Берёзовой');
  assert.equal(new Date(line.timestamp).toISOString(), '2026-10-26T09:00:00.000Z');
  assert.equal(markSessionProcessing.mock.calls[0][0], 's-1', 'the turn shows as running');
  assert.deepEqual(chat.setIsUserScrolledUp.mock.calls, [[false]], 'the feed follows the new line');
  assert.equal(other.addMessage.mock.calls.length, 0, 'another dialog is not touched');
});

test('a steered message is left to the server frame, and a closed chat hears nothing', () => {
  const chat = renderChat('s-1');
  act(() => announceChatEcho({ sessionId: 's-1', content: 'вклинь', at: new Date().toISOString(), via: 'steered' }));
  assert.equal(chat.addMessage.mock.calls.length, 0, '`chat_steered` draws it with «вклинено»');

  chat.unmount();
  act(() => announceChatEcho({ sessionId: 's-1', content: 'ещё', at: new Date().toISOString(), via: 'sent' }));
  assert.equal(chat.addMessage.mock.calls.length, 0);
});
