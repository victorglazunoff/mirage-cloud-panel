import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({
    plugins: [
      { name: 'prism', displayName: 'PRISM', version: '1.2.0', enabled: true, server: 'server.js', serverRunning: true },
      { name: 'session-manager', displayName: 'Sessions', version: '0.9.4', enabled: false, server: null, serverRunning: false },
    ],
    loading: false,
    pluginsError: null,
    togglePlugin: vi.fn(async () => ({ success: true, error: null })),
    installPlugin: vi.fn(async () => ({ success: true })),
  }),
}));

vi.mock('@/modules/auth', () => ({
  useAuth: () => ({ adoptToken: vi.fn(), logout: vi.fn() }),
}));

vi.mock('@/modules/settings', () => ({
  useWebPush: () => ({ permission: 'default', isSubscribed: false, isLoading: false, subscribe: vi.fn(), unsubscribe: vi.fn() }),
}));

import { KabinaSettingsScreen } from '@/modules/kabina-settings';

const SETTINGS = {
  claude: { permissionMode: 'default', model: 'opus', effort: 'high', artifacts: true, workflows: true, silenceCeilingMin: 30, midTurnMessage: 'inject' },
  voice: { language: 'ru', engine: 'yandex', sendOnRelease: true, speakReplies: false, hotkey: 'Alt+Space' },
  notifications: {
    channels: { telegram: true, max: false, browser: true },
    events: { turnComplete: false, backgroundDone: false, approvalNeeded: true, limit80: false },
    quietHours: { enabled: true, from: '23:00', to: '08:00' },
  },
  home: { widgets: [{ id: 'fav', enabled: true }, { id: 'work', enabled: true }, { id: 'cal', enabled: false }] },
  appearance: { theme: 'cabin', density: 'normal' },
};

const VIEW = { settings: SETTINGS, claudeSettings: { path: '/root/.claude/settings.json', exists: true, readable: true, error: null }, savedAt: '2026-10-26T09:18:00.000Z', server: { homeDir: '/root', isRoot: true } };

const TELEGRAM_UNLINKED = { configured: true, polling: false, botUsername: 'example_bot', linked: false, linkSource: null, chat: null, linkedAt: null };
const TELEGRAM_LINKED = { ...TELEGRAM_UNLINKED, linked: true, linkSource: 'bot', chat: { username: 'owner', title: null }, linkedAt: '2026-10-26T09:00:00Z' };

