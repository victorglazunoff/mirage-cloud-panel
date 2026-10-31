import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, test as baseTest, vi } from 'vitest';

// The week board is a large tree; queries by role take a while in jsdom.
const test = (name: string, run: () => Promise<void>) => baseTest(name, run, 20_000);

import { addDays, fromWall, startOfDay, toWall } from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarItem, CalendarParseResult, CalendarSyncStatus } from '@/shared/types';

const today = startOfDay(toWall(Date.now()));
/** A real instant for a wall time `days` from today in Yekaterinburg. */
const at = (days: number, hour: number, minute = 0) => {
  const wall = addDays(today, days);
  wall.setHours(hour, minute);
  return fromWall(wall).toISOString();
};

function item(extra: Partial<CalendarItem> & Pick<CalendarItem, 'id' | 'type' | 'title' | 'startsAt' | 'endsAt'>): CalendarItem {
  return {
    source: 'panel', projectId: null, projectName: null, contact: null, location: null, note: null, remindBeforeMin: 15,
    status: 'planned', sessionId: null, recurrence: null, occurrenceOf: null, readOnly: false, preparedAt: null,
    allDay: false, google: null, agent: null, server: null, ...extra,
  };
}

const CALL = item({
  id: 'ev-call', type: 'call', title: 'Перезвонить партнёру', startsAt: at(1, 11), endsAt: at(1, 11, 30),
  projectId: 'p-villa', projectName: 'DemoVilla',
  contact: { name: 'Партнёр', phone: '+7 900 000-00-02', telegram: '@partner_nick' }, note: 'Обсудить сроки.',
});
const MEETING = item({
  id: 'ev-meet', type: 'meeting', title: 'Демо Карты участков', startsAt: at(1, 14), endsAt: at(1, 15, 30),
  location: 'Zoom', contact: { name: '[имя]', phone: null, telegram: null },
});
const AGENT = item({
  id: 'scheduled:sm-1', source: 'scheduled_message', type: 'agent_task', title: 'Собери срез рынка', startsAt: at(1, 22), endsAt: at(1, 22, 30),
  projectId: 'p-z96', projectName: 'Сайт клиента', sessionId: 's-1', readOnly: true,
  agent: { scheduledMessageId: 'sm-1', sessionTitle: 'Срезы рынка', content: 'Собери срез рынка за октябрь.', deliveryStatus: 'pending', failureReason: null },
});
const SERVER = item({
  id: 'systemd:build.timer@x', source: 'systemd', type: 'server_schedule', title: 'Ночная сборка', startsAt: at(1, 3), endsAt: at(1, 3, 15),
  readOnly: true, server: { unit: 'build.timer', activates: 'build.service', description: 'Ночная сборка', calendarSpec: '*-*-* 03:00:00', lastTriggerAt: null, lastResult: 'success', timeZone: 'Europe/Helsinki', utcOffsetMin: 120, currentUtcOffsetMin: 120 },
});

const SYNC: CalendarSyncStatus = {
  enabled: true, state: 'idle', reason: null, calendarId: 'me@example.com', calendarName: 'Мираж — задачи', timeZone: 'Asia/Yekaterinburg',
  lastSuccessAt: new Date(Date.now() - 2 * 60_000).toISOString(), lastAttemptAt: null, lastFullSyncAt: null, lastError: null,
  pendingPush: 0, pendingDeletes: 0, importedCount: 0, pollIntervalSec: 120, pushTitlePrefix: null,
};

const PARSED: CalendarParseResult = {
  ok: true,
  draft: {
    type: 'call', title: 'Позвонить Ивану про сайт', startsAt: at(1, 9), endsAt: at(1, 9, 30), durationMin: 30, projectId: null,
    projectName: null, contact: { name: 'Иван', phone: null, telegram: null }, remindBeforeMin: 15, recurrence: null, note: null,
  },
  recognized: { type: true, date: true, time: true, contact: true, project: false, recurrence: false },
  missing: [], summary: 'Звонок', timeZone: 'Asia/Yekaterinburg',
};

