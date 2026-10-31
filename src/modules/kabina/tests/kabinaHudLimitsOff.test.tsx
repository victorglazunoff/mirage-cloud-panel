import assert from 'node:assert/strict';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import { KabinaHudContext } from '@/modules/kabina/context/KabinaHudContext';
import { KabinaToastProvider } from '@/modules/kabina/context/KabinaToastContext';
import { KabinaHud } from '@/modules/kabina/shell/KabinaHud';
import { api } from '@/shared/api';
import { isSubscriptionLimitsEnabled } from '@/shared/hooks/useSubscriptionLimits';
import type { SubscriptionLimits } from '@/shared/types';

// The server's counter is off (MIRAGE_SUBSCRIPTION_LIMITS not set).
const DISABLED: SubscriptionLimits = {
  status: 'disabled', reason: null, plan: null, fetchedAt: null, session: null, weekly: null, weeklyByModel: [], credits: null,
};

vi.mock('@/shared/api', () => ({
  api: { home: { limits: vi.fn(async () => new Response(JSON.stringify({ data: DISABLED }))) } },
  readApiJson: async (response: Response) => response.json(),
}));

afterEach(cleanup);

function renderHud(isPhone: boolean) {
  const live = { runningCount: 0, working: 0, waiting: 0 };
  return render(
    <MemoryRouter initialEntries={['/']}>
      <KabinaToastProvider>
        <KabinaHudContext.Provider value={{ live, headerSlot: null, claimHud: () => () => undefined, claimCrumbs: () => () => undefined }}>
          <KabinaHud isPhone={isPhone} />
        </KabinaHudContext.Provider>
      </KabinaToastProvider>
    </MemoryRouter>,
  );
}

test('with the counter off the HUD has no limit cells at all, and the answer is remembered', async () => {
  renderHud(false);
  const hud = screen.getByRole('navigation', { name: 'Приборная строка' });
  await waitFor(() => assert.equal(vi.mocked(api.home.limits).mock.calls.length, 1));
  await waitFor(() => assert.equal(localStorage.getItem('mirage-subscription-limits-enabled'), '0'));
  assert.equal(within(hud).queryByRole('button', { name: /Неделя|Лимит недели|Кредиты/ }), null);
  assert.doesNotMatch(hud.textContent ?? '', /НЕД/);
  // The bell and the live summary stay where they were.
  assert.ok(within(hud).getByRole('button', { name: /Уведомления/ }));
  assert.match(hud.textContent ?? '', /тихо/);
  // A reload knows before the server answers.
  assert.equal(isSubscriptionLimitsEnabled(null), false);
  localStorage.setItem('mirage-subscription-limits-enabled', '1');
  assert.equal(isSubscriptionLimitsEnabled(null), true);
  assert.equal(isSubscriptionLimitsEnabled(DISABLED), false);
});

test('the phone row without the counter: no limit cells, the poll is not repeated', async () => {
  const callsBefore = vi.mocked(api.home.limits).mock.calls.length;
  renderHud(true);
  const hud = screen.getByRole('navigation', { name: 'Приборная строка' });
  assert.equal(within(hud).queryByRole('button', { name: /Неделя|Лимит недели/ }), null);
  // The first test already learned the counter is off: no new request.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(vi.mocked(api.home.limits).mock.calls.length, callsBefore);
});