function stubApi(telegramStatus: unknown = TELEGRAM_UNLINKED) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/notifications/telegram/status') return json({ success: true, data: telegramStatus });
    if (url === '/api/notifications/telegram/test') return json({ success: true, data: { sent: true } });
    if (url === '/api/mirage-settings' && init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body));
      return json({ success: true, data: { ...VIEW, settings: { ...SETTINGS, claude: { ...SETTINGS.claude, ...patch.claude } } } });
    }
    if (url === '/api/mirage-settings') return json({ success: true, data: VIEW });
    if (url === '/api/auth/2fa/status') return json({ enabled: false, enabledAt: null, pendingSetup: false, backupCodesLeft: 0, trustedDevices: 0 });
    if (url === '/api/auth/sessions') {
      return json({ sessions: [
        { id: 'a', deviceLabel: 'MacBook · Chrome', deviceKind: 'laptop', userAgent: null, ipAddress: '10.0.0.1', createdAt: '2026-10-20T10:00:00Z', lastSeenAt: '2026-10-26T09:00:00Z', current: true },
        { id: 'b', deviceLabel: 'iPhone · Safari', deviceKind: 'phone', userAgent: null, ipAddress: '10.0.0.2', createdAt: '2026-10-21T10:00:00Z', lastSeenAt: '2026-10-26T07:00:00Z', current: false },
      ] });
    }
    if (url === '/api/auth/trusted-devices') return json({ devices: [] });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(section: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings/${section}`]}>
      <KabinaSettingsScreen section={section} renderClassic={(tab) => <div role="dialog">classic {tab}</div>} />
    </MemoryRouter>,
  );
}

describe('KabinaSettingsScreen', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the Claude section with live summaries and autosaves a change', async () => {
    const fetchMock = stubApi();
    renderAt('claude');

    expect(await screen.findByRole('heading', { name: 'Claude', level: 1 })).toBeTruthy();
    expect(await screen.findByText('Default · Opus · high')).toBeTruthy();
    expect(screen.getByText(/Bypass недоступен под root/)).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, init]) => url === '/api/mirage-settings' && init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(String(patchCall![1]!.body))).toEqual({ claude: { permissionMode: 'plan' } });
    });
    expect(await screen.findByText(/СОХРАНЕНО · ТОЛЬКО ЧТО/)).toBeTruthy();
    expect(screen.getByText('Только читает и составляет план. Ничего не меняет, пока не одобришь.')).toBeTruthy();
  });

  it('lists sign-ins and offers to sign the others out', async () => {
    stubApi();
    renderAt('account');

    expect(await screen.findByText('iPhone · Safari')).toBeTruthy();
    // Two marks: beside «Выйти» on a wide screen, under the name on a phone (CSS shows one).
    expect(screen.getAllByText('ЭТО УСТРОЙСТВО')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Выйти везде, кроме этого' })).toBeTruthy();
    expect(screen.getByText('РЕКОМЕНДУЕМ')).toBeTruthy();
  });

  it('groups script sign-ins under their own cap and folds them past two', async () => {
    const scripts = Array.from({ length: 5 }, (_, index) => ({
      id: `s${index}`, deviceLabel: 'Неизвестное устройство', deviceKind: 'laptop', userAgent: 'curl/8.5.0', ipAddress: '127.0.0.1',
      createdAt: '2026-10-26T08:00:00Z', lastSeenAt: '2026-10-26T08:00:00Z', current: false,
    }));
    const fetchMock = stubApi();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/sessions') {
        return new Response(JSON.stringify({ sessions: [
          { id: 'a', deviceLabel: 'MacBook · Chrome', deviceKind: 'laptop', userAgent: null, ipAddress: '10.0.0.1', createdAt: '2026-10-20T10:00:00Z', lastSeenAt: '2026-10-26T09:00:00Z', current: true },
          ...scripts,
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return base(url, init);
    });
    renderAt('account');

    expect(await screen.findByText('СКРИПТЫ И ПРОГРАММЫ · 5')).toBeTruthy();
    expect(screen.getAllByText('Скрипт · curl')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Ещё 3 скрипта' }));
    expect(screen.getAllByText('Скрипт · curl')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Свернуть скрипты' }));
    expect(screen.getAllByText('Скрипт · curl')).toHaveLength(2);
  });

  it('notifications: a linked Telegram gets a real test message from the bot', async () => {
    const fetchMock = stubApi(TELEGRAM_LINKED);
    renderAt('notify');

    expect(await screen.findByText('Привязан @owner · бот @example_bot')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Отвязать' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Прислать тестовое/ }));
    expect(await screen.findByText(/Отправлено — проверь Telegram/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/notifications/telegram/test' && init?.method === 'POST')).toBe(true);
  });

  it('notifications: without a linked chat nothing goes to Telegram; quiet hours and the switch save', async () => {
    const fetchMock = stubApi(TELEGRAM_UNLINKED);
    renderAt('notify');

    expect(await screen.findByText('Не подключено · привяжи чат, и бот начнёт писать')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Привязать Telegram' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Прислать тестовое/ }));
    expect(await screen.findByText('Браузер не дал показать — включи пуш')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/notifications/telegram/test')).toBe(false);

    const from = screen.getByRole('textbox', { name: 'Тихие часы с' });
    fireEvent.change(from, { target: { value: '22:30' } });
    fireEvent.blur(from);
    await waitFor(() => {
      const patches = fetchMock.mock.calls
        .filter(([url, init]) => url === '/api/mirage-settings' && init?.method === 'PATCH')
        .map(([, init]) => JSON.parse(String(init!.body)));
      expect(patches).toContainEqual({ notifications: { quietHours: { enabled: true, from: '22:30', to: '08:00' } } });
    });

    // Without a linked chat the Telegram switch is off and locked; MAX offers «Подключить» instead of a switch.
    const telegramSwitch = screen.getByRole('switch', { name: 'Telegram' }) as HTMLButtonElement;
    expect(telegramSwitch.disabled).toBe(true);
    expect(telegramSwitch.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('switch', { name: 'MAX' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(screen.getByText(/Бота для MAX пока нет/)).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: 'Ход закончен' }));
    await waitFor(() => {
      const patches = fetchMock.mock.calls
        .filter(([url, init]) => url === '/api/mirage-settings' && init?.method === 'PATCH')
        .map(([, init]) => JSON.parse(String(init!.body)));
      expect(patches.some((patch) => patch.notifications?.events?.turnComplete !== undefined)).toBe(true);
    });
  });

  it('shows plugins from the authors\' API and opens classic settings from «Ещё»', async () => {
    stubApi();
    const { unmount } = renderAt('plugins');
    expect(await screen.findByText('prism · v1.2.0')).toBeTruthy();
    expect(screen.getByText('Выключен · не грузится')).toBeTruthy();
    unmount();

    renderAt('more');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Открыть' }))[0]);
    expect(await screen.findByRole('dialog')).toHaveProperty('textContent', 'classic agents');
  });
});
