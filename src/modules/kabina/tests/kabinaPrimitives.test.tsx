import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import { KabinaToastProvider, NOTIFICATIONS_STORAGE_KEY, useKabinaToasts } from '@/modules/kabina/context/KabinaToastContext';
import { NotificationBell } from '@/modules/kabina/shell/NotificationCenter';
import { Board } from '@/modules/kabina/ui/Board';
import { HoldButton } from '@/modules/kabina/ui/Button';
import { Gauge } from '@/modules/kabina/ui/Gauge';
import { Modal } from '@/modules/kabina/ui/Modal';
import { SectionRuler } from '@/modules/kabina/ui/SectionRuler';
import { Segmented } from '@/modules/kabina/ui/Segmented';
import { StatusShape } from '@/modules/kabina/ui/StatusShape';
import { Toggle } from '@/modules/kabina/ui/Toggle';
import type { KabinaToastInput } from '@/shared/types';

afterEach(() => {
  vi.useRealTimers();
});

test('gauge maps 0..100 onto the 240° dial and names itself', () => {
  const { container, rerender } = render(<Gauge name="Неделя" caption="сброс чт 5:00" percent={50} />);
  assert.ok(screen.getByRole('img', { name: 'Неделя: 50%, сброс чт 5:00' }));
  const needle = container.querySelector('[data-testid="kb-gauge-needle"]') as HTMLElement;
  assert.equal(needle.style.getPropertyValue('--kb-deg'), '0.0deg');

  rerender(<Gauge name="Неделя" caption="—" percent={150} />);
  assert.equal(needle.style.getPropertyValue('--kb-deg'), '120.0deg');

  rerender(<Gauge name="Кредиты" caption="нет данных" percent={null} />);
  assert.equal(container.querySelector('[data-testid="kb-gauge-arc"]'), null, 'no arc without data');
  assert.ok(screen.getByRole('img', { name: 'Кредиты: —, нет данных' }));
});

test('board pads numbers to two digits and marks the waiting cell', () => {
  const onSelect = vi.fn();
  render(
    <Board
      cells={[
        { key: 'run', status: 'run', code: 'РАБОТАЮТ', value: 2, label: 'агента', ariaLabel: '2 работают' },
        { key: 'wait', status: 'wait', code: 'ЖДЁТ ТЕБЯ', value: 1, label: 'Сайт клиента', ariaLabel: '1 ждёт', highlight: true, onSelect },
      ]}
    />,
  );
  const wait = screen.getByRole('listitem', { name: '1 ждёт' });
  assert.equal(wait.getAttribute('data-tone'), 'wait');
  assert.ok(wait.textContent?.includes('01'));
  assert.ok(screen.getByRole('listitem', { name: '2 работают' }).textContent?.includes('02'));
  fireEvent.click(wait);
  assert.equal(onSelect.mock.calls.length, 1);
});

test('status shapes carry their meaning in the class and, when asked, in the name', () => {
  const { container } = render(<><StatusShape kind="run" /><StatusShape kind="wait" labelled /></>);
  assert.ok(container.querySelector('.kb-led-run[aria-hidden="true"]'));
  assert.ok(screen.getByRole('img', { name: 'ждёт тебя' }).classList.contains('kb-led-wait'));
});

test('section ruler renders the number, the title and the right slot', () => {
  render(<SectionRuler id="h" index="03" title="БОРТОВОЙ ЖУРНАЛ"><button type="button">Вся история →</button></SectionRuler>);
  assert.ok(screen.getByRole('heading', { name: 'БОРТОВОЙ ЖУРНАЛ' }));
  assert.ok(screen.getByText('03'));
  assert.ok(screen.getByRole('button', { name: 'Вся история →' }));
});

test('toggle switches and reads ВКЛ / ВЫКЛ', () => {
  function Harness() {
    const [on, setOn] = useState(false);
    return <Toggle checked={on} onChange={setOn} ariaLabel="Голос" />;
  }
  render(<Harness />);
  const toggle = screen.getByRole('switch', { name: 'Голос' });
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.ok(toggle.textContent?.includes('ВЫКЛ'));
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.ok(toggle.textContent?.includes('ВКЛ'));
});

test('segmented moves with the arrow keys', () => {
  function Harness() {
    const [mode, setMode] = useState<'a' | 'b' | 'c'>('a');
    return (
      <Segmented
        ariaLabel="Режим"
        value={mode}
        onChange={setMode}
        options={[{ value: 'a', label: 'Default' }, { value: 'b', label: 'Auto' }, { value: 'c', label: 'Plan' }]}
      />
    );
  }
  render(<Harness />);
  const first = screen.getByRole('radio', { name: 'Default' });
  assert.equal(first.getAttribute('aria-checked'), 'true');
  fireEvent.keyDown(first, { key: 'ArrowLeft' });
  assert.equal(screen.getByRole('radio', { name: 'Plan' }).getAttribute('aria-checked'), 'true');
});

