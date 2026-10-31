import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, test, vi } from 'vitest';

import { ModelMenu } from '@/modules/kabina-chat/KabinaComposer';

afterEach(cleanup);

type Chat = Parameters<typeof ModelMenu>[0]['chat'];

function fakeChat(): Chat {
  return {
    provider: {
      currentProviderEffortOptions: [{ value: 'low' }, { value: 'high' }],
      currentProviderEffort: 'high',
      currentProviderModelOptions: [{ value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' }],
      currentProviderModel: 'opus',
      providerModelsLoading: false,
    },
    selectModel: vi.fn(async () => undefined),
    selectEffort: vi.fn(async () => undefined),
  } as unknown as Chat;
}

/** The composer's model button and its drop-up, as KabinaComposer wires them. */
function Harness() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={buttonRef} type="button" aria-label="Модель и effort" onClick={() => setOpen((value) => !value)}>Opus</button>
      {open && <ModelMenu chat={fakeChat()} toggleRef={buttonRef} onClose={() => setOpen(false)} />}
      <p>лента</p>
    </div>
  );
}

/** A real press: pointerdown, then click — the menu listens to the first, the button to the second. */
async function press(element: Element) {
  fireEvent.pointerDown(element);
  fireEvent.click(element);
  // The menu starts listening for outside presses a tick after it opens.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/** A boolean, so a failed check never has to print a DOM node. */
const isMenuOpen = () => screen.queryByRole('menu', { name: 'Модель и effort' }) !== null;

test('the model button closes the menu it opened, instead of reopening it', async () => {
  render(<Harness />);
  const button = screen.getByRole('button', { name: 'Модель и effort' });
  await press(button);
  assert.equal(isMenuOpen(), true, 'the first press opens the menu');
  await press(button);
  assert.equal(isMenuOpen(), false, 'the second press closes it');
});

test('a press elsewhere still closes the menu', async () => {
  render(<Harness />);
  await press(screen.getByRole('button', { name: 'Модель и effort' }));
  fireEvent.pointerDown(screen.getByText('лента'));
  assert.equal(isMenuOpen(), false);
});
