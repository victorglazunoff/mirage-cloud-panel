import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useVoiceDelivery } from '@/modules/kabina-voice/hooks/useVoiceDelivery';
import type { VoiceCardView } from '@/modules/kabina-voice/utils/voiceActionPlan';
import type { ChatEchoAnnouncement, ServerEvent, VoiceIntentAction } from '@/shared/types';
import { subscribeChatEcho } from '@/shared/utils';

const sent: Array<Record<string, unknown>> = [];
let frameListener: ((frame: ServerEvent) => void) | null = null;
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    sendMessage: (message: Record<string, unknown>) => {
      sent.push(message);
      return true;
    },
    subscribe: (listener: (frame: ServerEvent) => void) => {
      frameListener = listener;
      return () => {
        frameListener = null;
      };
    },
  }),
}));

vi.mock('@/shared/api', () => ({ api: {}, readApiJson: async (response: Response) => response.json() }));

const ACTION: VoiceIntentAction = { id: 'm1', kind: 'message', summary: 'проверь', confidence: 0.9, text: 'Проверь цены на Берёзовой' };
const CARD = {
  id: 'm1', kind: 'message', kicker: '', title: 'Проверь цены', meta: '', whenBig: '', whenSmall: '',
  delivery: { kind: 'session', sessionId: 's-1', projectId: 'p-1' }, runnable: true,
} as unknown as VoiceCardView;

const heard: ChatEchoAnnouncement[] = [];
const stopListening = subscribeChatEcho((announcement) => heard.push(announcement));

afterEach(() => {
  sent.length = 0;
  heard.length = 0;
});

test('a refused steer is sent as a new turn and announced to the open chat', async () => {
  const { result } = renderHook(() => useVoiceDelivery([]));
  await act(async () => {
    const running = result.current.run([CARD], [ACTION]);
    const steer = sent.find((message) => message.type === 'chat.steer');
    frameListener?.({ kind: 'protocol_error', code: 'STEER_UNAVAILABLE', steerId: steer?.steerId } as unknown as ServerEvent);
    await running;
  });
  assert.equal(sent.at(-1)?.type, 'chat.send');
  assert.equal(heard.length, 1);
  assert.equal(heard[0].via, 'sent');
  assert.equal(heard[0].sessionId, 's-1');
  assert.equal(heard[0].content, 'Проверь цены на Берёзовой');
});

test('a taken steer is announced as steered', async () => {
  const { result } = renderHook(() => useVoiceDelivery([]));
  await act(async () => {
    const running = result.current.run([CARD], [ACTION]);
    const steer = sent.find((message) => message.type === 'chat.steer');
    frameListener?.({ kind: 'chat_steered', steerId: steer?.steerId, sessionId: 's-1' } as unknown as ServerEvent);
    await running;
  });
  assert.deepEqual(heard.map((item) => item.via), ['steered']);
  stopListening();
});