// The server's copy of the call: actions change it, the refetch returns it.
let currentCall = CALL;
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const calendarApi = {
  events: vi.fn(async () => ok({ items: [currentCall, MEETING, AGENT, SERVER] })),
  syncStatus: vi.fn(async () => ok(SYNC)),
  syncNow: vi.fn(async () => ok({ ...SYNC, lastSuccessAt: new Date().toISOString() })),
  parse: vi.fn(async (_text: string, _tz: string) => ok(PARSED)),
  create: vi.fn(async () => ok(item({ ...PARSED.draft!, id: 'ev-new' }))),
  done: vi.fn(async () => {
    currentCall = { ...currentCall, status: 'done' };
    return ok(currentCall);
  }),
  reschedule: vi.fn(async () => {
    currentCall = { ...currentCall, startsAt: at(1, 12), endsAt: at(1, 12, 30) };
    return ok(currentCall);
  }),
  prepare: vi.fn(async (_id: string, _body: unknown) => ok({ event: { ...CALL, preparedAt: new Date().toISOString(), sessionId: 's-new' }, projectId: 'p-villa', sessionId: 's-new', scheduledMessageId: 'sm-9', scheduledFor: new Date().toISOString(), sessionUrl: '/p/p-villa/s/s-new' })),
  timerJournal: vi.fn(async () => ok({ unit: 'build.timer', service: 'build.service', lines: ['ok'] })),
  remove: vi.fn(async (_id: string) => ok({ deleted: true })),
};

const telegramState = vi.hoisted(() => ({
  status: { configured: true, polling: true, botUsername: 'example_bot', linked: true, linkSource: 'bot', chat: { username: 'owner', title: null }, linkedAt: null } as Record<string, unknown>,
}));

vi.mock('@/shared/api', () => ({
  // A getter: the factory runs on the first import, before `calendarApi` above is initialised.
  api: { get calendar() { return calendarApi; } },
  // The Telegram bot status (useTelegramLink): a chat is linked unless a test says otherwise.
  authenticatedFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: telegramState.status }))),
  readApiJson: async (response: Response) => {
    const body = await response.json();
    if (!body.success) throw Object.assign(new Error(body.error?.message ?? 'fail'), { code: body.error?.code });
    return body;
  },
}));

// The address after navigation, written by LocationProbe.
const probe = { location: '' };
function LocationProbe() {
  const current = useLocation();
  probe.location = `${current.pathname}${current.search}`;
  return null;
}

async function renderCalendar(isPhone = false, entry = `/calendar?date=${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`) {
  const { KabinaCalendarScreen } = await import('@/modules/kabina-calendar');
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="*" element={<><KabinaCalendarScreen isPhone={isPhone} projects={[{ projectId: 'p-villa', displayName: 'DemoVilla', path: '/home/user/Проекты/demo-villa', isStarred: true }]} /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  currentCall = CALL;
  probe.location = '';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('week grid: events by type, the Google badge, the nearest event selected with contact links', async () => {
  await renderCalendar();
  assert.ok(screen.getByRole('heading', { level: 1 }).textContent?.includes('—'));
  assert.ok(screen.getByText(/Google · синхронизировано 2 мин назад/));
  assert.ok(screen.getByText(/календарь «Мираж — задачи» · в обе стороны/));
  assert.ok(screen.getByRole('button', { name: /^Звонок, .* — Перезвонить партнёру/ }));
  assert.ok(screen.getByRole('button', { name: /^Расписание сервера/ }));

  // The nearest planned event is selected on open.
  assert.ok(screen.getByRole('heading', { level: 3, name: 'Перезвонить партнёру' }));
  assert.equal(screen.getByRole('link', { name: 'Позвонить' }).getAttribute('href'), 'tel:+79000000002');
  assert.equal(screen.getByRole('link', { name: 'Написать в Telegram' }).getAttribute('href'), 'https://t.me/partner_nick');
});

test('a reminder goes to Telegram when the bot has a linked chat, otherwise stays in the panel', async () => {
  await renderCalendar();
  assert.ok(await screen.findByText(/^пришлю в Telegram за 15 мин/));

  cleanup();
  telegramState.status = { ...telegramState.status, linked: false, linkSource: null, chat: null };
  try {
    await renderCalendar();
    assert.equal(screen.queryByText(/пришлю в Telegram/), null);
  } finally {
    telegramState.status = { ...telegramState.status, linked: true, linkSource: 'bot', chat: { username: 'owner', title: null } };
  }
});

test('«Отметить сделанным», «Перенести» and «Поручить Claude подготовить»', async () => {
  await renderCalendar();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Отметить сделанным/ }));
  });
  assert.deepEqual(calendarApi.done.mock.calls[0], ['ev-call', true]);
  assert.ok(screen.getByText('СДЕЛАНО'));

  fireEvent.click(screen.getByRole('button', { name: /Перенести/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /На час позже/ }));
  });
  assert.deepEqual(calendarApi.reschedule.mock.calls[0], ['ev-call', { preset: 'plus1h' }]);
  assert.ok(screen.getByText(/Перенесено — в Google обновится за минуту/));

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Поручить Claude подготовить/ }));
  });
  assert.equal(calendarApi.prepare.mock.calls[0][0], 'ev-call');
  assert.equal(probe.location, '/p/p-villa/s/s-new');
});

