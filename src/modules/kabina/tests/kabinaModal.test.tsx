import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, test, vi } from 'vitest';

import { Modal, Sheet } from '@/modules/kabina/ui/Modal';
import { lockPageScroll, SCROLL_LOCK_ATTRIBUTE } from '@/modules/kabina/utils/pageScrollLock';

afterEach(() => {
  cleanup();
  document.querySelectorAll('.kb-shell').forEach((shell) => shell.remove());
  document.documentElement.removeAttribute(SCROLL_LOCK_ATTRIBUTE);
});

function makeShell(scrollTop: number): HTMLElement {
  const shell = document.createElement('div');
  shell.className = 'kb-shell';
  document.body.appendChild(shell);
  shell.scrollTop = scrollTop;
  return shell;
}

test('modal splits into a pinned head, a scrolling body and a pinned footer', () => {
  render(
    <Modal open onClose={() => {}} title="Мастер" maxWidth={680} footer={<button type="button">Далее</button>}>
      <p>поле</p>
    </Modal>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Мастер' });
  const parts = Array.from(dialog.children).map((child) => child.className);
  assert.deepEqual(parts, ['kb-modal-top', 'kb-modal-body', 'kb-modal-foot']);
  assert.ok(dialog.querySelector('.kb-modal-foot button'), 'the actions live in the pinned footer');
  assert.equal(dialog.style.getPropertyValue('--kb-modal-max'), '680px', 'the width cap is a variable a phone can lift');
  assert.equal(dialog.style.maxWidth, '', 'no inline max-width that would beat the phone sheet');
  assert.equal(dialog.parentElement?.getAttribute('data-phone'), 'full', 'a phone sheet over the visible area by default');
});

test('a short confirmation is a fitted bottom sheet on a phone, without a footer only head and body', () => {
  render(<Modal open onClose={() => {}} title="Удалить?" phone="fit"><p>точно?</p></Modal>);
  const dialog = screen.getByRole('dialog', { name: 'Удалить?' });
  assert.equal(dialog.parentElement?.getAttribute('data-phone'), 'fit');
  assert.equal(dialog.querySelector('.kb-modal-foot'), null);
  assert.equal(dialog.lastElementChild?.className, 'kb-modal-body');
});

test('an open modal freezes the page under it and gives it back where it was', () => {
  const shell = makeShell(240);
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(false)}>закрыть</button>
        <Modal open={open} onClose={() => setOpen(false)} title="Окно"><p>x</p></Modal>
      </>
    );
  }
  const { unmount } = render(<Harness />);
  assert.ok(document.documentElement.hasAttribute(SCROLL_LOCK_ATTRIBUTE), 'the shell is frozen (kabina.css)');
  assert.equal(document.body.style.overflow, 'hidden');
  shell.scrollTop = 0; // iOS pans / jumps while the dialog is up
  unmount();
  assert.equal(document.documentElement.hasAttribute(SCROLL_LOCK_ATTRIBUTE), false);
  assert.equal(document.body.style.overflow, '');
  assert.equal(shell.scrollTop, 240, 'back on the same spot');
});

test('nested dialogs share one lock: the page unfreezes only when the last one closes', () => {
  const shell = makeShell(90);
  const releaseOuter = lockPageScroll();
  const { unmount } = render(<Sheet open onClose={() => {}} title="Шторка"><p>y</p></Sheet>);
  unmount();
  assert.ok(document.documentElement.hasAttribute(SCROLL_LOCK_ATTRIBUTE), 'the outer dialog still holds it');
  shell.scrollTop = 5;
  releaseOuter();
  releaseOuter();
  assert.equal(document.documentElement.hasAttribute(SCROLL_LOCK_ATTRIBUTE), false);
  assert.equal(shell.scrollTop, 90);
});

test('one Esc closes only the newest layer: a sheet over a modal, then the modal', async () => {
  const closeModal = vi.fn();
  const closeSheet = vi.fn();
  function Layers() {
    // The sheet opens later, over the modal (as from a button inside it).
    const [isSheetOpen, setIsSheetOpen] = useState(false);
    return (
      <Modal open onClose={closeModal} title="Окно">
        <button type="button" onClick={() => setIsSheetOpen(true)}>открыть шторку</button>
        <Sheet open={isSheetOpen} onClose={() => { closeSheet(); setIsSheetOpen(false); }} title="Шторка"><p>внутри</p></Sheet>
      </Modal>
    );
  }
  render(<Layers />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'открыть шторку' }));
  });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  assert.equal(closeSheet.mock.calls.length, 1);
  assert.equal(closeModal.mock.calls.length, 0, 'the modal under the sheet stays');
  await act(async () => undefined);
  fireEvent.keyDown(document.body, { key: 'Escape' });
  assert.equal(closeModal.mock.calls.length, 1, 'the next Esc closes the modal');
});

test('Shift+Tab after a click on plain text stays inside the dialog', () => {
  render(
    <>
      <button type="button">за окном</button>
      <Modal open onClose={() => {}} title="Окно" footer={<button type="button">Готово</button>}>
        <p>просто текст</p>
        <input aria-label="поле" />
      </Modal>
    </>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Окно' });
  // A click on the text: focus lands on the panel (tabIndex −1), not on a control.
  dialog.focus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, screen.getByRole('button', { name: 'Готово' }), 'Shift+Tab goes to the last control');
  dialog.focus();
  fireEvent.keyDown(dialog, { key: 'Tab' });
  assert.equal(document.activeElement, screen.getByRole('button', { name: 'Закрыть (Esc)' }), 'Tab goes to the first control');
});
