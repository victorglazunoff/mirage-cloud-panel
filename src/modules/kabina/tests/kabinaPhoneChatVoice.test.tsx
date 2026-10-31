import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useKabinaVoiceControl } from '@/modules/kabina/context/KabinaVoiceContext';
import { HOLD_MS, usePressOrHold } from '@/modules/kabina/hooks/usePressOrHold';
import type { KabinaProjectRef } from '@/shared/types';

// One stable socket object: a fresh one per render would re-run the connection watch forever.
const socket = { connectionStatus: 'connected' as const, reconnectNow: vi.fn(), subscribe: () => () => undefined };
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => socket,
}));

vi.mock('@/shared/api', () => ({
  api: { home: { overview: vi.fn(async () => new Response(JSON.stringify({ data: { activity: [] } }))) } },
  readApiJson: async (response: Response) => response.json(),
}));

const PROJECTS: KabinaProjectRef[] = [{ projectId: 'p-zag', displayName: 'Сайт клиента', path: '/home/user/demo-site', isStarred: true }];

const probe = { location: '' };
function LocationProbe() {
  const location = useLocation();
  useEffect(() => {
    probe.location = `${location.pathname}${location.search}`;
  }, [location]);
  return null;
}

/** Stands in for the phone composer microphone: the same hook and the same shell control. */
function ComposerMicProbe() {
  const voice = useKabinaVoiceControl();
  const press = usePressOrHold({ onTap: voice?.press ?? (() => undefined), onHoldStart: voice?.holdStart, onHoldEnd: voice?.holdEnd });
  return <button type="button" {...press}>микрофон композера</button>;
}

async function renderPhoneChat() {
  const { KabinaApp } = await import('@/modules/kabina');
  render(
    <MemoryRouter initialEntries={['/p/p-zag/s/s-1']}>
      <KabinaApp
        isPhone
        projects={PROJECTS}
        chatTitle={{ projectName: 'Сайт клиента', sessionTitle: 'Выкладка цен' }}
        renderHome={() => null}
        renderChat={() => <ComposerMicProbe />}
        renderAgents={() => null}
        renderProjects={() => null}
        renderFiles={() => null}
        renderSettings={() => null}
        renderSearch={() => null}
        renderVoice={(slot) => <div role="dialog" aria-label="ГОЛОС" data-holding={String(slot.holding)} />}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('phone chat: no floating voice button over «Отправить» — the composer has its own mic', async () => {
  await renderPhoneChat();
  assert.equal(screen.queryByRole('button', { name: /Сказать Claude голосом/ }), null);
  assert.ok(screen.getByRole('button', { name: 'микрофон композера' }));
});

test('phone chat: holding the composer mic records while held, release sends; a tap just opens voice', async () => {
  await renderPhoneChat();
  vi.useFakeTimers();
  const mic = screen.getByRole('button', { name: 'микрофон композера' });

  fireEvent.pointerDown(mic, { button: 0, pointerId: 1 });
  act(() => { vi.advanceTimersByTime(HOLD_MS + 10); });
  assert.equal(probe.location, '/p/p-zag/s/s-1?voice');
  assert.equal(screen.getByRole('dialog', { name: 'ГОЛОС' }).dataset.holding, 'true');
  fireEvent.pointerUp(mic, { pointerId: 1 });
  assert.equal(screen.getByRole('dialog', { name: 'ГОЛОС' }).dataset.holding, 'false', 'release sends the phrase');
});

test('phone chat: a short tap on the composer mic opens voice without a hold', async () => {
  await renderPhoneChat();
  const mic = screen.getByRole('button', { name: 'микрофон композера' });
  fireEvent.pointerDown(mic, { button: 0, pointerId: 2 });
  fireEvent.pointerUp(mic, { pointerId: 2 });
  fireEvent.click(mic);
  assert.equal(probe.location, '/p/p-zag/s/s-1?voice');
  assert.equal(screen.getByRole('dialog', { name: 'ГОЛОС' }).dataset.holding, 'false');
});
