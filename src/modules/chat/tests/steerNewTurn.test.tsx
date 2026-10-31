import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: vi.fn() } } }));

const echo = (id: string, steerId: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role: 'user',
  provider: 'claude',
  sessionId: 's-1',
  content: `сообщение ${id}`,
  timestamp: '2026-10-29T08:00:00.000Z',
  steered: true,
  steerId,
} as NormalizedMessage);

test('a steer that ran as a request of its own loses «вклинено» live, as history shows it', () => {
  const { result } = renderHook(() => useSessionStore());
  act(() => {
    result.current.setActiveSession('s-1');
    result.current.appendRealtime('s-1', echo('a', 'steer-a'));
    result.current.appendRealtime('s-1', echo('b', 'steer-b'));
  });
  act(() => result.current.unmarkSteered('s-1', 'steer-b'));
  const rows = result.current.getMessages('s-1');
  assert.deepEqual(rows.map((row) => [row.id, Boolean(row.steered)]), [['a', true], ['b', false]]);
});
