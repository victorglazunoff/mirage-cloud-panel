import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { KabinaProjectRef, VoiceIntentResponse } from '@/shared/types';

const sent: unknown[] = [];
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    sendMessage: (message: unknown) => {
      sent.push(message);
      return true;
    },
    subscribe: () => () => undefined,
  }),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const apiMock = {
  voice: {
    health: vi.fn(async () => json({ configured: true, speechKit: true })),
    transcribe: vi.fn(async (_form: FormData) => json({ text: 'Напомни завтра в 11 позвонить Андрею' })),
    intent: vi.fn(async (_text: string, _zone?: string) => json(INTENT)),
  },
  calendar: {
    createEvent: vi.fn(async (_input: unknown) => json({ success: true, data: { id: 'ev-1' } }, 201)),
    deleteEvent: vi.fn(async () => json({ success: true })),
  },
  providers: {
    createSession: vi.fn(async () => json({ success: true, data: { sessionId: 's-new' } })),
  },
};

vi.mock('@/shared/api', () => ({
  api: apiMock,
  readApiJson: async (response: Response) => response.json(),
}));

const START = new Date(2026, 9, 27, 11, 0, 0).toISOString();
const INTENT: VoiceIntentResponse = {
  text: 'Напомни завтра в 11 позвонить Андрею',
  source: 'claude',
  recipients: [{ projectId: 'p-mir', projectName: 'Панель Мираж' }],
  actions: [
    { id: 'a1', kind: 'calendar_event', summary: 'Звонок', confidence: 0.9, title: 'Звонок — Андрей', eventType: 'call', start: START, end: null, whenText: 'завтра в 11', who: ['Андрей'] },
    { id: 'a2', kind: 'project_task', summary: 'План звонка', confidence: 0.8, text: 'Подготовь план звонка', recipient: { projectId: 'p-mir', projectName: 'Панель Мираж' }, candidates: [] },
  ],
};

const PROJECTS: KabinaProjectRef[] = [
  { projectId: 'p-mir', displayName: 'Панель Мираж', path: '/home/user/mirage-panel', isStarred: true },
];

/** A recorder that hands back one second of «audio» when stopped. */
class FakeRecorder {
  static isTypeSupported = () => true;
  mimeType = 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) });
    this.onstop?.();
  }
}

let micError: Error | null = null;
const trackStop = vi.fn();

beforeEach(() => {
  sent.length = 0;
  micError = null;
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        if (micError) throw micError;
        return { getTracks: () => [{ stop: trackStop }] };
      }),
    },
  });
  // Recordings must look longer than the «too short» threshold.
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    clock += 400;
    return clock;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function openOverlay(overrides: Partial<{ activeSessionId: string | null; activeProjectId: string | null }> = {}) {
  const { KabinaVoiceOverlay } = await import('@/modules/kabina-voice');
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <KabinaVoiceOverlay
        onClose={onClose}
        holding={false}
        buttonPresses={0}
        isPhone={false}
        activeSessionId={overrides.activeSessionId ?? null}
        activeProjectId={overrides.activeProjectId ?? null}
        projects={PROJECTS}
      />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByRole('heading', { name: 'СЛУШАЮ' })));
  return { onClose };
}

