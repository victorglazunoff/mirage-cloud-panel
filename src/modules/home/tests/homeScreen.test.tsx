import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { CalendarItem, HomeOverview, Project, SubscriptionLimits } from '@/shared/types';

const AUTH = { user: { id: 1, username: 'иван' }, token: 'token', isLoading: false };

vi.mock('@/modules/auth', () => ({
  useAuth: () => AUTH,
}));

const sendMessage = vi.fn(() => true);

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => undefined, sendMessage }),
}));

const NOW = Date.now();

const OVERVIEW: HomeOverview = {
  generatedAt: new Date(NOW).toISOString(),
  activity: [
    {
      sessionId: 'wait-1',
      provider: 'claude',
      projectId: 'p-zag',
      projectName: 'Сайт клиента',
      sessionTitle: 'Выкладка цен',
      state: 'waiting',
      startedAt: NOW - 5 * 60_000,
      external: false,
      permission: { requestId: 'req-1', toolName: 'Bash', summary: 'bash deploy.sh --prod', receivedAt: new Date(NOW - 2 * 60_000).toISOString() },
      tasks: [],
    },
    {
      sessionId: 'run-1',
      provider: 'claude',
      projectId: 'p-map',
      projectName: 'Карта участков',
      sessionTitle: 'SEO-тексты',
      state: 'running',
      startedAt: NOW - 12 * 60_000,
      external: false,
      permission: null,
      tasks: [],
    },
  ],
  favorites: [
    {
      projectId: 'p-map',
      displayName: 'Карта участков',
      projectPath: '/home/user/demo-map',
      lastActivity: new Date(NOW).toISOString(),
      lastSessionId: 'run-1',
      sessionCount: 4,
      activityByDay: [0, 1, 3, 2, 0, 0, 4, 6, 5, 7, 6, 8, 9, 7],
    },
  ],
  projectCount: 47,
  scheduled: [],
  recent: [],
};

/** `/api/calendar/events` for the week: a call later today (the home block shows calls, not only scheduled messages). */
const CALENDAR_ITEMS: CalendarItem[] = [{
  id: 'ev-call', source: 'panel', type: 'call', title: 'Перезвонить партнёру',
  startsAt: new Date(NOW + 60 * 60_000).toISOString(), endsAt: new Date(NOW + 90 * 60_000).toISOString(),
  projectId: null, projectName: null, contact: { name: 'Партнёр', phone: null, telegram: null }, location: null, note: null,
  remindBeforeMin: 15, status: 'planned', sessionId: null, recurrence: null, occurrenceOf: null, readOnly: false,
  preparedAt: null, allDay: false, google: null, agent: null, server: null,
}];

