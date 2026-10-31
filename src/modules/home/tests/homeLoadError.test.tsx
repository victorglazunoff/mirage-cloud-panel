import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

const feed = vi.hoisted(() => ({ refresh: vi.fn(async () => undefined) }));

vi.mock('@/modules/auth', () => ({
  useAuth: () => ({ user: { id: 1, username: 'иван' }, token: 'token', isLoading: false }),
}));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined, sendMessage: () => true }),
}));

// The first read of the summary failed and nothing is cached.
vi.mock('@/shared/hooks/useHomeOverviewFeed', () => ({
  useHomeOverviewFeed: () => ({ overview: null, error: 'Нет связи с сервером', refresh: feed.refresh }),
}));

const unavailable = () => new Response(JSON.stringify({ success: false }), { status: 503 });

vi.mock('@/shared/api', () => ({
  api: {
    home: { limits: vi.fn(async () => unavailable()) },
    calendar: { events: vi.fn(async () => unavailable()) },
    mirageSettings: { get: vi.fn(async () => unavailable()) },
  },
  readApiJson: async (response: Response) => {
    if (!response.ok) throw new Error('Сервер ответил ошибкой (503)');
    return response.json();
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('a failed first read shows «Сводка не загрузилась» with «Повторить», not an endless skeleton', async () => {
  const { HomeScreen } = await import('@/modules/home');
  render(
    <HomeScreen
      projects={[]}
      isMobile={false}
      onOpenSession={vi.fn()}
      onOpenProject={vi.fn()}
      onOpenProjectList={vi.fn()}
    />,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const alert = screen.getByRole('alert');
  assert.match(alert.textContent ?? '', /Сводка не загрузилась/);
  assert.match(alert.textContent ?? '', /Нет связи с сервером/);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  assert.equal(feed.refresh.mock.calls.length, 1);
});
