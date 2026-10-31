import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import ChatQueue from '@/modules/kabina-chat/ChatQueue';
import DecisionCards from '@/modules/kabina-chat/DecisionCard';
import type { PendingPermissionRequest } from '@/shared/types';

afterEach(cleanup);

const BASH_REQUEST: PendingPermissionRequest = {
  requestId: 'r1',
  toolName: 'Bash',
  input: { command: 'bash deploy.sh --prod demo-site.example', description: '40 цен, 3 посёлка' },
  receivedAt: new Date(),
};

test('the decision card allows once, for the session (with the rule) or denies', () => {
  const onDecision = vi.fn();
  const { rerender } = render(<DecisionCards requests={[BASH_REQUEST]} onDecision={onDecision} isPhone={false} />);
  assert.ok(screen.getByText('НУЖНО ТВОЁ РЕШЕНИЕ'));
  assert.ok(screen.getByText(/bash deploy\.sh --prod demo-site\.example/));

  fireEvent.click(screen.getByRole('button', { name: 'Разрешать в этой сессии' }));
  const [ids, decision] = onDecision.mock.calls[0];
  assert.deepEqual(ids, ['r1']);
  assert.equal(decision.allow, true);
  assert.equal(typeof decision.rememberEntry, 'string');

  // The request is gone: the card turns into the quiet confirmation line.
  rerender(<DecisionCards requests={[]} onDecision={onDecision} isPhone={false} />);
  assert.ok(screen.getByText(/разрешён до конца сессии/));

  rerender(<DecisionCards requests={[{ ...BASH_REQUEST, requestId: 'r2' }]} onDecision={onDecision} isPhone={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
  assert.equal(onDecision.mock.calls[1][1].allow, false);
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить один раз' }));
  assert.deepEqual(onDecision.mock.calls[2], ['r2', { allow: true }]);
});

test('a Write / Edit request shows the numbered diff of the file instead of a command', () => {
  const onDecision = vi.fn();
  const edit: PendingPermissionRequest = {
    requestId: 'e1',
    toolName: 'Edit',
    input: JSON.stringify({ file_path: 'src/lib/price-format.ts', old_string: 'const a = 1;\nreturn a;', new_string: 'const a = 2;\nreturn a;' }),
    receivedAt: new Date(),
  };
  render(<DecisionCards requests={[edit]} onDecision={onDecision} isPhone={false} />);
  assert.ok(screen.getByRole('table', { name: 'Изменения в src/lib/price-format.ts' }));
  assert.ok(screen.getByText('+1'));
  assert.ok(screen.getByText('−1'));
  assert.equal(screen.queryByText('$'), null, 'no command line for a file edit');
  assert.ok(screen.getByText(/на паузе только этот шаг/));
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить один раз' }));
  assert.deepEqual(onDecision.mock.calls[0], ['e1', { allow: true }]);
});

test('phone: «Разрешить один раз» first, «До конца сессии» and «Отклонить» below it', () => {
  render(<DecisionCards requests={[BASH_REQUEST]} onDecision={vi.fn()} isPhone />);
  const buttons = screen.getAllByRole('button').map((button) => button.textContent);
  assert.deepEqual(buttons, ['Разрешить один раз', 'До конца сессии', 'Отклонить']);
  assert.equal(screen.queryByText(/40 цен/), null, 'no command note on the phone');
});

test('a question request answers with the picked option', () => {
  const onDecision = vi.fn();
  const request: PendingPermissionRequest = {
    requestId: 'q1',
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'Какой посёлок первым?', options: [{ label: 'Берёзовая роща' }, { label: 'Сосновый берег' }] }] },
  };
  render(<DecisionCards requests={[request]} onDecision={onDecision} isPhone />);
  fireEvent.click(screen.getByRole('button', { name: 'Сосновый берег' }));
  fireEvent.click(screen.getByRole('button', { name: 'Ответить' }));
  const [, decision] = onDecision.mock.calls[0];
  assert.deepEqual(decision.updatedInput.answers, { 'Какой посёлок первым?': 'Сосновый берег' });
});

test('the queue edits, removes and moves rows', () => {
  const onEdit = vi.fn();
  const onRemove = vi.fn();
  const onMove = vi.fn();
  render(
    <ChatQueue
      items={['Обнови sitemap', 'Сделай отчёт']}
      isPhone={false}
      onClose={() => undefined}
      onEdit={onEdit}
      onRemove={onRemove}
      onMove={onMove}
    />,
  );
  assert.ok(screen.getByText('ОЧЕРЕДЬ · ПОСЛЕ ХОДА · 2'));
  fireEvent.click(screen.getAllByRole('button', { name: 'Править сообщение' })[1]);
  const input = screen.getByLabelText('Править сообщение 2');
  // iOS: no AutoFill bar (passwords · cards · places) above the keyboard for a queue edit.
  assert.equal(input.getAttribute('autocomplete'), 'off');
  assert.equal(input.getAttribute('data-1p-ignore'), '');
  assert.equal(input.getAttribute('data-lpignore'), 'true');
  fireEvent.change(input, { target: { value: 'Сделай отчёт таблицей' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  assert.deepEqual(onEdit.mock.calls[0], [1, 'Сделай отчёт таблицей']);

  fireEvent.click(screen.getAllByRole('button', { name: 'Убрать из очереди' })[0]);
  assert.deepEqual(onRemove.mock.calls[0], [0]);

  fireEvent.keyDown(screen.getAllByRole('button', { name: 'Перетащить, чтобы поменять порядок' })[1], { key: 'ArrowUp' });
  assert.deepEqual(onMove.mock.calls[0], [1, 0]);
});
