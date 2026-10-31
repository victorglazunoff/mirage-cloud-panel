import assert from 'node:assert/strict';

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useNewDialogShortcut } from '@/modules/kabina-chat/hooks/useNewDialogShortcut';

afterEach(cleanup);

function pressCtrlN(): boolean {
  const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test('Ctrl+N starts a new dialog while the chat is on screen', () => {
  const onNew = vi.fn();
  renderHook(() => useNewDialogShortcut(true, onNew));
  assert.equal(pressCtrlN(), true);
  assert.equal(onNew.mock.calls.length, 1);
});

test('in the Terminal or Files tab Ctrl+N stays theirs (bash «next command»)', () => {
  const onNew = vi.fn();
  renderHook(() => useNewDialogShortcut(false, onNew));
  assert.equal(pressCtrlN(), false, 'the key is not taken from the terminal');
  assert.equal(onNew.mock.calls.length, 0);
});