// First on purpose: a positive health answer is cached for the page.
test('without a SpeechKit key the overlay says so and never opens the microphone', async () => {
  apiMock.voice.health.mockImplementationOnce(async () => json({ configured: false, speechKit: false }));
  const { KabinaVoiceOverlay } = await import('@/modules/kabina-voice');
  render(
    <MemoryRouter>
      <KabinaVoiceOverlay onClose={() => undefined} holding={false} buttonPresses={0} isPhone={false} activeSessionId={null} activeProjectId={null} projects={PROJECTS} />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Распознавание не подключено')));
  assert.ok(screen.getByText('VOICE_NOT_CONFIGURED'));
  // The note says which setting turns it on, not a path on someone's machine.
  assert.ok(screen.getByText(/YANDEX_SPEECHKIT_API_KEY/));
  assert.equal((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls.length, 0);
});

test('record → «Готово, разобрать» → cards → Enter writes the event and starts the task dialog', async () => {
  await openOverlay();
  fireEvent.click(screen.getByRole('button', { name: 'Готово, разобрать' }));

  await waitFor(() => assert.ok(screen.getByText('Понял. Делаю так?')), { timeout: 3_000 });
  const form = apiMock.voice.transcribe.mock.calls[0][0];
  assert.ok(form.get('audio') instanceof Blob, 'the recording goes up as `audio`');
  assert.equal(apiMock.voice.intent.mock.calls[0][0], 'Напомни завтра в 11 позвонить Андрею');
  assert.ok(screen.getByRole('checkbox', { name: /Звонок — Андрей/ }));
  assert.ok(screen.getByRole('button', { name: /Выполнить · 2/ }));
  assert.equal(trackStop.mock.calls.length > 0, true, 'the microphone is released after recording');

  fireEvent.keyDown(document, { key: 'Enter' });
  await waitFor(() => assert.ok(screen.getByRole('heading', { name: 'ВЫПОЛНЕНО' })));

  const event = apiMock.calendar.createEvent.mock.calls[0][0] as Record<string, unknown>;
  assert.equal(event.type, 'call');
  assert.equal(event.title, 'Звонок — Андрей');
  assert.equal(event.startsAt, START);
  assert.equal(event.remindBeforeMin, 15);
  assert.deepEqual(apiMock.providers.createSession.mock.calls[0], [{ provider: 'claude', projectPath: '/home/user/mirage-panel', initialMessage: 'Подготовь план звонка' }]);
  assert.deepEqual(sent, [{ type: 'chat.send', sessionId: 's-new', content: 'Подготовь план звонка', options: {} }]);
  assert.ok(screen.getByRole('link', { name: 'Открыть календарь →' }));
});

test('an unticked card is not run', async () => {
  await openOverlay();
  fireEvent.click(screen.getByRole('button', { name: 'Готово, разобрать' }));
  await waitFor(() => assert.ok(screen.getByText('Понял. Делаю так?')), { timeout: 3_000 });
  fireEvent.click(screen.getByRole('checkbox', { name: /План звонка/ }));
  fireEvent.click(screen.getByRole('button', { name: /Выполнить · 1/ }));
  await waitFor(() => assert.ok(screen.getByRole('heading', { name: 'ВЫПОЛНЕНО' })));
  assert.equal(apiMock.calendar.createEvent.mock.calls.length, 1);
  assert.equal(apiMock.providers.createSession.mock.calls.length, 0);
});

test('a refused microphone and an empty phrase get their own cards', async () => {
  micError = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const { KabinaVoiceOverlay } = await import('@/modules/kabina-voice');
  const view = render(
    <MemoryRouter>
      <KabinaVoiceOverlay onClose={() => undefined} holding={false} buttonPresses={0} isPhone={false} activeSessionId={null} activeProjectId={null} projects={PROJECTS} />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Нет доступа к микрофону')));
  view.unmount();

  micError = null;
  apiMock.voice.transcribe.mockImplementationOnce(async () => json({ text: '' }));
  await openOverlay();
  fireEvent.click(screen.getByRole('button', { name: 'Готово, разобрать' }));
  await waitFor(() => assert.ok(screen.getByText('Ничего не расслышал')));
  assert.ok(screen.getByRole('button', { name: 'Записать заново' }));
});

test('desktop steps stay linear: 02 and 03 locked alike while listening, 01 passed once parsed', async () => {
  await openOverlay();
  const tabState = () => screen.getAllByRole('tab').map((tab) => `${tab.textContent}:${tab.getAttribute('data-state')}:${(tab as HTMLButtonElement).disabled ? 'off' : 'on'}`);
  assert.deepEqual(tabState(), ['01Слушаю:current:on', '02Понял:ahead:off', '03Куда отправить:ahead:off']);

  fireEvent.click(screen.getByRole('button', { name: 'Готово, разобрать' }));
  await waitFor(() => assert.ok(screen.getByText('Понял. Делаю так?')), { timeout: 3_000 });
  assert.deepEqual(tabState(), ['01Слушаю:passed:on', '02Понял:current:on', '03Куда отправить:ahead:on']);
});

test('phone: a microphone error keeps the dial, the mic and «Отмена / Готово»; the card sits in the transcript slot', async () => {
  micError = Object.assign(new Error('no device'), { name: 'NotFoundError' });
  const { KabinaVoiceOverlay } = await import('@/modules/kabina-voice');
  const onClose = vi.fn();
  const view = render(
    <MemoryRouter>
      <KabinaVoiceOverlay onClose={onClose} holding={false} buttonPresses={0} isPhone activeSessionId={null} activeProjectId={null} projects={PROJECTS} />
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok(screen.getByText('Микрофон не найден')));
  const listen = document.querySelector('.kb-vo-ph-listen');
  assert.ok(listen, 'the «Слушаю» screen stays');
  assert.ok(listen.querySelector('.kb-vo-ph-dial'), 'the dial stays');
  assert.ok(listen.querySelector('.kb-vo-ph-alert [role="alert"]'), 'the card is inside the screen');
  assert.equal(listen.querySelector('.kb-vo-ph-trans'), null, 'the card replaces the transcript');
  assert.ok(screen.getByRole('button', { name: 'Отмена' }));
  assert.ok(screen.getByRole('button', { name: /^Готово/ }));
  const mic = document.querySelector('.kb-vo-ph-mic .kb-voice') as HTMLButtonElement;
  assert.equal(mic.disabled, false, 'the big mic records again');
  const steps = [...document.querySelectorAll('.kb-vo-ph-step')].map((step) => step.getAttribute('data-state'));
  assert.deepEqual(steps, ['current', 'ahead', 'ahead']);

  micError = null;
  fireEvent.click(mic);
  await waitFor(() => assert.equal(screen.queryByText('Микрофон не найден'), null));
  view.unmount();
});

test('Esc while listening drops the recording; nothing is sent', async () => {
  await openOverlay();
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
  assert.ok(screen.getByText('Запись отменена — ничего не отправлено.'));
  assert.equal(apiMock.voice.transcribe.mock.calls.length, 0);
});

test('Enter on another button over the cards presses that button, not «Выполнить»', async () => {
  await openOverlay();
  fireEvent.click(screen.getByRole('button', { name: 'Готово, разобрать' }));
  await waitFor(() => assert.ok(screen.getByText('Понял. Делаю так?')), { timeout: 3_000 });
  const edit = screen.getByRole('button', { name: /Править текстом/ });
  edit.focus();
  await act(async () => {
    fireEvent.keyDown(edit, { key: 'Enter' });
  });
  assert.equal(apiMock.calendar.createEvent.mock.calls.length, 0, 'no event written');
  assert.equal(apiMock.providers.createSession.mock.calls.length, 0, 'no dialog started');
  assert.equal(sent.length, 0);
});

/** getUserMedia that answers only when the test says so (a permission prompt on screen). */
function holdMicrophone() {
  let grant: () => void = () => undefined;
  (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(
    () => new Promise((resolve) => {
      grant = () => resolve({ getTracks: () => [{ stop: trackStop }] });
    }),
  );
  return () => grant();
}

async function renderOverlay(holding = false) {
  const { KabinaVoiceOverlay } = await import('@/modules/kabina-voice');
  const props = { onClose: vi.fn(), buttonPresses: 0, isPhone: false, activeSessionId: null, activeProjectId: null, projects: PROJECTS };
  const view = render(<MemoryRouter><KabinaVoiceOverlay {...props} holding={holding} /></MemoryRouter>);
  await waitFor(() => assert.equal((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls.length, 1));
  return {
    view,
    setHolding: (next: boolean) => view.rerender(<MemoryRouter><KabinaVoiceOverlay {...props} holding={next} /></MemoryRouter>),
  };
}

test('Esc while the microphone is still opening frees it as soon as it arrives', async () => {
  const grant = holdMicrophone();
  await renderOverlay();
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
  assert.ok(screen.getByText('Запись отменена — ничего не отправлено.'));
  await act(async () => {
    grant();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(trackStop.mock.calls.length > 0, 'the late stream is stopped, the mic light goes off');
});

test('closing the overlay while the microphone is opening frees it too', async () => {
  const grant = holdMicrophone();
  const { view } = await renderOverlay();
  view.unmount();
  await act(async () => {
    grant();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(trackStop.mock.calls.length > 0);
});

test('⌥ Пробел released before the microphone opened still stops the recording', async () => {
  const grant = holdMicrophone();
  const { setHolding } = await renderOverlay(true);
  setHolding(false);
  await act(async () => {
    grant();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // Stopped right away — before the first 250 ms level tick, so not by the 60 s cap either.
  assert.ok(trackStop.mock.calls.length > 0, 'not left recording until «Готово» or the 60 s cap');
  await waitFor(() => assert.equal(apiMock.voice.transcribe.mock.calls.length, 1), { timeout: 3_000 });
});

test('with a chat open the phrase goes into that chat by default (steer)', async () => {
  await openOverlay({ activeSessionId: 's-1', activeProjectId: 'p-mir' });
  assert.ok(screen.getByRole('button', { name: /Кому: Текущий диалог · Панель Мираж/ }));
});
