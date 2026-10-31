import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { plainSession, snapshot, workflowSession } from '@/modules/kabina-agents/tests/agentsFixtures';
import type { LiveAgentsSnapshot, ServerEvent } from '@/shared/types';

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
const sendMessage = vi.fn((_frame: Record<string, unknown>) => true);
let current: LiveAgentsSnapshot = snapshot([workflowSession(), plainSession()]);

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    sendMessage,
    isConnected: true,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }),
}));

const snapshotRequest = vi.hoisted(() => ({ fail: false }));

vi.mock('@/shared/api', () => ({
  api: {
    agentsLive: {
      snapshot: vi.fn(async () => {
        if (snapshotRequest.fail) throw new TypeError('Нет связи с сервером');
        return new Response(JSON.stringify({ success: true, data: current }), { status: 200 });
      }),
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));

const writeDraftText = vi.fn();
vi.mock('@/shared/chatDrafts', () => ({ addToDraftText: (...args: unknown[]) => writeDraftText(...args) }));

function emit(event: ServerEvent) {
  act(() => {
    for (const listener of [...listeners]) listener(event);
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  current = snapshot([workflowSession(), plainSession()]);
  snapshotRequest.fail = false;
});

afterEach(() => {
  vi.clearAllMocks();
  listeners.clear();
});

async function renderAgents() {
  const { AgentsScreen } = await import('@/modules/kabina-agents');
  const utils = render(
    <MemoryRouter initialEntries={['/agents']}>
      <AgentsScreen />
    </MemoryRouter>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return utils;
}

test('subscribes to the stream and draws the summary, the waiting band and a radar per session', async () => {
  await renderAgents();
  assert.ok(sendMessage.mock.calls.some(([frame]) => frame.type === 'agents.subscribe'));
  assert.ok(screen.getByRole('heading', { level: 1, name: 'Агенты в эфире' }));
  assert.ok(screen.getByText('ЖИВАЯ СХЕМА · 2 ПРОЕКТА · 8 АГЕНТОВ'));
  assert.ok(screen.getByLabelText('1 ждёт тебя'));
  assert.ok(screen.getByText('rsync -az dist/ prod:/var/www/demo-site'));
  assert.ok(screen.getByRole('article', { name: 'Сайт клиента' }));
  assert.ok(screen.getByRole('article', { name: 'Карта участков' }));
  assert.ok(screen.getByRole('list', { name: 'Фазы воркфлоу' }));
  // The waiting agent is picked by default.
  const detail = screen.getByRole('region', { name: 'АГЕНТ' });
  assert.ok(within(detail).getByText('Выкладка на прод'));
});

test('«Разрешить один раз» answers through agents.permission and reports the result', async () => {
  await renderAgents();
  const band = screen.getByRole('region', { name: /ЖДЁТ ТЕБЯ/ });
  fireEvent.click(within(band).getByRole('button', { name: 'Разрешить один раз' }));
  const frame = sendMessage.mock.calls.map(([sent]) => sent).find((sent) => sent.type === 'agents.permission');
  assert.ok(frame);
  assert.equal(frame.requestId, 'req-1');
  assert.equal(frame.allow, true);
  emit({ kind: 'agents_action_result', action: 'permission', requestKey: frame.requestKey as string, ok: true, error: null });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(screen.getByRole('status').textContent?.includes('Разрешено один раз'));
});

test('picking a contact shows its panel; an error offers «Повторить» through the dialog draft', async () => {
  await renderAgents();
  fireEvent.click(screen.getByRole('button', { name: /^Выжимка конкурентов/ }));
  const detail = screen.getByRole('region', { name: 'АГЕНТ' });
  assert.ok(within(detail).getByText('WebFetch: 403 на сайте конкурента'));
  assert.equal(within(detail).getByRole('link', { name: 'Открыть диалог' }).getAttribute('href'), '/p/p-map/s/s-map');
  fireEvent.click(within(detail).getByRole('button', { name: 'Повторить' }));
  assert.equal(writeDraftText.mock.calls[0][0], 's-map');
  assert.ok(String(writeDraftText.mock.calls[0][1]).startsWith('Повтори агента «Выжимка конкурентов»'));
});

test('deltas update the screen; with nothing running it shows «Все агенты отдыхают»', async () => {
  await renderAgents();
  const ended = plainSession();
  ended.status = 'ended';
  ended.agents = ended.agents.map((agent) => ({ ...agent, state: 'done', endedAt: new Date().toISOString(), summary: agent.id === 'a1' ? '14 из 14' : null }));
  ended.orchestrator = ended.agents[0];
  emit({
    kind: 'agents_delta',
    delta: {
      seq: 20,
      generatedAt: new Date().toISOString(),
      sessions: [ended],
      removedSessionIds: ['s-zag'],
      feed: [],
      stats: { working: 0, waiting: 0, doneLastHour: 3, errors: 0, tokensLastHour: 0, activeProjects: 0 },
    },
  });
  assert.ok(screen.getByRole('heading', { name: 'Все агенты отдыхают' }));
  assert.ok(screen.getByText('никто не работает'));
  assert.equal(screen.queryByRole('region', { name: /ЖДЁТ ТЕБЯ/ }), null);
  assert.ok(screen.getByRole('link', { name: 'Запустить воркфлоу' }).getAttribute('href')?.startsWith('/p/p-map'));
});

test('a failed first load shows «Агенты не загрузились» with «Повторить» instead of an endless skeleton', async () => {
  snapshotRequest.fail = true;
  await renderAgents();
  const alert = screen.getByRole('alert');
  assert.match(alert.textContent ?? '', /Агенты не загрузились/);
  assert.match(alert.textContent ?? '', /Нет связи с сервером/);
  assert.equal(screen.queryByRole('status', { name: 'Схема загружается' }), null);

  snapshotRequest.fail = false;
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(screen.queryByRole('alert'), null);
  assert.ok(screen.getByRole('article', { name: 'Сайт клиента' }));
});
