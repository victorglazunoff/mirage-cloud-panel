import assert from 'node:assert/strict';
import { createRef } from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, test, vi } from 'vitest';

import { browserTimeZone, setPanelTimeZone } from '@/modules/kabina';
import ChatFeed from '@/modules/kabina-chat/ChatFeed';
import type { FeedItem } from '@/modules/kabina-chat/utils/chatFeed';

// The fixture times are Yekaterinburg wall clock (UTC+5): pin the panel zone.
beforeAll(() => setPanelTimeZone('Asia/Yekaterinburg'));
afterAll(() => setPanelTimeZone(browserTimeZone()));
afterEach(cleanup);

function renderFeed(items: FeedItem[], isProcessing = false) {
  const actions = { retry: vi.fn(), resume: vi.fn(), switchToSonnet: vi.fn() };
  render(
    <ChatFeed
      items={items}
      isPhone={false}
      scrollRef={createRef<HTMLDivElement>()}
      onScroll={() => undefined}
      hasMore={false}
      isLoadingMore={false}
      onLoadEarlier={() => undefined}
      isLoading={false}
      openArtifactId={null}
      onToggleArtifact={() => undefined}
      decision={null}
      emptyHint=""
      isProcessing={isProcessing}
      actions={actions}
      liveAgents={new Map()}
      now={0}
    />,
  );
  return actions;
}

const STOP: FeedItem = {
  // 14:31 by the panel's zone (Yekaterinburg, UTC+5).
  kind: 'stopped', key: 's', time: '14:31', at: new Date(Date.UTC(2026, 9, 26, 9, 31)),
  stop: { step: 22, editedFiles: 3, interrupted: 'Bash npm run shots' },
};

test('one stop mark: «■ ОСТАНОВЛЕНО · 14:31 · ШАГ 22», what was kept and «Продолжить с шага 22»', () => {
  const actions = renderFeed([STOP]);
  assert.ok(screen.getByRole('separator', { name: 'Ход остановлен' }).textContent?.includes('ОСТАНОВЛЕНО · 14:31 · ШАГ 22'));
  assert.ok(screen.getByText(/Правки до шага 22 сохранены — 3 файла/));
  assert.ok(screen.getByText('Bash npm run shots'));
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить с шага 22' }));
  assert.deepEqual(actions.resume.mock.calls[0], [22]);
  assert.equal(screen.queryByRole('button', { name: 'Откатить правки хода' }), null, 'no rollback API — no button');
});

test('an older stop mark has no actions', () => {
  renderFeed([STOP, { kind: 'user', key: 'u', message: { type: 'user', timestamp: '' }, text: 'дальше', time: '14:40', steeredAtStep: null }]);
  assert.equal(screen.queryByRole('button', { name: /Продолжить/ }), null);
});

test('API failure: retries ran out → «Повторить сейчас» and «Сменить модель на Sonnet»', () => {
  const actions = renderFeed([{ kind: 'apiError', key: 'e', time: '14:30', at: Date.now(), error: 529, savedStep: 14, retry: null, details: 'API Error: 529' }]);
  assert.ok(screen.getByText('Claude не ответил'));
  assert.ok(screen.getByText('API 529 · перегружен'));
  assert.ok(screen.getByText(/Ход сохранён на шаге 14/));
  fireEvent.click(screen.getByRole('button', { name: 'Повторить сейчас' }));
  fireEvent.click(screen.getByRole('button', { name: 'Сменить модель на Sonnet' }));
  assert.equal(actions.retry.mock.calls.length, 1);
  assert.equal(actions.switchToSonnet.mock.calls.length, 1);
});

test('API failure while Claude Code retries: the countdown, no retry button', () => {
  renderFeed([{
    kind: 'apiError', key: 'r', time: '14:30', at: Date.now(), error: 529, savedStep: 3,
    retry: { attempt: 2, maxRetries: 10, retryDelayMs: 20_000, errorStatus: 529, error: null }, details: '',
  }], true);
  assert.ok(screen.getByText(/Повторю сам через/));
  assert.ok(screen.getByText(/попытка 2 из 10/));
  assert.equal(screen.queryByRole('button', { name: 'Повторить сейчас' }), null);
});

test('the user reply shows the picture and the file sent with it', () => {
  const message = {
    type: 'user',
    content: 'Какого цвета картинка?',
    images: [{ name: 'red.png', data: 'data:image/png;base64,iVBORw0KGgo=' }],
    files: [{ name: 'note.txt', path: '/assets/note.txt', size: 10 }],
    timestamp: new Date(),
  } as unknown as Extract<FeedItem, { kind: 'user' }>['message'];
  renderFeed([{ kind: 'user', key: 'u', message, text: 'Какого цвета картинка?', time: '21:36', steeredAtStep: null }]);
  assert.equal(screen.queryAllByRole('img', { name: 'red.png' }).length, 1, 'the picture');
  assert.equal(screen.queryAllByText('note.txt').length, 1, 'the file card');
  assert.equal(screen.queryAllByText('Какого цвета картинка?').length, 1);
});
