import assert from 'node:assert/strict';

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useActivityToasts } from '@/modules/kabina/hooks/useActivityToasts';
import type { HomeActivityItem, HomeOverview } from '@/shared/types';

const feed = vi.hoisted(() => ({ overview: null as HomeOverview | null }));
const toasts = vi.hoisted(() => ({ show: vi.fn(), dismiss: vi.fn(), items: [] as Array<{ id: string; kind: string }> }));

vi.mock('@/shared/hooks/useHomeOverviewFeed', () => ({
  useHomeOverviewFeed: () => ({ overview: feed.overview, error: null, refresh: () => undefined }),
}));

vi.mock('@/modules/kabina/context/KabinaToastContext', () => ({
  useKabinaToasts: () => toasts,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  toasts.items = [];
});

function item(sessionId: string, state: HomeActivityItem['state'], startedAt: number, extra: Partial<HomeActivityItem> = {}): HomeActivityItem {
  return {
    sessionId, provider: 'claude', projectId: 'p-zag', projectName: 'Сайт клиента', sessionTitle: 'выкладка',
    state, startedAt, external: false, permission: null, tasks: [], ...extra,
  };
}

function overviewWith(activity: HomeActivityItem[]): HomeOverview {
  return { activity } as unknown as HomeOverview;
}

function Watcher() {
  useActivityToasts(null);
  return null;
}

test('a turn that took under a minute is «меньше минуты», not «только что»', () => {
  feed.overview = overviewWith([item('s1', 'running', Date.now() - 20_000)]);
  const view = render(<Watcher />);
  feed.overview = overviewWith([]);
  act(() => view.rerender(<Watcher />));
  const entry = toasts.show.mock.calls.at(-1)?.[0] as { title: string; sub: string };
  assert.equal(entry.title, 'Ход закончен');
  assert.equal(entry.sub, 'выкладка · меньше минуты');
});

test('after a reload, a stored «Нужно твоё решение» whose session no longer waits is dropped', () => {
  toasts.items = [{ id: 'wait-gone', kind: 'wait' }, { id: 'wait-still', kind: 'wait' }, { id: 'done-x', kind: 'ok' }];
  feed.overview = overviewWith([item('still', 'waiting', Date.now() - 60_000), item('gone', 'running', Date.now() - 60_000)]);
  render(<Watcher />);
  assert.deepEqual(toasts.dismiss.mock.calls.map(([id]) => id), ['wait-gone']);
  assert.equal(toasts.show.mock.calls.length, 0, 'the baseline raises nothing');
});
