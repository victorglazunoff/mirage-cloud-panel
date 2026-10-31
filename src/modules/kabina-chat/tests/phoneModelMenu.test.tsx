import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { ModelMenu } from '@/modules/kabina-chat/KabinaComposer';

// jsdom has no Element#scrollTo: the tests give elements one to record the calls.
const scrollTo = vi.fn();

beforeEach(() => {
  scrollTo.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: scrollTo });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

type Chat = ComponentProps<typeof ModelMenu>['chat'];

const CHAT = {
  provider: {
    currentProviderEffortOptions: [{ value: 'low' }, { value: 'high' }],
    currentProviderEffort: 'high',
    currentProviderModelOptions: [
      { value: 'opus', label: 'Opus', description: 'Most capable' },
      { value: 'haiku', label: 'Haiku', description: 'Fastest' },
    ],
    currentProviderModel: 'haiku',
    providerModelsLoading: false,
  },
  selectEffort: vi.fn(),
  selectModel: vi.fn(),
} as unknown as Chat;

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

test('phone context sheet: the opened model list is scrolled into the sheet, «Модель» stays on top', () => {
  // The sheet body (a scroll box 209–739) with «Модель» at 664 and the list unfolding at 726 —
  // the stand's 390×844 numbers: only 13px of the list were visible.
  const proto = HTMLElement.prototype;
  vi.spyOn(proto, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('sheet-body')) return rect(209, 530);
    if (this.getAttribute('role') === 'menu') return rect(726, 590);
    if (this.tagName === 'BUTTON' && this.textContent === 'Сменить модель и effort') return rect(664, 52);
    return rect(0, 0);
  });
  render(
    <div className="sheet-body" style={{ overflowY: 'auto' }}>
      <button type="button">Сменить модель и effort</button>
      <ModelMenu chat={CHAT} inline onClose={() => undefined} />
    </div>,
  );
  assert.equal(scrollTo.mock.calls.length, 1);
  const [options] = scrollTo.mock.calls[0] as [ScrollToOptions];
  // The list is taller than the sheet: scroll until «Модель» reaches the top (664 − 209), not past it.
  assert.equal(options.top, 455);
});

test('the drop-up of the computer composer does not scroll anything', () => {
  render(<ModelMenu chat={CHAT} onClose={() => undefined} />);
  assert.equal(scrollTo.mock.calls.length, 0);
});
