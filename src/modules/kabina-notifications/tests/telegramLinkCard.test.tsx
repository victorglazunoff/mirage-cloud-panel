import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { TelegramLinkCard } from '@/modules/kabina-notifications';

type Status = {
  configured: boolean;
  polling: boolean;
  botUsername: string | null;
  linked: boolean;
  linkSource: 'bot' | 'env' | null;
  chat: { username: string | null; title: string | null } | null;
  linkedAt: string | null;
};

const server = vi.hoisted(() => ({
  status: null as unknown,
  calls: [] as Array<{ url: string; method: string }>,
}));

vi.mock('@/shared/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, options: { method?: string } = {}) => {
    const method = options.method ?? 'GET';
    server.calls.push({ url, method });
    if (url.endsWith('/status')) return new Response(JSON.stringify({ success: true, data: server.status }));
    if (method === 'POST') {
      return new Response(JSON.stringify({
        success: true,
        data: {
          code: 'AbCdEfGhIjKlMnOpQrStUv',
          url: 'https://t.me/example_bot?start=AbCdEfGhIjKlMnOpQrStUv',
          botUsername: 'example_bot',
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        },
      }));
    }
    return new Response(JSON.stringify({ success: true, data: { unlinked: true } }));
  }),
  readApiJson: async (response: Response) => response.json(),
}));

const UNLINKED: Status = {
  configured: true, polling: true, botUsername: 'example_bot', linked: false, linkSource: null, chat: null, linkedAt: null,
};
const LINKED: Status = {
  ...UNLINKED, linked: true, linkSource: 'bot', chat: { username: 'owner', title: 'Иван' }, linkedAt: '2026-10-26T10:00:00Z',
};

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  server.calls = [];
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('without a bot token the row says «не подключено» and offers no action', async () => {
  server.status = { ...UNLINKED, configured: false, botUsername: null };
  render(<TelegramLinkCard />);
  await flush();
  assert.ok(screen.getByText('Не подключено · бот не настроен на сервере'));
  assert.equal(screen.queryByRole('button'), null);
});

test('«Привязать Telegram» issues a code, opens t.me in a new tab, counts down and waits for /start', async () => {
  server.status = UNLINKED;
  const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
  const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);

  render(<TelegramLinkCard />);
  await flush();
  assert.ok(screen.getByText('Не подключено · привяжи чат, и бот начнёт писать'));

  fireEvent.click(screen.getByRole('button', { name: 'Привязать Telegram' }));
  await flush();
  assert.equal(open.mock.calls[0]?.[1], '_blank');
  assert.equal(tab.location.href, 'https://t.me/example_bot?start=AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(tab.opener, null);
  assert.ok(screen.getByText('Открой ссылку в Telegram и нажми «Старт»'));
  assert.ok(screen.getByText('AbCdEfGhIjKlMnOpQrStUv'));
  assert.ok(screen.getByText('15:00'));
  assert.equal((screen.getByRole('link', { name: /example_bot/ }) as HTMLAnchorElement).target, '_blank');

  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  assert.ok(screen.getByText('14:59'));

  // The bot got /start: the next status poll shows the linked chat.
  server.status = LINKED;
  await act(async () => {
    vi.advanceTimersByTime(3_000);
  });
  await flush();
  assert.ok(screen.getByText('Привязан @owner · бот @example_bot'));
  assert.ok(screen.getByRole('button', { name: 'Отвязать' }));
  assert.equal(screen.queryByText('AbCdEfGhIjKlMnOpQrStUv'), null);
});

test('an expired code offers a new one', async () => {
  server.status = UNLINKED;
  vi.spyOn(window, 'open').mockReturnValue(null);
  render(<TelegramLinkCard />);
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Привязать Telegram' }));
  await flush();
  await act(async () => {
    vi.advanceTimersByTime(15 * 60_000);
  });
  assert.ok(screen.getByText('Код истёк — получи новый'));
  assert.ok(screen.getByRole('button', { name: 'Новый код' }));
});

test('a linked chat shows @username and «Отвязать» unlinks it', async () => {
  server.status = LINKED;
  render(<TelegramLinkCard />);
  await flush();
  assert.ok(screen.getByText('Привязан @owner · бот @example_bot'));

  server.status = UNLINKED;
  fireEvent.click(screen.getByRole('button', { name: 'Отвязать' }));
  await flush();
  assert.ok(server.calls.some((call) => call.method === 'DELETE' && call.url === '/api/notifications/telegram/link'));
  assert.ok(screen.getByRole('button', { name: 'Привязать Telegram' }));
});
