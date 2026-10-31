import assert from 'node:assert/strict';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useHomeOverviewFeed } from '@/shared/hooks/useHomeOverviewFeed';

const overview = vi.fn(async () => new Response(JSON.stringify({ data: { activity: [], projectCount: 4 } })));

vi.mock('@/shared/api', () => ({
  api: { home: { overview: () => overview() } },
  readApiJson: async (response: Response) => response.json(),
}));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined }),
}));

afterEach(cleanup);

function Reader({ name }: { name: string }) {
  const { overview: answer } = useHomeOverviewFeed();
  return <span>{`${name}: ${answer?.projectCount ?? '…'}`}</span>;
}

test('the home screen and the shell watcher share one /api/home/overview poll', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    render(
      <>
        <Reader name="главный" />
        <Reader name="колокол" />
      </>,
    );
    await waitFor(() => assert.ok(screen.getByText('колокол: 4')));
    assert.ok(screen.getByText('главный: 4'));
    assert.equal(overview.mock.calls.length, 1, 'two readers, one request');

    await vi.advanceTimersByTimeAsync(8_100);
    assert.equal(overview.mock.calls.length, 2, 'one poll tick for both readers');
  } finally {
    vi.useRealTimers();
  }
});