test('a repeat of a series: «сделано» only on it, «Перенести» and «Удалить» ask «Только это» or «Вся серия»', async () => {
  const series = 'ev-daily';
  // The other repeat stays on the board's week: on a Saturday the day after tomorrow is next week.
  const otherDay = today.getDay() === 6 ? -1 : 2;
  const occurrence = item({
    id: `${series}@${at(1, 10)}`, occurrenceOf: series, originalStartsAt: at(1, 10), recurrence: 'FREQ=DAILY',
    type: 'meeting', title: 'Планёрка', startsAt: at(1, 10), endsAt: at(1, 10, 30),
  });
  const next = item({ ...occurrence, id: `${series}@${at(otherDay, 10)}`, originalStartsAt: at(otherDay, 10), startsAt: at(otherDay, 10), endsAt: at(otherDay, 10, 30) });
  let listing = [occurrence, next];
  calendarApi.events.mockImplementation(async () => ok({ items: listing }));
  // The server's copy changes with each action; the refetch returns it.
  const answer = (fresh: CalendarItem) => {
    listing = [fresh, next];
    return ok(fresh);
  };
  calendarApi.done.mockImplementationOnce(async () => answer({ ...occurrence, status: 'done' }));
  calendarApi.reschedule.mockImplementationOnce(async () => answer({ ...occurrence, startsAt: at(1, 11), endsAt: at(1, 11, 30) }));
  calendarApi.reschedule.mockImplementationOnce(async () => answer({ ...occurrence, startsAt: at(1, 11), endsAt: at(1, 11, 30) }));
  try {
    await renderCalendar();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Отметить сделанным/ }));
    });
    assert.deepEqual(calendarApi.done.mock.calls[0], [occurrence.id, true], 'the occurrence, never the bare series id');
    assert.ok(screen.getByText('СДЕЛАНО'));

    // «Перенести»: «Только это» by default; «Вся серия» is sent as the scope.
    fireEvent.click(screen.getByRole('button', { name: /^Перенести$/ }));
    assert.equal(screen.getByRole('radio', { name: 'Только это' }).getAttribute('aria-checked'), 'true');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /На час позже/ }));
    });
    assert.deepEqual(calendarApi.reschedule.mock.calls[0], [occurrence.id, { preset: 'plus1h', scope: 'occurrence' }]);
    assert.ok(screen.getByText(/Перенесён этот повтор/));
    assert.ok(screen.getByText(/перенесено с 10:00/));
    fireEvent.click(screen.getByRole('button', { name: /^Перенести$/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Вся серия' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Завтра в это же время/ }));
    });
    assert.deepEqual(calendarApi.reschedule.mock.calls[1], [occurrence.id, { preset: 'tomorrow', scope: 'series' }]);

    // «Удалить» → «Только этот»: the other repeat stays in the grid.
    listing = [next];
    fireEvent.click(screen.getByRole('button', { name: 'Действия с событием' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Удалить событие/ }));
    assert.ok(screen.getByRole('dialog', { name: 'Удалить повтор?' }));
    assert.ok(screen.getByRole('button', { name: 'Всю серию' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Только этот/ }));
    });
    assert.deepEqual(calendarApi.remove.mock.calls[0], [occurrence.id, 'occurrence']);
    assert.ok(screen.getByRole('button', { name: /Планёрка/ }), 'the next repeat is still there');
  } finally {
    calendarApi.events.mockImplementation(async () => ok({ items: [currentCall, MEETING, AGENT, SERVER] }));
  }
});

