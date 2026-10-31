import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import HoldToStopButton from '@/modules/chat/composer/HoldToStopButton';

/**
 * Stopping a turn must be deliberate (Б2): a plain click only explains how,
 * holding for about a second stops.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a quick press does not stop and shows the hold hint', () => {
  const onStop = vi.fn();
  render(<HoldToStopButton onStop={onStop} />);
  const button = screen.getByRole('button');

  fireEvent.pointerDown(button, { pointerType: 'touch' });
  act(() => {
    vi.advanceTimersByTime(300);
  });
  fireEvent.pointerUp(button, { pointerType: 'touch' });
  act(() => {
    vi.advanceTimersByTime(2000);
  });

  assert.equal(onStop.mock.calls.length, 0);
});

test('holding for a second stops the turn once', () => {
  const onStop = vi.fn();
  render(<HoldToStopButton onStop={onStop} />);
  const button = screen.getByRole('button');

  fireEvent.pointerDown(button, { pointerType: 'touch' });
  act(() => {
    vi.advanceTimersByTime(1100);
  });
  fireEvent.pointerUp(button, { pointerType: 'touch' });

  assert.equal(onStop.mock.calls.length, 1);
});

test('holding Enter on the keyboard stops the turn', () => {
  const onStop = vi.fn();
  render(<HoldToStopButton onStop={onStop} />);
  const button = screen.getByRole('button');

  fireEvent.keyDown(button, { key: 'Enter' });
  act(() => {
    vi.advanceTimersByTime(1100);
  });
  fireEvent.keyUp(button, { key: 'Enter' });

  assert.equal(onStop.mock.calls.length, 1);
});

test('a quick press offers a "Stop?" confirmation that stops when used', () => {
  const onStop = vi.fn();
  render(<HoldToStopButton onStop={onStop} />);
  const button = screen.getByRole('button', { name: /hold for 1 second/ });

  fireEvent.pointerDown(button, { pointerType: 'mouse', button: 0 });
  fireEvent.pointerUp(button, { pointerType: 'mouse', button: 0 });
  const confirm = screen.getByRole('button', { name: 'Stop the turn now' });
  fireEvent.click(confirm);

  assert.equal(onStop.mock.calls.length, 1);
});

test('the confirmation goes away on its own after a few seconds', () => {
  const onStop = vi.fn();
  render(<HoldToStopButton onStop={onStop} />);
  const button = screen.getByRole('button', { name: /hold for 1 second/ });

  fireEvent.pointerDown(button, { pointerType: 'touch' });
  fireEvent.pointerUp(button, { pointerType: 'touch' });
  assert.ok(screen.queryByRole('button', { name: 'Stop the turn now' }));
  act(() => {
    vi.advanceTimersByTime(3100);
  });

  assert.equal(screen.queryByRole('button', { name: 'Stop the turn now' }), null);
  assert.equal(onStop.mock.calls.length, 0);
});

test('a screen reader activation (a click with no hold) gets the confirmation, focused', () => {
  const onStop = vi.fn();
  render(<HoldToStopButton onStop={onStop} />);
  const button = screen.getByRole('button', { name: /hold for 1 second/ });

  fireEvent.click(button, { detail: 0 });
  const confirm = screen.getByRole('button', { name: 'Stop the turn now' });

  assert.equal(document.activeElement, confirm);
  assert.equal(onStop.mock.calls.length, 0);
});

test('sliding the finger off the button cancels the hold', () => {
  // jsdom has no PointerEvent, so coordinates would be dropped; a MouseEvent
  // with the pointer fields is enough for the drift check.
  const hadPointerEvent = 'PointerEvent' in window;
  if (!hadPointerEvent) {
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? 'mouse';
      }
    }
    Object.defineProperty(window, 'PointerEvent', { value: TestPointerEvent, configurable: true });
  }
  const onStop = vi.fn();
  render(<HoldToStopButton onStop={onStop} />);
  const button = screen.getByRole('button', { name: /hold for 1 second/ });
  button.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 80, bottom: 32, width: 80, height: 32, x: 0, y: 0, toJSON: () => ({}),
  });

  fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 });
  fireEvent.pointerMove(button, { pointerType: 'touch', clientX: 200, clientY: 10 });
  act(() => {
    vi.advanceTimersByTime(1100);
  });

  assert.equal(onStop.mock.calls.length, 0);
  if (!hadPointerEvent) {
    Reflect.deleteProperty(window, 'PointerEvent');
  }
});
