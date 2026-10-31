import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { api, readApiErrorMessage } from '@/shared/api';
import { AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, getAuthTokenRefreshDelay, isValidRefreshedToken, storeAuthToken } from '@/shared/authToken';
import { hydrateChatDrafts, resetChatDrafts } from '@/shared/chatDrafts';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
import type { AuthAttemptInfo, AuthLoginOutcome, PendingAuthSession } from '@/shared/types';
/** The signed-in account held by AuthContext - a required `username` plus an optional id and any additional fields the auth API returns - and should be read through `useAuth()` rather than re-derived from raw auth responses. */
type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

const AUTH_TOKEN_STORAGE_KEY = 'auth-token';
// Mirage: the remembered-device token from a 2FA step («запомнить на 30 дней»).
// Kept apart from the session token so signing out does not forget the device.
const TRUSTED_DEVICE_STORAGE_KEY = 'mirage-device-token';

const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'errors.authStatusCheckFailed',
  loginFailed: 'errors.loginFailed',
  registrationFailed: 'errors.registrationFailed',
  networkError: 'errors.networkError',
  sessionExpired: 'errors.sessionExpired',
} as const;

type AuthActionResult = { success: true } | { success: false; error: string };

type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  twoFactorRequired?: boolean;
  challengeToken?: string;
  trustedDevice?: { deviceToken?: string; expiresAt?: string };
};

type AuthStatusPayload = {
  needsSetup?: boolean;
};

type AuthUserPayload = {
  user?: AuthUser;
};

type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  /** Mirage: the password step without publishing the session (the Kabina sign-in shows «Доступ открыт» first). */
  requestLogin: (username: string, password: string) => Promise<AuthLoginOutcome>;
  /** Mirage: the code step after `requestLogin` asked for a second factor. */
  verifySecondFactor: (input: {
    challengeToken: string;
    code?: string;
    backupCode?: string;
    rememberDevice: boolean;
  }) => Promise<AuthLoginOutcome>;
  /** Mirage: publishes a session from `requestLogin`/`verifySecondFactor` and opens the app. */
  enterSession: (session: PendingAuthSession) => Promise<void>;
  /** Mirage: swaps in a token the server re-issued (password change, «выйти на остальных»). */
  adoptToken: (nextToken: string) => void;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

