import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import type { KabinaProjectRef } from '@/shared/types';

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ connectionStatus: 'connected', reconnectNow: vi.fn(), subscribe: () => () => undefined }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    home: {
      overview: vi.fn(async () => new Response(JSON.stringify({ data: { activity: [] } }))),
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));

vi.setConfig({ testTimeout: 30_000 });

const PROJECTS: KabinaProjectRef[] = [
  { projectId: 'p-zag', displayName: 'Сайт клиента', path: '/home/user/demo-site', isStarred: true },
];

const probe = { location: '' };
function LocationProbe() {
  const location = useLocation();
  useEffect(() => {
    probe.location = `${location.pathname}${location.search}`;
  }, [location]);
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAt(path: string, isPhone = false) {
  const { KabinaApp } = await import('@/modules/kabina');
  render(
    <MemoryRouter initialEntries={[path]}>
      <KabinaApp
        isPhone={isPhone}
        projects={PROJECTS}
        chatTitle={{ projectName: 'Сайт клиента', sessionTitle: 'Чат', dialogTitle: 'Выкладка цен' }}
        describeSettingsSection={(section) => (section === 'voice' ? { id: 'voice', name: 'Голос' } : { id: 'claude', name: 'Claude' })}
        renderHome={() => <p>главный экран</p>}
        renderChat={() => <p>чат</p>}
        renderAgents={() => <p>агенты</p>}
        renderProjects={() => <p>проекты</p>}
        renderFiles={(projectId) => <p>{`файлы: ${projectId ?? 'сервер'}`}</p>}
        renderSettings={(section) => <p>{`настройки: ${section ?? 'claude'}`}</p>}
        renderCalendar={() => <p>календарь</p>}
        renderSearch={() => null}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
  await flush();
}

afterEach(() => {
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

test('Files is a toggle: from a chat it opens the project files, the same button returns to the dialog', async () => {
  await renderAt('/p/p-zag/s/s-1');
  fireEvent.click(screen.getByRole('link', { name: 'Файлы' }));
  await flush();
  assert.equal(probe.location, '/files?project=p-zag');
  const toggle = screen.getByRole('link', { name: /Файлы открыты/ });
  assert.equal(toggle.getAttribute('aria-current'), 'page');
  assert.equal(toggle.getAttribute('title'), 'Вернуться в «Сайт клиента · Выкладка цен»');
  fireEvent.click(toggle);
  await flush();
  assert.equal(probe.location, '/p/p-zag/s/s-1');
});

test('Settings is a toggle too, and section changes inside settings do not move the way back', async () => {
  await renderAt('/calendar');
  fireEvent.click(screen.getByRole('link', { name: 'Настройки' }));
  await flush();
  assert.equal(probe.location, '/settings');
  const trail = screen.getByRole('navigation', { name: 'Где ты' });
  fireEvent.click(within(trail).getByRole('link', { name: 'Настройки' }));
  await flush();
  fireEvent.click(screen.getByRole('link', { name: /Настройки открыты/ }));
  await flush();
  assert.equal(probe.location, '/calendar');
});

test('Esc on Files returns, but not while typing in a field', async () => {
  await renderAt('/agents');
  fireEvent.click(screen.getByRole('link', { name: 'Файлы' }));
  await flush();
  assert.equal(probe.location, '/files');
  const field = document.createElement('input');
  document.body.appendChild(field);
  fireEvent.keyDown(field, { key: 'Escape' });
  await flush();
  assert.equal(probe.location, '/files', 'Esc in a field stays');
  field.remove();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  await flush();
  assert.equal(probe.location, '/agents');
});

test('phone: «‹» on Settings leads back to where the panel was', async () => {
  await renderAt('/calendar', true);
  fireEvent.click(screen.getByRole('link', { name: 'Настройки' }));
  await flush();
  const back = screen.getByRole('link', { name: 'Назад. Вернуться в «Календарь»' });
  fireEvent.click(back);
  await flush();
  assert.equal(probe.location, '/calendar');
});

test('crumbs are links: files of the project, settings section, calendar', async () => {
  await renderAt('/files?project=p-zag');
  let trail = screen.getByRole('navigation', { name: 'Где ты' });
  assert.equal(within(trail).getByRole('link', { name: 'Файлы' }).getAttribute('href'), '/files');
  const project = within(trail).getByRole('link', { name: 'Сайт клиента' });
  assert.equal(project.getAttribute('href'), '/files?project=p-zag');
  assert.equal(project.getAttribute('aria-current'), 'page');
  assert.equal(within(trail).getByRole('link', { name: 'Mirage — главный экран' }).getAttribute('href'), '/');
  fireEvent.click(within(trail).getByRole('link', { name: 'Файлы' }));
  await flush();
  assert.equal(probe.location, '/files');

  await renderAt('/settings/voice');
  trail = screen.getAllByRole('navigation', { name: 'Где ты' }).at(-1) as HTMLElement;
  assert.equal(within(trail).getByRole('link', { name: 'Голос' }).getAttribute('href'), '/settings/voice');
  assert.equal(within(trail).getByRole('link', { name: 'Настройки' }).getAttribute('href'), '/settings');
});
