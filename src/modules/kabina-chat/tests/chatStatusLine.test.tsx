import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import ChatStatusLine from '@/modules/kabina-chat/ChatStatusLine';
import type { QueueView, TurnView } from '@/modules/kabina-chat/ChatStatusLine';

afterEach(cleanup);

const IDLE: TurnView = { running: false, elapsed: '00:00', steps: 3, statusText: '· ход не идёт', tone: 'idle' };
const RUNNING: TurnView = { running: true, elapsed: '01:23', steps: 5, statusText: '· работает', tone: 'run' };

function queueOf(items: string[]): QueueView {
  return { items, editItem: vi.fn(), removeItem: vi.fn(), moveItem: vi.fn() };
}

function renderLine(turn: TurnView, queue: QueueView, extra: { notice?: string | null; isPhone?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <div data-testid="host">
        <ChatStatusLine
          isPhone={extra.isPhone ?? false}
          compact={false}
          turn={turn}
          queue={queue}
          onStop={() => undefined}
          when={<span>сейчас | после хода</span>}
          notice={extra.notice ?? null}
          hint={null}
          agentsCount={0}
        />
      </div>
    </MemoryRouter>,
  );
}

test('no turn and an empty queue: the status line takes no room at all', () => {
  renderLine(IDLE, queueOf([]));
  assert.equal(screen.getByTestId('host').childElementCount, 0);
});

test('a running turn shows the clock, the steps, «Стоп» and «сейчас | после хода» in one line', () => {
  renderLine(RUNNING, queueOf([]));
  const line = screen.getByRole('group', { name: 'Состояние хода' });
  assert.match(line.textContent ?? '', /ход 01:23 · шаг 5/);
  assert.ok(screen.getByRole('button', { name: 'Остановить ход — удерживай полторы секунды' }));
  assert.ok(screen.getByText('сейчас | после хода'));
  assert.equal(screen.queryByRole('button', { name: /Очередь после хода/ }), null, 'no chip without a queue');
});

test('the queue chip unfolds the list with its rows and folds it again', () => {
  const queue = queueOf(['Обнови sitemap', 'Сделай отчёт']);
  renderLine(IDLE, queue);
  const chip = screen.getByRole('button', { name: /Очередь после хода: 2/ });
  assert.equal(screen.queryByText('Обнови sitemap'), null);
  assert.equal(screen.queryByText('сейчас | после хода'), null, 'no turn — no «сейчас | после хода»');
  fireEvent.click(chip);
  assert.equal(chip.getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByText('Обнови sitemap'));
  fireEvent.click(screen.getAllByRole('button', { name: 'Убрать из очереди' })[1]);
  assert.deepEqual((queue.removeItem as ReturnType<typeof vi.fn>).mock.calls[0], [1]);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(screen.queryByText('Обнови sitemap'), null);
});

test('a refused steer is shown even after the turn', () => {
  renderLine(IDLE, queueOf([]), { notice: 'Не вклинилось — ушло в очередь' });
  assert.ok(screen.getByText('Не вклинилось — ушло в очередь'));
});

test('Mirage: a turn that cannot be stopped from here shows «Стоп» inactive with the reason', () => {
  const onStop = vi.fn();
  render(
    <MemoryRouter>
      <ChatStatusLine
        isPhone={false}
        compact={false}
        turn={RUNNING}
        queue={queueOf([])}
        onStop={onStop}
        stopUnavailable={{ text: 'Ход идёт в терминале Claude Code — остановить его можно только там', line: 'Ход в терминале — стоп только там', short: 'в терминале' }}
        when={null}
        notice={null}
        hint={null}
        agentsCount={0}
      />
    </MemoryRouter>,
  );
  const stop = screen.getByRole('button', { name: /Стоп недоступен: Ход идёт в терминале/ }) as HTMLButtonElement;
  assert.equal(stop.disabled, true);
  assert.ok(screen.getByText('Ход в терминале — стоп только там'), 'the reason is on the line');
});

test('Mirage: on the phone the reason stands in for the activity, short', () => {
  render(
    <MemoryRouter>
      <ChatStatusLine
        isPhone
        compact={false}
        turn={{ ...RUNNING, activity: 'Bash python3 job.py' }}
        queue={queueOf([])}
        onStop={() => undefined}
        stopUnavailable={{ text: 'Ход идёт в терминале Claude Code — остановить его можно только там', line: 'Ход в терминале — стоп только там', short: 'в терминале' }}
        when={null}
        notice={null}
        hint={null}
        agentsCount={0}
      />
    </MemoryRouter>,
  );
  assert.ok(screen.getByText('в терминале'));
  assert.equal(screen.queryByText(/Bash python3 job.py/), null);
  assert.equal((screen.getByRole('button', { name: /Стоп недоступен/ }) as HTMLButtonElement).disabled, true);
});