type AuthProviderProps = {
  children: ReactNode;
};

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  storeAuthToken(token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

const readTrustedDeviceToken = (): string | null => {
  try {
    return localStorage.getItem(TRUSTED_DEVICE_STORAGE_KEY);
  } catch {
    return null;
  }
};

const storeTrustedDeviceToken = (deviceToken: string) => {
  try {
    localStorage.setItem(TRUSTED_DEVICE_STORAGE_KEY, deviceToken);
  } catch {
    // Private mode: the device is simply not remembered.
  }
};

/** Attempt counters from a refused sign-in's `error.details`, when the server sent them. */
function readAttemptInfo(payload: unknown): AuthAttemptInfo | null {
  const error = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : null;
  const details = error && typeof error === 'object' ? (error as { details?: unknown }).details : null;
  if (!details || typeof details !== 'object') return null;
  const raw = details as Record<string, unknown>;
  if (typeof raw.attemptsLeft !== 'number' || typeof raw.maxAttempts !== 'number') return null;
  return {
    attemptsLeft: raw.attemptsLeft,
    maxAttempts: raw.maxAttempts,
    retryAfterSec: typeof raw.retryAfterSec === 'number' ? raw.retryAfterSec : null,
    lockedUntil: typeof raw.lockedUntil === 'string' ? raw.lockedUntil : null,
  };
}

function readErrorCode(payload: unknown): string | null {
  const error = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : null;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' ? code : null;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/** Used by App to expose the session, and its login/logout actions, to every module through useAuth. */
export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation('auth');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tokenRef = useRef(token);
  tokenRef.current = token;

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredToken();
    // Otherwise the next person to sign in on this device would start out
    // looking at the previous user's theme, language, permissions and drafts.
    resetUserPreferences();
    resetChatDrafts();
  }, []);

  // Preferences live in auth.db, so they can only be fetched once there is a
  // user to fetch them for. Until this resolves, every reader falls back to the
  // localStorage mirror of the last known server state.
  const userKey = user ? String(user.id ?? user.username) : null;
  useEffect(() => {
    if (!userKey) {
      return;
    }
    void hydrateUserPreferences();
    void hydrateChatDrafts();
  }, [userKey]);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const refreshSession = useCallback(async () => {
    if (IS_PLATFORM || !token || !user) {
      return;
    }

    try {
      const response = await api.auth.refresh();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (isValidRefreshedToken(payload?.token)) {
        setToken(payload.token);
        persistToken(payload.token);
      }
    } catch (caughtError) {
      // A transient network failure must not sign the user out. Focus/visibility
      // and the next scheduled refresh will retry while the token remains valid.
      console.warn('[Auth] Session refresh failed:', caughtError);
    }
  }, [token, user]);

  useEffect(() => {
    const handleTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<unknown>).detail;
      if (isValidRefreshedToken(nextToken)) {
        setToken(nextToken);
      }
    };
    const handleSessionExpired = () => {
      // Mirage: a first visit without a token also gets a 401 — that is not an expired session.
      const hadToken = tokenRef.current !== null;
      clearSession();
      if (hadToken) {
        setError(t(AUTH_ERROR_MESSAGES.sessionExpired));
      }
    };

    window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, [clearSession, t]);

  // The startup check below needs `t` only for its failure message.
  // react-i18next gives `t` a new identity on every language change, so
  // depending on it would re-run that check - and swap the whole app for the
  // loading screen - whenever the language changes, including when sign-in
  // adopts the language saved on another device.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      // Read the stored token instead of depending on `token` state: this
      // bootstrap flips `isLoading`, which swaps the whole app for the loading
      // screen, so it must run once on mount and not again on every
      // X-Refreshed-Token rotation (each one remounted the workspace, #1269).
      if (!readStoredToken()) {
        return;
      }

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setUser(userPayload.user);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(tRef.current(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  useEffect(() => {
    if (IS_PLATFORM || !token || !user) {
      return undefined;
    }

    const refreshIfNeeded = () => {
      const refreshDelay = getAuthTokenRefreshDelay(token);
      if (refreshDelay !== null && refreshDelay <= 0) {
        void refreshSession();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshIfNeeded();
      }
    };

    const refreshDelay = getAuthTokenRefreshDelay(token);
    const refreshTimer = refreshDelay === null
      ? null
      : window.setTimeout(() => void refreshSession(), refreshDelay);

    window.addEventListener('focus', refreshIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      window.removeEventListener('focus', refreshIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshSession, token, user]);

  // ProtectedRoute shows the workspace as soon as there is a user, so the
  // onboarding status is settled before the user is published; otherwise a
  // user who still has to onboard would see the workspace mount for a whole
  // round trip before Onboarding replaced it. The token is stored first
  // because that request reads it from storage.
  const publishSession = useCallback(async (nextUser: AuthUser, nextToken: string) => {
    persistToken(nextToken);
    await checkOnboardingStatus();
    setUser(nextUser);
    setToken(nextToken);
    setNeedsSetup(false);
  }, [checkOnboardingStatus]);

  /**
   * Turns a login or code-step reply into an outcome without publishing it.
   * A remembered-device token in the reply is stored right away: the server
   * has already recorded the device, whatever the screen does next.
   */
  const readLoginReply = useCallback(
    async (response: Response): Promise<AuthLoginOutcome> => {
      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (response.ok && payload?.twoFactorRequired && payload.challengeToken) {
        return { kind: 'second-factor', challengeToken: payload.challengeToken, username: payload.user?.username ?? '' };
      }
      if (!response.ok || !payload?.token || !payload.user) {
        // Most auth failures arrive as the structured AppError envelope; passing its
        // `error` object on would render it as a React child and blank the screen.
        const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.loginFailed);
        return { kind: 'error', message, code: readErrorCode(payload), attempts: readAttemptInfo(payload) };
      }
      const device = payload.trustedDevice;
      if (device?.deviceToken) {
        storeTrustedDeviceToken(device.deviceToken);
      }
      return {
        kind: 'session',
        session: {
          user: payload.user,
          token: payload.token,
          trustedDevice: device?.expiresAt ? { expiresAt: device.expiresAt } : null,
        },
      };
    },
    [t],
  );

  const requestLogin = useCallback<AuthContextValue['requestLogin']>(
    async (username, password) => {
      setError(null);
      try {
        // With a remembered device a 2FA account gets a token straight away.
        const response = await api.auth.login(username, password, readTrustedDeviceToken());
        return await readLoginReply(response);
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        return { kind: 'error', message: t(AUTH_ERROR_MESSAGES.networkError), code: 'NETWORK', attempts: null };
      }
    },
    [readLoginReply, t],
  );

  const verifySecondFactor = useCallback<AuthContextValue['verifySecondFactor']>(
    async (input) => {
      try {
        return await readLoginReply(await api.auth.loginTwoFactor(input));
      } catch (caughtError) {
        console.error('Second factor error:', caughtError);
        return { kind: 'error', message: t(AUTH_ERROR_MESSAGES.networkError), code: 'NETWORK', attempts: null };
      }
    },
    [readLoginReply, t],
  );

  const enterSession = useCallback<AuthContextValue['enterSession']>(
    async (session) => {
      await publishSession(session.user, session.token);
    },
    [publishSession],
  );

  const adoptToken = useCallback((nextToken: string) => {
    if (!isValidRefreshedToken(nextToken)) return;
    persistToken(nextToken);
    setToken(nextToken);
  }, []);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      const outcome = await requestLogin(username, password);
      if (outcome.kind === 'session') {
        await publishSession(outcome.session.user, outcome.session.token);
        return { success: true };
      }
      const message = outcome.kind === 'error' ? outcome.message : t(AUTH_ERROR_MESSAGES.loginFailed);
      setError(message);
      return { success: false, error: message };
    },
    [publishSession, requestLogin, t],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        await publishSession(payload.user, payload.token);
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [publishSession, t],
  );

  const logout = useCallback(() => {
    // Mirage: the server ends this sign-in in «Активные входы» too; the client
    // does not wait for it, clearing the local session is what signs out.
    if (!IS_PLATFORM && readStoredToken()) {
      void api.auth.logout().catch(() => undefined);
    }
    clearSession();
  }, [clearSession]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      login,
      requestLogin,
      verifySecondFactor,
      enterSession,
      adoptToken,
      register,
      logout,
      refreshOnboardingStatus,
    }),
    [
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      needsSetup,
      requestLogin,
      verifySecondFactor,
      enterSession,
      adoptToken,
      refreshOnboardingStatus,
      register,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
