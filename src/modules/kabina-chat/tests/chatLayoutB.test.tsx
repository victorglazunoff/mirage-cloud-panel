import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, test } from 'vitest';

import ChatSplitDivider, { clampSplit } from '@/modules/kabina-chat/ChatSplitDivider';
import ChatStatusLine from '@/modules/kabina-chat/ChatStatusLine';
import { russianModelDescription, russianModelLabel } from '@/modules/kabina-chat/KabinaComposer';

afterEach(cleanup);

function SplitHarness({ start = 50 }: { start?: number }) {
  const [share, setShare] = useState(start);
  return (
    <div className="kbc-stage">
      <ChatSplitDivider share={share} onChange={(next) => setShare(clampSplit(next))} onDragChange={() => undefined} />
    </div>
  );
}

test('the split share stays within 30–70 % and whole', () => {
  assert.equal(clampSplit(12), 30);
  assert.equal(clampSplit(95), 70);
  assert.equal(clampSplit(48.6), 49);
  assert.equal(clampSplit(Number.NaN), 50);
});

test('the divider is a real separator: arrows, Shift, Home/End, Enter and the step buttons move it', () => {
  render(<SplitHarness />);
  const handle = screen.getByRole('separator', { name: 'Граница ленты и артефакта' });
  assert.equal(handle.getAttribute('aria-valuenow'), '50');
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  assert.equal(handle.getAttribute('aria-valuenow'), '55');
  fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
  assert.equal(handle.getAttribute('aria-valuenow'), '45');
  fireEvent.keyDown(handle, { key: 'End' });
  assert.equal(handle.getAttribute('aria-valuenow'), '70');
  assert.equal((screen.getByRole('button', { name: 'Шире лента' }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole('button', { name: 'Шире артефакт' }));
  assert.equal(handle.getAttribute('aria-valuenow'), '60');
  fireEvent.keyDown(handle, { key: 'Home' });
  assert.equal(handle.getAttribute('aria-valuenow'), '30');
  fireEvent.keyDown(handle, { key: 'Enter' });
  assert.equal(handle.getAttribute('aria-valuenow'), '50');
  assert.match(handle.textContent ?? '', /50\/50/);
});

test('the model menu speaks Russian: catalogue names and descriptions, untranslatable English dropped', () => {
  assert.equal(russianModelLabel('Default (recommended)'), 'По умолчанию (рекомендуется)');
  assert.equal(russianModelLabel('Opus (1M context)'), 'Opus (1M контекст)');
  assert.equal(russianModelLabel('Opus'), 'Opus');
  assert.equal(russianModelDescription('Use the recommended model for your Claude account and deployment.'), 'рекомендованная для твоего аккаунта');
  assert.equal(russianModelDescription('Opus 4.7 · Most capable for complex work'), 'Opus 4.7 · самая сильная');
  assert.equal(russianModelDescription('Some unknown long English sentence here.'), '');
  assert.equal(russianModelDescription(undefined), '');
});

test('with the HUD showing the turn, the status line keeps Stop and the queue but not the clock', () => {
  render(
    <MemoryRouter>
      <ChatStatusLine
        isPhone={false}
        compact={false}
        turn={{ running: true, elapsed: '01:23', steps: 5, statusText: '· работает', tone: 'run' }}
        queue={{ items: [], editItem: () => undefined, removeItem: () => undefined, moveItem: () => undefined }}
        onStop={() => undefined}
        when={<span>сейчас | после хода</span>}
        notice={null}
        hint={null}
        agentsCount={2}
        clockInHud
      />
    </MemoryRouter>,
  );
  const line = screen.getByRole('group', { name: 'Состояние хода' });
  assert.doesNotMatch(line.textContent ?? '', /01:23/);
  assert.ok(screen.getByRole('button', { name: 'Остановить ход — удерживай полторы секунды' }));
  assert.ok(screen.getByText('сейчас | после хода'));
});