const LIMITS: SubscriptionLimits = {
  status: 'ok',
  reason: null,
  plan: 'MAX 20×',
  fetchedAt: new Date(NOW).toISOString(),
  session: { percent: 6, resetsAt: new Date(NOW + 4 * 3_600_000).toISOString() },
  weekly: { percent: 42, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
  weeklyByModel: [],
  credits: null,
};

// Home widgets of `/api/mirage-settings` (DarkSettings 03); null keeps the default set. Read lazily by the mock.
const widgetSettings: { current: Array<{ id: string; enabled: boolean }> | null } = { current: null };

const jsonResponse = (data: unknown) =>new Response(JSON.stringify({ success: true, data }), { status: 200 });

vi.mock('@/shared/api', () => ({
  api: {
    home: {
      overview: vi.fn(async () => jsonResponse(OVERVIEW)),
      limits: vi.fn(async () => jsonResponse(LIMITS)),
    },
    calendar: {
      events: vi.fn(async () => jsonResponse({ items: CALENDAR_ITEMS })),
    },
    mirageSettings: {
      get: vi.fn(async () => jsonResponse({ settings: { home: { widgets: widgetSettings.current } } })),
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));

const PROJECTS: Project[] = [{ projectId: 'p-map', displayName: 'Карта участков', fullPath: '/home/user/demo-map', isStarred: true }];

let handlers: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  handlers = {
    onOpenSession: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenProjectList: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenCalendar: vi.fn(),
    onOpenAgents: vi.fn(),
    onOpenLimits: vi.fn(),
    onOpenCalendarEvent: vi.fn(),
  };
  // jsdom has no layout; the board cells scroll to sections.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function renderHome(isMobile = false) {
  const { HomeScreen } = await import('@/modules/home');
  render(
    <HomeScreen
      projects={PROJECTS}
      isMobile={isMobile}
      onOpenSession={handlers.onOpenSession}
      onOpenProject={handlers.onOpenProject}
      onOpenProjectList={handlers.onOpenProjectList}
      onOpenSearch={handlers.onOpenSearch}
      onOpenCalendar={handlers.onOpenCalendar}
      onOpenAgents={handlers.onOpenAgents}
      onOpenLimits={handlers.onOpenLimits}
      onOpenCalendarEvent={handlers.onOpenCalendarEvent}
    />,
  );
  // Let the overview and limits fetches resolve.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('summary greets by name, reports who waits and the board opens the waiting dialog', async () => {
  await renderHome();
  assert.ok(screen.getByRole('heading', { level: 1 }).textContent?.endsWith(', Иван'));
  assert.ok(screen.getByText('Сайт клиента ждёт разрешения на Bash.', { exact: false }));
  const waitCell = screen.getByRole('listitem', { name: /ждёт тебя — открыть Сайт клиента/ });
  assert.equal(waitCell.textContent?.includes('01'), true);
  assert.equal(waitCell.getAttribute('data-tone'), 'wait');
  fireEvent.click(waitCell);
  assert.deepEqual(handlers.onOpenSession.mock.calls[0], ['wait-1', 'p-zag']);
});

test('the overview counts days in the panel zone, not the browser zone', async () => {
  const { api } = await import('@/shared/api');
  const { panelTimezoneOffset } = await import('@/modules/kabina');
  // A browser zone no real panel zone has, so the two offsets cannot coincide.
  const browserOffset = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(123);
  try {
    await renderHome();
    const offset = vi.mocked(api.home.overview).mock.calls[0]?.[0];
    assert.equal(offset, panelTimezoneOffset());
    assert.notEqual(offset, 123);
  } finally {
    browserOffset.mockRestore();
  }
});

test('"Ответить" opens the waiting session and a favourite opens its last dialog', async () => {
  await renderHome();
  fireEvent.click(screen.getByRole('button', { name: 'Ответить: Сайт клиента' }));
  assert.deepEqual(handlers.onOpenSession.mock.calls.at(-1), ['wait-1', 'p-zag']);

  fireEvent.click(screen.getByRole('button', { name: /^Карта участков: Агент работает/ }));
  assert.deepEqual(handlers.onOpenSession.mock.calls.at(-1), ['run-1', 'p-map']);
});

test('limits show the week gauge (no 5-hour one), hide credits without a source and link to details', async () => {
  await renderHome();
  assert.ok(screen.getByRole('heading', { name: 'ЛИМИТЫ · MAX 20×' }));
  assert.equal(screen.queryByRole('img', { name: /^Сессия/ }), null, 'the plan has no 5-hour window');
  assert.ok(screen.getByRole('img', { name: /^Неделя: 42%/ }));
  assert.equal(screen.queryByRole('img', { name: /^Кредиты/ }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Подробнее →' }));
  assert.equal(handlers.onOpenLimits.mock.calls.length, 1);
});

test('desktop sections follow DarkMain: numbered rulers 01–05 and «+ Событие»', async () => {
  await renderHome();
  const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
  assert.deepEqual(titles, ['ИЗБРАННОЕ', 'В РАБОТЕ', 'БОРТОВОЙ ЖУРНАЛ', 'КАЛЕНДАРЬ', 'ЛИМИТЫ · MAX 20×']);
  fireEvent.click(screen.getByRole('button', { name: 'Добавить событие' }));
  assert.equal(handlers.onOpenCalendar.mock.calls.length, 1);
});

test('widgets follow the settings: order and switches of «Главный экран»', async () => {
  widgetSettings.current = [
    { id: 'lim', enabled: true },
    { id: 'work', enabled: true },
    { id: 'cal', enabled: false },
    { id: 'fav', enabled: false },
  ];
  try {
    await renderHome();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    assert.deepEqual(titles, ['В РАБОТЕ', 'БОРТОВОЙ ЖУРНАЛ', 'ЛИМИТЫ · MAX 20×']);
    assert.equal(screen.queryByRole('button', { name: 'Добавить событие' }), null);
  } finally {
    widgetSettings.current = null;
  }
});

test('phone: widgets follow the settings order under «ждёт тебя»', async () => {
  widgetSettings.current = [
    { id: 'lim', enabled: true },
    { id: 'fav', enabled: true },
    { id: 'work', enabled: true },
    { id: 'cal', enabled: false },
  ];
  try {
    await renderHome(true);
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    assert.deepEqual(titles.filter((title) => title !== 'ЖДЁТ ТЕБЯ').slice(0, 2), ['ЛИМИТЫ · MAX 20×', 'ИЗБРАННОЕ']);
    assert.equal(titles.includes('СЕГОДНЯ'), false);
  } finally {
    widgetSettings.current = null;
  }
});

test('phone: the waiting card allows the prompt once over the chat socket', async () => {
  await renderHome(true);
  assert.ok(screen.getByRole('heading', { name: 'ЖДЁТ ТЕБЯ' }));
  assert.ok(screen.getByText('bash deploy.sh --prod', { selector: '.mh-wait-cmd-text' }));
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить Bash один раз' }));
  assert.deepEqual(sendMessage.mock.calls[0], [{ type: 'chat.permission-response', requestId: 'req-1', allow: true }]);
  assert.ok(screen.getByText('Сайт клиента · разрешено один раз'));
  assert.equal(screen.queryByRole('heading', { name: 'ЖДЁТ ТЕБЯ' }), null);
});

test('the calendar block shows calendar calls and opens them in the calendar', async () => {
  await renderHome();
  fireEvent.click(screen.getByRole('button', { name: /Перезвонить партнёру.*Открыть в календаре/ }));
  assert.equal(handlers.onOpenCalendarEvent.mock.calls[0][0], 'ev-call');
  assert.ok(screen.getByText(/до звонка «Перезвонить партнёру»/));
});

test('phone: search row, «Все · N» and the РАБОТАЮТ cell lead to their screens', async () => {
  await renderHome(true);
  fireEvent.click(screen.getByRole('button', { name: /Найти диалог/ }));
  assert.equal(handlers.onOpenSearch.mock.calls.length, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Все · 47 →' }));
  assert.equal(handlers.onOpenProjectList.mock.calls.length, 1);
  fireEvent.click(screen.getByRole('listitem', { name: /работают — открыть агентов/ }));
  assert.equal(handlers.onOpenAgents.mock.calls.length, 1);
});