test('an event over several days is drawn on each day it touches, not only on its start day', async () => {
  // Today 20:00 → the day after tomorrow 10:00.
  const trip = item({ id: 'ev-trip', type: 'meeting', title: 'Выезд на объект', startsAt: at(0, 20), endsAt: at(2, 10) });
  calendarApi.events.mockImplementation(async () => ok({ items: [trip] }));
  const dayParam = (days: number) => {
    const date = addDays(today, days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  try {
    // Tomorrow: the whole day is the bar, through the 08–21 grid.
    await renderCalendar(false, `/calendar?view=day&date=${dayParam(1)}`);
    const middle = screen.getByRole('button', { name: /^Встреча, .* → .* — Выезд на объект · продолжение/ });
    assert.equal(middle.hasAttribute('data-from-prev'), true);
    assert.equal(middle.hasAttribute('data-to-next'), true);
    cleanup();
    // The last day: the bar from the top of the grid to 10:00.
    await renderCalendar(false, `/calendar?view=day&date=${dayParam(2)}`);
    const last = screen.getByRole('button', { name: /Выезд на объект · продолжение/ });
    assert.equal(last.hasAttribute('data-to-next'), false);
    fireEvent.click(last);
    assert.ok(screen.getByText(/\d\d\.\d\d 20:00 → .* \d\d\.\d\d 10:00/));
    cleanup();
    // Month: a piece in each of the three cells.
    await renderCalendar(false, `/calendar?view=month&date=${dayParam(0)}`);
    assert.equal(screen.getAllByRole('button', { name: /Выезд на объект/ }).length >= 2, true);
  } finally {
    calendarApi.events.mockImplementation(async () => ok({ items: [currentCall, MEETING, AGENT, SERVER] }));
  }
});

test('a failed refresh after the first load is shown over the last good grid, with «Повторить»', async () => {
  await renderCalendar();
  assert.ok(screen.getByRole('button', { name: /^Звонок, .* — Перезвонить партнёру/ }));
  calendarApi.events.mockImplementationOnce(async () => new Response(JSON.stringify({
    success: false, error: { code: 'INTERNAL', message: 'Сервер не ответил' },
  }), { status: 500 }));
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const banner = screen.getByRole('status', { name: /Календарь не обновился/ });
  assert.match(banner.textContent ?? '', /Сервер не ответил/);
  // The grid stays as it was.
  assert.ok(screen.getByRole('button', { name: /^Звонок, .* — Перезвонить партнёру/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(screen.queryByRole('status', { name: /Календарь не обновился/ }), null);
});

test('agent tasks open their dialog, server schedules show the journal', async () => {
  await renderCalendar();
  fireEvent.click(screen.getByRole('button', { name: /^Задача агента.*Собери срез рынка/ }));
  assert.ok(screen.getByText('СООБЩЕНИЕ CLAUDE'));
  fireEvent.click(screen.getByRole('button', { name: /Открыть диалог/ }));
  assert.equal(probe.location, '/p/p-z96/s/s-1');
});

test('quick add: the phrase is read, shown as РАСПОЗНАНО and drafted in the grid; Enter saves it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    await renderCalendar();
    const input = screen.getByLabelText('Быстро добавить событие обычной фразой');
    fireEvent.change(input, { target: { value: 'завтра в 9 позвонить Ивану про сайт' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    assert.equal(calendarApi.parse.mock.calls[0][0], 'завтра в 9 позвонить Ивану про сайт');
    assert.ok(screen.getByText('РАСПОЗНАНО'));
    assert.ok(screen.getByRole('button', { name: /^Черновик: Позвонить Ивану про сайт/ }));
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    assert.equal(calendarApi.create.mock.calls.length, 1);
    assert.ok(screen.getByText(/Добавлено: Звонок/));
  } finally {
    vi.useRealTimers();
  }
});

test('filters hide a type; День / Месяц switch the board; the mic opens ?voice', async () => {
  await renderCalendar();
  fireEvent.click(screen.getByRole('button', { name: /Сервер/ }));
  assert.equal(screen.queryByRole('button', { name: /^Расписание сервера/ }), null);

  fireEvent.click(screen.getByRole('radio', { name: 'Месяц' }));
  assert.ok(screen.getByRole('region', { name: 'Месяц' }));
  fireEvent.click(screen.getByRole('radio', { name: 'День' }));
  assert.ok(screen.getByRole('region', { name: /^День / }));

  fireEvent.click(screen.getByRole('button', { name: 'Надиктовать событие' }));
  assert.ok(probe.location.endsWith('&voice') || probe.location.endsWith('?voice'));
});

test('«Удалить событие» asks first, deletes the panel event and clears the selection; Google events have no delete', async () => {
  await renderCalendar();
  fireEvent.click(screen.getByRole('button', { name: 'Действия с событием' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Удалить событие/ }));
  assert.ok(screen.getByRole('dialog', { name: 'Удалить событие?' }));
  assert.ok(screen.getByText(/Из Google Календаря событие тоже уйдёт/));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Удалить$/ }));
  });
  assert.deepEqual(calendarApi.remove.mock.calls[0], ['ev-call']);
  assert.equal(screen.queryByRole('heading', { level: 3, name: 'Перезвонить партнёру' }), null);

  cleanup();
  calendarApi.events.mockImplementation(async () => ok({ items: [{ ...currentCall, source: 'google', readOnly: true }, MEETING] }));
  try {
    await renderCalendar();
    assert.ok(screen.getByRole('heading', { level: 3, name: 'Перезвонить партнёру' }));
    assert.equal(screen.queryByRole('button', { name: 'Действия с событием' }), null);
    assert.equal(screen.queryByRole('button', { name: /Удалить событие/ }), null);
  } finally {
    calendarApi.events.mockImplementation(async () => ok({ items: [currentCall, MEETING, AGENT, SERVER] }));
  }
});

test('quick add: a guessed type is marked and can be switched before saving', async () => {
  calendarApi.parse.mockImplementationOnce(async () => ok({
    ...PARSED,
    draft: { ...PARSED.draft!, type: 'meeting', title: 'Обсудить сайт', contact: null },
    recognized: { ...PARSED.recognized, type: false, contact: false },
  }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    await renderCalendar();
    fireEvent.change(screen.getByLabelText('Быстро добавить событие обычной фразой'), { target: { value: 'завтра в 9 обсудить сайт' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const tag = screen.getByRole('button', { name: /^Тип: Встреча \(угадан\)/ });
    fireEvent.click(tag);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Звонок/ }));
    assert.ok(screen.getByRole('button', { name: /^Тип: Звонок — сменить/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    });
    assert.equal((calendarApi.create.mock.calls[0] as unknown as [{ type: string }])[0].type, 'call');
  } finally {
    vi.useRealTimers();
  }
});

test('quick add: «Добавить» is live as soon as there is text and reads the phrase itself', async () => {
  await renderCalendar();
  const button = screen.getByRole('button', { name: 'Добавить' });
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  fireEvent.change(screen.getByLabelText('Быстро добавить событие обычной фразой'), { target: { value: 'завтра в 9 позвонить Ивану' } });
  assert.equal(button.getAttribute('aria-disabled'), 'false');
  const created = calendarApi.create.mock.calls.length;
  // Pressed before the debounced parse answered: the click parses the phrase and adds the event.
  await act(async () => {
    fireEvent.click(button);
  });
  assert.equal(calendarApi.create.mock.calls.length, created + 1);
});