test('hold button fires only after the full hold and cancels on early release', () => {
  vi.useFakeTimers();
  const onConfirm = vi.fn();
  render(<HoldButton onConfirm={onConfirm} ariaLabel="Остановить ход" holdMs={1500} />);
  const button = screen.getByRole('button', { name: 'Остановить ход' });

  fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
  assert.equal(button.hasAttribute('data-holding'), true);
  act(() => { vi.advanceTimersByTime(800); });
  fireEvent.pointerUp(button, { pointerId: 1 });
  act(() => { vi.advanceTimersByTime(2000); });
  assert.equal(onConfirm.mock.calls.length, 0, 'released early');

  fireEvent.keyDown(button, { key: ' ' });
  act(() => { vi.advanceTimersByTime(1500); });
  assert.equal(onConfirm.mock.calls.length, 1, 'held long enough');
});

function ToastHarness({ toast }: { toast: KabinaToastInput }) {
  const { show, dismiss } = useKabinaToasts();
  return (
    <>
      <button type="button" onClick={() => show(toast)}>показать</button>
      <button type="button" onClick={() => dismiss(toast.id ?? '')}>снять</button>
    </>
  );
}

function renderCentre(toast: KabinaToastInput, isPhone = false) {
  return render(
    <MemoryRouter>
      <KabinaToastProvider>
        <ToastHarness toast={toast} />
        <NotificationBell isPhone={isPhone} />
      </KabinaToastProvider>
    </MemoryRouter>,
  );
}

test('nothing pops up: events land in the bell — a count, a pulse for a decision, the list on press', () => {
  window.localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
  const onReply = vi.fn();
  const { container } = renderCentre({ id: 'wait-1', kind: 'wait', project: 'САЙТ КЛИЕНТА', title: 'Нужно твоё решение', sub: 'Bash · deploy.sh', actions: [{ label: 'Ответить', variant: 'pri', onClick: onReply }] });
  assert.ok(screen.getByRole('button', { name: 'Уведомления' }));

  fireEvent.click(screen.getByRole('button', { name: 'показать' }));
  assert.equal(container.querySelector('[role="status"], [role="alert"]'), null, 'no toast over the screen');
  const bell = screen.getByRole('button', { name: 'Уведомления: 1 новое, нужно твоё решение' });
  assert.equal(bell.hasAttribute('data-attention'), true, 'the bell pulses for a decision');

  fireEvent.click(bell);
  const panel = screen.getByRole('dialog', { name: 'УВЕДОМЛЕНИЯ' });
  assert.ok(panel.textContent?.includes('Bash · deploy.sh'));
  fireEvent.click(screen.getByRole('button', { name: 'Ответить' }));
  assert.equal(onReply.mock.calls.length, 1);
  assert.equal(screen.queryByRole('dialog', { name: 'УВЕДОМЛЕНИЯ' }), null, 'an action closes the list');
  assert.ok(screen.getByRole('button', { name: 'Уведомления' }), 'and reads the entry');

  // The decision was answered elsewhere: the entry goes.
  fireEvent.click(screen.getByRole('button', { name: 'снять' }));
  fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
  assert.ok(screen.getByText(/Пока тихо/));
});

test('«Прочитать все» clears the count, and read marks survive a reload (localStorage)', () => {
  window.localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
  const first = renderCentre({ id: 'done-1', kind: 'ok', project: 'САЙТ КЛИЕНТА', title: 'Ход закончен', actions: [{ label: 'Открыть', href: '/p/z/s/1' }] });
  fireEvent.click(screen.getByRole('button', { name: 'показать' }));
  fireEvent.click(screen.getByRole('button', { name: 'Уведомления: 1 новое' }));
  assert.ok(screen.getByRole('link', { name: 'Открыть' }));
  fireEvent.click(screen.getByRole('button', { name: 'Прочитать все' }));
  assert.ok(screen.getByRole('button', { name: 'Уведомления' }));
  first.unmount();

  renderCentre({ id: 'other', kind: 'ok', title: 'другое' });
  fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
  assert.ok(screen.getByText('Ход закончен'), 'the list is still there after a reload');
  assert.ok(screen.getByRole('link', { name: 'Открыть' }), 'address actions survive');
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(screen.queryByRole('dialog', { name: 'УВЕДОМЛЕНИЯ' }), null, 'Escape closes the list');
});

test('stored «Поиск закрыт» echoes of older builds are dropped and do not count as new', () => {
  window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify([
    { id: 'search-closed', kind: 'ok', title: 'Поиск закрыт', actions: [], createdAt: 1, read: false },
    { id: 'kb-note-1', kind: 'ok', title: '/compact — в поле ввода', actions: [], createdAt: 1, read: false },
  ]));
  renderCentre({ id: 'other', kind: 'ok', title: 'другое' });
  assert.ok(screen.getByRole('button', { name: 'Уведомления' }), 'no «N новых» from echoes');
  window.localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
});

test('modal closes on Escape and on the scrim', () => {
  const onClose = vi.fn();
  render(<Modal open onClose={onClose} title="Поиск"><p>внутри</p></Modal>);
  assert.ok(screen.getByRole('dialog', { name: 'Поиск' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(onClose.mock.calls.length, 1);
  fireEvent.click(document.querySelector('.kb-scrim') as Element);
  assert.equal(onClose.mock.calls.length, 2);
});
