import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import { KabinaHudContext } from '@/modules/kabina/context/KabinaHudContext';
import { KabinaToastProvider } from '@/modules/kabina/context/KabinaToastContext';
import { HudMeter, KabinaHud } from '@/modules/kabina/shell/KabinaHud';
import type { SubscriptionLimits } from '@/shared/types';

const HOUR = 3_600_000;
const LIMITS: SubscriptionLimits = {
  status: 'ok',
  reason: null,
  plan: 'max 20×',
  fetchedAt: new Date().toISOString(),
  session: { percent: 12, resetsAt: new Date(Date.now() + 3 * HOUR).toISOString() },
  weekly: { percent: 86, resetsAt: new Date(Date.now() + 50 * HOUR).toISOString() },
  weeklyByModel: [],
  credits: { percent: 55, resetsAt: new Date(Date.now() + 200 * HOUR).toISOString(), limitDollars: 250, remainingDollars: 112.4 },
};

vi.mock('@/shared/api', () => ({
  api: { home: { limits: vi.fn(async () => new Response(JSON.stringify({ data: LIMITS }))) } },
  readApiJson: async (response: Response) => response.json(),
}));

afterEach(cleanup);

const probe = { location: '' };
function LocationProbe() {
  const location = useLocation();
  useEffect(() => {
    probe.location = `${location.pathname}${location.search}`;
  }, [location]);
  return null;
}

function renderHud(isPhone: boolean, live = { runningCount: 3, working: 2, waiting: 1 }, at = '/') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <LocationProbe />
      <KabinaToastProvider>
        <KabinaHudContext.Provider value={{ live, headerSlot: null, claimHud: () => () => undefined, claimCrumbs: () => () => undefined }}>
          <KabinaHud isPhone={isPhone} />
        </KabinaHudContext.Provider>
      </KabinaToastProvider>
    </MemoryRouter>,
  );
}

test('the computer HUD shows НЕД / $ coloured by fill, the live summary and the bell — no 5Ч', async () => {
  renderHud(false);
  const hud = screen.getByRole('navigation', { name: 'Приборная строка' });
  const week = await within(hud).findByRole('button', { name: /^Неделя: 86 %/ });
  assert.equal(week.getAttribute('data-level'), 'hot', 'past 80 % the instrument turns signal');
  const credits = within(hud).getByRole('button', { name: /Кредиты: осталось 112 из 250/ });
  assert.equal(credits.getAttribute('data-tone'), 'sand');
  assert.match(hud.textContent ?? '', /работают 2/);
  assert.match(hud.textContent ?? '', /ждёт тебя 1/);
  assert.ok(within(hud).getByRole('button', { name: /Уведомления/ }));
  // The plan has no 5-hour window: even a `session` from the server is not drawn.
  assert.equal(within(hud).queryByRole('button', { name: /Сессия|сессии/ }), null);
  assert.doesNotMatch(hud.textContent ?? '', /5Ч/);
  assert.deepEqual(within(hud).getAllByRole('button', { name: /^(Неделя|Кредиты)/ }).length, 2);
});

test('an instrument opens the limits panel with resets and the week pace; Esc closes it', async () => {
  renderHud(false);
  const week = await screen.findByRole('button', { name: /^Неделя: 86 %/ });
  fireEvent.click(week);
  const panel = screen.getByRole('dialog', { name: 'Лимиты подписки' });
  assert.match(panel.textContent ?? '', /ЛИМИТЫ · MAX 20×/);
  assert.match(panel.textContent ?? '', /Неделя · все модели/);
  assert.match(panel.textContent ?? '', /Темп недели/);
  assert.doesNotMatch(panel.textContent ?? '', /Сессия|5 ч\b/, 'no 5-hour row');
  assert.equal(week.getAttribute('aria-expanded'), 'true');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Лимиты подписки' }), null));
});

test('«Подробнее» of the limits anywhere (`?limits`) opens this panel and drops the flag', async () => {
  renderHud(false, undefined, '/agents?limits');
  const panel = await screen.findByRole('dialog', { name: 'Лимиты подписки' });
  assert.match(panel.textContent ?? '', /ЛИМИТЫ/);
  assert.equal(within(panel).queryByRole('link', { name: /Подробнее/ }), null, 'the panel is the details, no link away');
  await waitFor(() => assert.equal(probe.location, '/agents'));
});

test('the phone HUD is a row without the bell (it stays in the header)', async () => {
  renderHud(true, { runningCount: 0, working: 0, waiting: 0 });
  const hud = screen.getByRole('navigation', { name: 'Приборная строка' });
  assert.ok(hud.hasAttribute('data-phone'));
  await within(hud).findByRole('button', { name: /^Неделя/ });
  assert.equal(within(hud).queryByRole('button', { name: /Сессия|сессии/ }), null);
  assert.equal(within(hud).queryByRole('button', { name: /Уведомления/ }), null);
  assert.match(hud.textContent ?? '', /тихо/);
});

test('HudMeter without data reads «—» and is quiet', () => {
  render(<HudMeter label="КТКСТ" value="—" percent={null} ariaLabel="Контекст: нет данных" isPhone={false} onClick={() => undefined} />);
  const meter = screen.getByRole('button', { name: 'Контекст: нет данных' });
  assert.equal(meter.getAttribute('data-level'), 'none');
  assert.match(meter.textContent ?? '', /КТКСТ—/);
});
