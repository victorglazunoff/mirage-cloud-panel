import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import { AuthProvider } from '@/modules/auth/context/AuthContext';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

type StubbedReply = { status: number; body: unknown };

// The login and register routes hand every failure to the global error
// middleware, which answers with the structured AppError envelope; the auth
// middleware still answers with a bare `{ error: 'message' }`.
const envelope = (code: string, message: string, details?: unknown) => ({ success: false, error: { code, message, details } });

const STATUS: StubbedReply = { status: 200, body: { needsSetup: false, isAuthenticated: false, serverTime: Date.now() } };

// `api.auth.*` calls the global fetch directly, so stubbing it drives the
// real AuthProvider without any module mocks.
function stubAuthApi(replies: Record<string, StubbedReply>) {
  // `init` is part of the signature so tests can read the request body.
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const reply = replies[url] ?? { status: 404, body: { error: 'Not found' } };
    return new Response(
      typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
      { status: reply.status, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function submitLogin(username: string, password: string) {
  render(
    <AuthProvider>
      <LoginForm />
    </AuthProvider>,
  );
  // «Мираж»: the «Кабина» sign-in is Russian whatever the language preference.
  fireEvent.change(await screen.findByLabelText('ЛОГИН'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('ПАРОЛЬ'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
}

async function submitSetup(username: string, password: string) {
  render(
    <AuthProvider>
      <SetupForm />
    </AuthProvider>,
  );
  fireEvent.change(await screen.findByLabelText('ЛОГИН'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('ПАРОЛЬ'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('ПАРОЛЬ ЕЩЁ РАЗ'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать и войти' }));
}

describe('Kabina sign-in surfaces server errors as text', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says the password is wrong and how many attempts are left, and keeps the form', async () => {
    stubAuthApi({
      '/api/auth/status': STATUS,
      '/api/auth/login': {
        status: 401,
        body: envelope('AUTH_INVALID_CREDENTIALS', 'Логин или пароль не подходят', {
          attemptsLeft: 2,
          maxAttempts: 5,
          retryAfterSec: null,
          lockedUntil: null,
        }),
      },
    });

    await submitLogin('triage', 'wrong-password');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Логин или пароль не подходят');
    expect(alert.textContent).toContain('Осталось 2 попытки');
    expect(document.querySelectorAll('form')).toHaveLength(1);
    // The attempts dial reads the server's counters: 3 of 5 spent.
    expect(screen.getByRole('img', { name: /Попытки: 3 \/ 5/ })).toBeTruthy();
    // The next attempt is typed straight away: the password is focused and selected.
    const password = screen.getByLabelText('ПАРОЛЬ') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(password));
    expect([password.selectionStart, password.selectionEnd]).toEqual([0, 'wrong-password'.length]);
  });

  it('closes the form and counts down when the server locks sign-in', async () => {
    stubAuthApi({
      '/api/auth/status': STATUS,
      '/api/auth/login': {
        status: 429,
        body: envelope('AUTH_LOCKED', 'Слишком много попыток', {
          attemptsLeft: 0,
          maxAttempts: 5,
          retryAfterSec: 899,
          lockedUntil: new Date(Date.now() + 899_000).toISOString(),
        }),
      },
    });

    await submitLogin('triage', 'wrong-password');

    expect(await screen.findByRole('timer')).toHaveProperty('textContent', '14:59');
    expect(document.querySelectorAll('form')).toHaveLength(0);
    expect(screen.getByText('mirage passwd')).toBeTruthy();
  });

  it('still shows the bare string error the auth middleware sends', async () => {
    stubAuthApi({
      '/api/auth/status': STATUS,
      '/api/auth/login': { status: 401, body: { error: 'Invalid API key' } },
    });

    await submitLogin('triage', 'triage-pass-123');

    expect((await screen.findByRole('alert')).textContent).toContain('Invalid API key');
  });

  it('falls back to the localized message when the envelope carries no usable message', async () => {
    stubAuthApi({
      '/api/auth/status': STATUS,
      '/api/auth/login': { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: '  ' } } },
    });

    await submitLogin('triage', 'triage-pass-123');

    expect((await screen.findByRole('alert')).textContent).toContain('Login failed');
  });

  it('falls back to the localized message when the body is not JSON', async () => {
    stubAuthApi({
      '/api/auth/status': STATUS,
      '/api/auth/login': { status: 502, body: '<html>Bad Gateway</html>' },
    });

    await submitLogin('triage', 'triage-pass-123');

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Login failed');
    });
  });

  it('asks for the code, remembers the device and opens «Доступ открыт»', async () => {
    const fetchMock = stubAuthApi({
      '/api/auth/status': STATUS,
      '/api/auth/login': {
        status: 200,
        body: { success: true, twoFactorRequired: true, challengeToken: 'challenge', methods: ['totp', 'backup'], user: { username: 'alice' } },
      },
      '/api/auth/login/2fa': {
        status: 200,
        body: {
          success: true,
          user: { id: 1, username: 'alice' },
          token: 'aaa.bbb.ccc',
          trustedDevice: { deviceToken: 'device-secret', expiresAt: '2026-11-25T10:00:00.000Z' },
        },
      },
      '/api/auth/sessions': { status: 200, body: { sessions: [{ current: true, deviceLabel: 'Mac · Chrome' }] } },
    });

    await submitLogin('alice', 'right-password');

    expect(await screen.findByRole('heading', { name: 'Код из приложения' })).toBeTruthy();
    expect(screen.getByText('«Mirage · alice»')).toBeTruthy();
    // A one-time code autofilled into the first cell spreads over all six.
    fireEvent.change(screen.getByLabelText('Цифра 1 из 6'), { target: { value: '482913' } });
    expect((screen.getByLabelText('Цифра 6 из 6') as HTMLInputElement).value).toBe('3');
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));

    expect(await screen.findByRole('heading', { name: 'Доступ открыт' })).toBeTruthy();
    expect(localStorage.getItem('mirage-device-token')).toBe('device-secret');
    expect(screen.getByText(/запомнено до 25\.11/)).toBeTruthy();
    const twoFactorCall = fetchMock.mock.calls.find(([url]) => url === '/api/auth/login/2fa');
    expect(JSON.parse(String(twoFactorCall![1]!.body))).toEqual({
      challengeToken: 'challenge',
      code: '482913',
      rememberDevice: true,
    });
  });

  it('sends the remembered device token with the password', async () => {
    localStorage.setItem('mirage-device-token', 'device-secret');
    const fetchMock = stubAuthApi({
      '/api/auth/status': STATUS,
      '/api/auth/login': { status: 401, body: envelope('AUTH_INVALID_CREDENTIALS', 'нет') },
    });

    await submitLogin('alice', 'pass-123456');
    await screen.findByRole('alert');

    const loginCall = fetchMock.mock.calls.find(([url]) => url === '/api/auth/login');
    expect(JSON.parse(String(loginCall![1]!.body)).deviceToken).toBe('device-secret');
  });

  it('shows the code error from the server', async () => {
    stubAuthApi({
      '/api/auth/status': STATUS,
      '/api/auth/login': {
        status: 200,
        body: { success: true, twoFactorRequired: true, challengeToken: 'challenge', methods: ['totp'], user: { username: 'alice' } },
      },
      '/api/auth/login/2fa': {
        status: 401,
        body: envelope('AUTH_INVALID_2FA_CODE', 'Код не подошёл.', { attemptsLeft: 4, maxAttempts: 5, retryAfterSec: null, lockedUntil: null }),
      },
    });

    await submitLogin('alice', 'right-password');
    fireEvent.change(await screen.findByLabelText('Цифра 1 из 6'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Код не подошёл · осталось 4 попытки');
  });

  it('shows the message of the structured envelope when registration is rejected', async () => {
    stubAuthApi({
      '/api/auth/status': { status: 200, body: { needsSetup: true, isAuthenticated: false } },
      '/api/auth/register': {
        status: 403,
        body: envelope('AUTH_USER_ALREADY_CONFIGURED', 'User already exists. This is a single-user system.'),
      },
    });

    await submitSetup('triage', 'triage-pass-123');

    expect((await screen.findByRole('alert')).textContent).toBe('User already exists. This is a single-user system.');
    expect(document.querySelectorAll('form')).toHaveLength(1);
  });
});
