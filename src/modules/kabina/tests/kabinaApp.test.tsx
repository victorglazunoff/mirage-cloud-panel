import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { publishMirageSettingsView } from '@/shared/hooks/useMirageSettingsView';
import type { KabinaProjectRef, MirageSettingsView } from '@/shared/types';

const socket = {
  connectionStatus: 'connected' as 'connected' | 'disconnected' | 'connecting',
  reconnectNow: vi.fn(),
  subscribe: () => () => undefined,
};

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => socket,
}));

vi.mock('@/shared/api', () => ({
  api: {
    home: {
      overview: vi.fn(async () => new Response(JSON.stringify({ data: { activity: [] } }))),
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));

const PROJECTS: KabinaProjectRef[] = [
  { projectId: 'p-zag', displayName: 'Сайт клиента', path: '/root/demo-site', isStarred: true },
  { projectId: 'p-map', displayName: 'Карта участков', path: '/root/demo-map', isStarred: false },
];

const probe = { location: '' };
function LocationProbe() {
  const location = useLocation();
  useEffect(() => {
    probe.location = `${location.pathname}${location.search}`;
  }, [location]);
  return null;
}

async function renderAt(path: string, isPhone = false) {
  const { KabinaApp } = await import('@/modules/kabina');
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <KabinaApp
        isPhone={isPhone}
        projects={PROJECTS}
        chatTitle={{ projectName: 'Сайт клиента', sessionTitle: 'Выкладка цен' }}
        renderHome={() => <p>главный экран</p>}
        renderChat={() => <p>чат авторов</p>}
        renderAgents={() => <p>экран агентов</p>}
        renderProjects={() => <p>экран проектов</p>}
        renderFiles={(projectId) => <p>{`экран файлов: ${projectId ?? 'нет'}`}</p>}
        renderSettings={(section) => <p>настройки авторов: {section ?? 'agents'}</p>}
        renderSearch={(onClose) => (
          <div role="dialog" aria-label="Поиск по всей панели">
            <button type="button" onClick={onClose}>закрыть поиск</button>
          </div>
        )}
        renderVoice={(slot) => (
          <div role="dialog" aria-label="ГОЛОС" data-holding={String(slot.holding)} data-session={slot.activeSessionId ?? ''} />
        )}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return utils;
}

beforeEach(() => {
  socket.connectionStatus = 'connected';
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  publishMirageSettingsView(null);
});

test('the shell frames every screen: header, voice button and the screen for the address', async () => {
  await renderAt('/');
  assert.ok(screen.getByText('главный экран'));
  assert.ok(screen.getByRole('link', { name: 'Mirage — главный экран' }));
  assert.ok(screen.getByRole('link', { name: 'Файлы' }));
  assert.ok(screen.getByRole('link', { name: 'Настройки' }));
  assert.ok(screen.getByRole('button', { name: /Сказать Claude голосом/ }));
  // The key part is its own .kb-keys span (hidden under a thumb), so the hint is read as a whole.
  assert.ok(screen.getByText((_, element) => element?.classList.contains('kb-voice-hint') === true && element.textContent === 'удерживай ⌥ Пробел'));
});

test('chat addresses render the chat with the project trail and a header slot for the dialog', async () => {
  const { container } = await renderAt('/p/p-zag/s/s-1');
  assert.ok(screen.getByText('чат авторов'));
  const trail = screen.getByRole('navigation', { name: 'Где ты' });
  assert.ok(trail.textContent?.includes('Сайт клиента'));
  // ChatLayoutB: the dialog title and the project tabs are the chat's own, in the header slot.
  assert.ok(container.querySelector('.kb-header[data-slot] .kb-header-slot'));
  assert.ok(screen.getByRole('button', { name: /Найти в диалогах Сайт клиента/ }));
});

test('every screen shows the HUD with the limits; on a computer the bell lives there, not in the header', async () => {
  await renderAt('/agents');
  const hud = screen.getByRole('navigation', { name: 'Приборная строка' });
  assert.ok(within(hud).getByRole('button', { name: /Лимит недели|Неделя/ }));
  assert.equal(within(hud).queryByRole('button', { name: /Лимит сессии|Сессия 5 часов/ }), null);
  assert.ok(within(hud).getByRole('button', { name: /Уведомления/ }));
  assert.equal(screen.getAllByRole('button', { name: /Уведомления/ }).length, 1, 'one bell, no duplicate in the header');
});

test('/agents renders the agents screen slot', async () => {
  await renderAt('/agents');
  assert.ok(screen.getByText('экран агентов'));
});

test('later screens show the «скоро» page with a way to the classic interface', async () => {
  await renderAt('/calendar');
  assert.ok(screen.getByRole('heading', { level: 1, name: 'Календарь' }));
  assert.equal(screen.getByRole('link', { name: 'Открыть классический интерфейс' }).getAttribute('href'), '/classic');
});

test('settings open the authors\' settings for the asked section; unknown addresses go home', async () => {
  await renderAt('/settings/voice');
  assert.ok(screen.getByText('настройки авторов: voice'));
  await renderAt('/no-such-page');
  assert.equal(probe.location, '/');
});

test('the projects page renders the projects screen under the «Все проекты» trail', async () => {
  await renderAt('/projects');
  assert.ok(screen.getByText('экран проектов'));
  assert.ok(screen.getByRole('navigation', { name: 'Где ты' }).textContent?.includes('Все проекты'));
});

test('phone: bottom navigation marks the current section', async () => {
  await renderAt('/calendar', true);
  const nav = screen.getByRole('navigation', { name: 'Разделы' });
  const current = nav.querySelector('[aria-current="page"]');
  assert.ok(current?.textContent?.includes('Календарь'));
});

test('⌘K / Ctrl+K opens the search overlay from the URL; closing it drops `?search`', async () => {
  await renderAt('/');
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  assert.equal(probe.location, '/?search');
  assert.ok(screen.getByRole('dialog', { name: 'Поиск по всей панели' }));
  fireEvent.click(screen.getByRole('button', { name: 'закрыть поиск' }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(probe.location, '/');
});

test('holding ⌥ Space opens voice outside fields; one press inside a field is left to the field', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { container } = await renderAt('/');
  const input = document.createElement('input');
  container.appendChild(input);

  fireEvent.keyDown(input, { code: 'Space', key: ' ', altKey: true });
  act(() => { vi.advanceTimersByTime(400); });
  assert.equal(probe.location, '/', 'a single press in a field does not open voice');

  fireEvent.keyDown(input, { code: 'Space', key: ' ', altKey: true, repeat: true });
  assert.equal(probe.location, '/?voice', 'holding the keys in a field does');
  const overlay = screen.getByRole('dialog', { name: 'ГОЛОС' });
  assert.equal(overlay.dataset.holding, 'true', 'the voice slot hears the hold');
  fireEvent.keyUp(window, { code: 'Space', key: ' ' });
  assert.equal(screen.getByRole('dialog', { name: 'ГОЛОС' }).dataset.holding, 'false', 'and the release that sends the phrase');
});

test('the voice hotkey comes from settings: hints and the hold follow «Голос → Горячая клавиша»', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  publishMirageSettingsView({
    settings: { voice: { hotkey: 'Control+Shift+V' } },
    claudeSettings: { path: '/home/mirage/.claude/settings.json', exists: true, readable: true, error: null },
    server: { homeDir: '/home/mirage', isRoot: false },
    savedAt: null,
  } as unknown as MirageSettingsView);
  await renderAt('/');
  assert.ok(screen.getByText((_, element) => element?.classList.contains('kb-voice-hint') === true && element.textContent === 'удерживай ⌃ ⇧ V'));
  assert.equal(screen.getByRole('button', { name: /Сказать Claude голосом/ }).getAttribute('aria-keyshortcuts'), 'Control+Shift+V');

  fireEvent.keyDown(document.body, { code: 'Space', key: ' ', altKey: true });
  act(() => { vi.advanceTimersByTime(400); });
  assert.equal(probe.location, '/', '⌥ Space is no longer the voice key');

  fireEvent.keyDown(document.body, { code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true });
  act(() => { vi.advanceTimersByTime(400); });
  assert.equal(probe.location, '/?voice', 'holding the configured chord opens voice');
  assert.equal(screen.getByRole('dialog', { name: 'ГОЛОС' }).dataset.holding, 'true');
  fireEvent.keyUp(window, { code: 'ShiftLeft', key: 'Shift' });
  assert.equal(screen.getByRole('dialog', { name: 'ГОЛОС' }).dataset.holding, 'false', 'letting go of a modifier ends the hold');
});

test('a dropped socket: a thin «Нет связи» strip on any screen, «Сейчас» retries, the bell keeps a note', async () => {
  window.localStorage.removeItem('kabina.notifications.v1');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { rerender } = await renderAt('/');
  socket.connectionStatus = 'disconnected';
  const { KabinaApp } = await import('@/modules/kabina');
  rerender(
    <MemoryRouter initialEntries={['/']}>
      <KabinaApp
        isPhone={false}
        projects={PROJECTS}
        chatTitle={{ projectName: null, sessionTitle: null }}
        renderHome={() => <p>главный экран</p>}
        renderChat={() => null}
        renderAgents={() => null}
        renderProjects={() => null}
        renderFiles={() => null}
        renderSettings={() => null}
        renderSearch={() => null}
      />
    </MemoryRouter>,
  );
  act(() => { vi.advanceTimersByTime(2_600); });
  assert.ok(screen.getByText('Нет связи'));
  fireEvent.click(screen.getByRole('button', { name: 'Сейчас' }));
  assert.equal(socket.reconnectNow.mock.calls.length, 1);
  assert.ok(screen.getByRole('button', { name: 'Уведомления: 1 новое' }), 'one entry per outage in the bell');
});
