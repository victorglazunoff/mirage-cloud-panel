import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { authSecurityDb } from '@/modules/database/index.js';
import type { AuthSessionRow, UserSecurityRow } from '@/modules/database/index.js';
import type {
  AuthAttemptDetails,
  AuthLoginResult,
  AuthSessionView,
  AuthTrustedDeviceView,
  AuthTwoFactorStatus,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import {
  buildOtpauthUri,
  findBackupCodeIndex,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  verifyTotpCode,
} from './totp.service.js';

/**
 * Mirage sign-in security (Б11, Х9): attempt throttling, sign-ins that can be
 * listed and revoked, TOTP with backup codes, remembered devices and password
 * change. Secrets stay in the database; nothing here logs them.
 */

const MINUTE_MS = 60_000;
/** Five wrong answers in a row lock the key for fifteen minutes (DarkLogin). */
export const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * MINUTE_MS;
const ATTEMPT_WINDOW_MS = 15 * MINUTE_MS;
/** A sign-in unused for this long no longer counts (and its token stops working). */
const SESSION_IDLE_LIMIT_MS = 30 * 24 * 60 * MINUTE_MS;
const SESSION_TOUCH_INTERVAL_MS = MINUTE_MS;
const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * MINUTE_MS;
const PENDING_SETUP_TTL_MS = 15 * MINUTE_MS;
const MIN_NEW_PASSWORD_LENGTH = 12;
/** bcrypt ignores everything past 72 bytes; longer passwords would only look stronger. */
const MAX_PASSWORD_BYTES = 72;

type AuthUser = { id: number | bigint; username: string };

/** Who is signing in, for the «Активные входы» list. */
type ClientContext = { userAgent: string | null; ipAddress: string | null };

type AuthSecurityDependencies = {
  now(): number;
  store: typeof authSecurityDb;
  users: {
    getUserById(userId: number): AuthUser | undefined;
    getPasswordHashById(userId: number): string | undefined;
    updatePasswordHash(userId: number, passwordHash: string): boolean;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  /** Signs a session token carrying the `sid` claim. */
  signToken(user: AuthUser, sessionId: string): string;
  /** Signs the short-lived token that links the password step to the code step. */
  signChallenge(payload: { userId: number; nonce: string }): string;
  verifyChallenge(token: string): { userId: number; nonce: string; expMs: number } | null;
};

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readBackupHashes(row: UserSecurityRow | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(row?.backup_codes ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * «MacBook · Chrome», «iPhone · Safari» — enough to recognise one's own
 * devices in the list; the full user agent is returned alongside.
 */
export function describeUserAgent(userAgent: string | null): { label: string; kind: AuthSessionView['deviceKind'] } {
  const ua = userAgent ?? '';
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux'
              : null;
  const browser = /YaBrowser/.test(ua) ? 'Яндекс Браузер'
    : /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : /curl|node|undici/i.test(ua) ? 'скрипт'
                : null;
  const kind: AuthSessionView['deviceKind'] = device === 'iPhone' || (device === 'Android' && /Mobile/.test(ua)) ? 'phone'
    : device === 'Mac' || device === 'iPad' ? 'laptop'
      : device ? 'desktop'
        : 'unknown';
  const label = [device, browser].filter(Boolean).join(' · ') || 'Неизвестное устройство';
  return { label, kind };
}

/**
 * Decides whether a verified JWT still stands: not issued before the user's
 * `tokens_valid_after` (password change, «выйти везде»), and — when it names a
 * sign-in — that sign-in is alive. Touches the sign-in's last-seen time at
 * most once a minute.
 *
 * Used by the auth middleware for REST and WebSocket authentication.
 */
export function isTokenSessionActive(
  claims: { userId: number; iat?: number; sid?: string },
  nowMs: number,
  store: typeof authSecurityDb = authSecurityDb,
): boolean {
  const security = store.getUserSecurity(claims.userId);
  if (security?.tokens_valid_after && (claims.iat ?? 0) < security.tokens_valid_after) {
    return false;
  }
  if (!claims.sid) {
    return true;
  }
  const session = store.getSession(claims.sid);
  if (!session || session.user_id !== claims.userId || session.revoked_at) {
    return false;
  }
  const lastSeen = Date.parse(`${session.last_seen_at.replace(' ', 'T')}${session.last_seen_at.endsWith('Z') ? '' : 'Z'}`);
  if (Number.isFinite(lastSeen) && nowMs - lastSeen > SESSION_IDLE_LIMIT_MS) {
    return false;
  }
  if (!Number.isFinite(lastSeen) || nowMs - lastSeen > SESSION_TOUCH_INTERVAL_MS) {
    store.touchSession(session.id, toIso(nowMs));
  }
  return true;
}

/** Creates the security service; the module composition injects bcrypt and JWT signing. */
export function createAuthSecurityService(dependencies: AuthSecurityDependencies) {
  const { store } = dependencies;
  const usedChallengeNonces = new Map<string, number>();

  const attemptDetails = (failedCount: number, lockedUntil: number | null): AuthAttemptDetails => {
    const now = dependencies.now();
    const locked = lockedUntil !== null && lockedUntil > now;
    return {
      attemptsLeft: locked ? 0 : Math.max(0, MAX_FAILED_ATTEMPTS - failedCount),
      maxAttempts: MAX_FAILED_ATTEMPTS,
      retryAfterSec: locked ? Math.ceil((lockedUntil - now) / 1000) : null,
      lockedUntil: locked ? toIso(lockedUntil) : null,
    };
  };

  const lockedError = (details: AuthAttemptDetails): AppError => new AppError(
    'Слишком много попыток — вход закрыт на 15 минут, чтобы пароль нельзя было подобрать.',
    { code: 'AUTH_LOCKED', statusCode: 429, details },
  );

  /** Throws `AUTH_LOCKED` while the key is locked. */
  const assertAttemptAllowed = (key: string): void => {
    const row = store.getThrottle(key);
    if (row?.locked_until && row.locked_until > dependencies.now()) {
      throw lockedError(attemptDetails(row.failed_count, row.locked_until));
    }
  };

  /**
   * Counts one failure and throws: `AUTH_LOCKED` when this was the fifth,
   * otherwise the caller's error with `attemptsLeft` in its details.
   */
  const failAttempt = (key: string, message: string, code: string, statusCode: number): never => {
    const now = dependencies.now();
    const row = store.getThrottle(key);
    const expired = !row
      || now - row.window_started_at > ATTEMPT_WINDOW_MS
      || (row.locked_until !== null && row.locked_until <= now);
    const failedCount = expired ? 1 : row.failed_count + 1;
    const lockedUntil = failedCount >= MAX_FAILED_ATTEMPTS ? now + LOCK_MS : null;
    store.saveThrottle({
      throttle_key: key,
      failed_count: failedCount,
      window_started_at: expired ? now : row.window_started_at,
      locked_until: lockedUntil,
    });
    const details = attemptDetails(failedCount, lockedUntil);
    if (lockedUntil !== null) {
      throw lockedError(details);
    }
    throw new AppError(message, { code, statusCode, details });
  };

  const issueSession = (user: AuthUser, context: ClientContext): { token: string; sessionId: string } => {
    const now = dependencies.now();
    store.pruneSessions(toIso(now - SESSION_IDLE_LIMIT_MS));
    const sessionId = randomUUID();
    store.createSession({
      id: sessionId,
      userId: Number(user.id),
      userAgent: context.userAgent?.slice(0, 500) ?? null,
      ipAddress: context.ipAddress?.slice(0, 100) ?? null,
      nowIso: toIso(now),
    });
    return { token: dependencies.signToken(user, sessionId), sessionId };
  };

  const isTwoFactorEnabled = (row: UserSecurityRow | undefined): row is UserSecurityRow & { totp_secret: string } =>
    Boolean(row?.totp_secret && row.totp_enabled_at);

  /**
   * Checks a TOTP code (with replay protection) or a backup code (consumed).
   * Returns false when neither matches; the caller counts the failure.
   */
  const checkSecondFactor = (userId: number, code: string | null, backupCode: string | null): boolean => {
    const row = store.getUserSecurity(userId);
    if (!isTwoFactorEnabled(row)) {
      return false;
    }
    if (code) {
      const step = verifyTotpCode(row.totp_secret, code, dependencies.now());
      return step !== null && store.claimTotpStep(userId, step);
    }
    if (backupCode) {
      const hashes = readBackupHashes(row);
      const index = findBackupCodeIndex(hashes, backupCode);
      if (index < 0) return false;
      const remaining = hashes.filter((_, position) => position !== index);
      return store.consumeBackupCode(userId, row.backup_codes, JSON.stringify(remaining));
    }
    return false;
  };

  /** Re-checks the current password for sensitive changes, throttled per user. */
  const assertCurrentPassword = async (userId: number, password: unknown): Promise<void> => {
    const key = `password:${userId}`;
    assertAttemptAllowed(key);
    const hash = dependencies.users.getPasswordHashById(userId);
    const valid = typeof password === 'string' && password.length > 0 && hash
      ? await dependencies.comparePassword(password, hash)
      : false;
    if (!valid) {
      failAttempt(key, 'Текущий пароль не подходит.', 'AUTH_WRONG_PASSWORD', 403);
    }
    store.clearThrottle(key);
  };

  const requireUser = (userId: number): AuthUser => {
    const user = dependencies.users.getUserById(userId);
    if (!user) {
      throw new AppError('Пользователь не найден.', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
    }
    return user;
  };

  const toSessionView = (row: AuthSessionRow, currentSessionId: string | null): AuthSessionView => {
    const device = describeUserAgent(row.user_agent);
    return {
      id: row.id,
      deviceLabel: device.label,
      deviceKind: device.kind,
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      current: row.id === currentSessionId,
    };
  };

  return {
    assertAttemptAllowed,
    failAttempt,
    clearAttempts: (key: string) => store.clearThrottle(key),
    issueSession,

    /**
     * After a correct password: a session token, or — with TOTP on and no
     * valid remembered device — a challenge for the code step.
     */
    completePasswordLogin(user: AuthUser, context: ClientContext, deviceToken: string | null): AuthLoginResult {
      const userId = Number(user.id);
      const security = store.getUserSecurity(userId);
      if (isTwoFactorEnabled(security)) {
        const now = dependencies.now();
        const device = deviceToken ? store.findTrustedDevice(userId, sha256(deviceToken), toIso(now)) : undefined;
        if (!device) {
          return {
            success: true,
            twoFactorRequired: true,
            challengeToken: dependencies.signChallenge({ userId, nonce: randomUUID() }),
            methods: ['totp', 'backup'],
            user: { username: user.username },
          };
        }
        store.markTrustedDeviceUsed(device.id, toIso(now));
      }
      const { token } = issueSession(user, context);
      return { success: true, user: { id: user.id, username: user.username }, token };
    },

    /** The code step: a TOTP or backup code against a challenge from the password step. */
    completeTwoFactorLogin(input: {
      challengeToken: string;
      code: string | null;
      backupCode: string | null;
      rememberDevice: boolean;
      context: ClientContext;
    }): AuthLoginResult {
      const now = dependencies.now();
      const challenge = dependencies.verifyChallenge(input.challengeToken);
      if (!challenge || usedChallengeNonces.has(challenge.nonce)) {
        throw new AppError('Время на ввод кода вышло — войди заново.', {
          code: 'AUTH_2FA_CHALLENGE_EXPIRED',
          statusCode: 401,
        });
      }
      const key = `totp:${challenge.userId}`;
      assertAttemptAllowed(key);
      if (!checkSecondFactor(challenge.userId, input.code, input.backupCode)) {
        failAttempt(
          key,
          input.backupCode ? 'Резервный код не подошёл.' : 'Код не подошёл.',
          'AUTH_INVALID_2FA_CODE',
          401,
        );
      }
      store.clearThrottle(key);
      for (const [nonce, expMs] of usedChallengeNonces) {
        if (expMs < now) usedChallengeNonces.delete(nonce);
      }
      usedChallengeNonces.set(challenge.nonce, challenge.expMs);

      const user = requireUser(challenge.userId);
      const { token } = issueSession(user, input.context);
      let trustedDevice: { deviceToken: string; expiresAt: string } | undefined;
      if (input.rememberDevice) {
        const deviceToken = randomBytes(32).toString('base64url');
        const expiresAt = toIso(now + TRUSTED_DEVICE_TTL_MS);
        store.createTrustedDevice({
          id: randomUUID(),
          userId: challenge.userId,
          tokenHash: sha256(deviceToken),
          label: describeUserAgent(input.context.userAgent).label,
          expiresAtIso: expiresAt,
        });
        trustedDevice = { deviceToken, expiresAt };
      }
      return { success: true, user: { id: user.id, username: user.username }, token, trustedDevice };
    },

    getTwoFactorStatus(userId: number): AuthTwoFactorStatus {
      const row = store.getUserSecurity(userId);
      const now = dependencies.now();
      const pendingCreated = row?.totp_pending_created_at ? Date.parse(row.totp_pending_created_at) : Number.NaN;
      return {
        enabled: isTwoFactorEnabled(row),
        enabledAt: row?.totp_enabled_at ?? null,
        pendingSetup: Boolean(row?.totp_pending_secret) && now - pendingCreated < PENDING_SETUP_TTL_MS,
        backupCodesLeft: isTwoFactorEnabled(row) ? readBackupHashes(row).length : 0,
        trustedDevices: store.listTrustedDevices(userId, toIso(now)).length,
      };
    },

    /** Step 1 of enabling: a pending secret and its otpauth URI (for the QR code). */
    async beginTwoFactorSetup(userId: number, currentPassword: unknown) {
      await assertCurrentPassword(userId, currentPassword);
      const user = requireUser(userId);
      if (isTwoFactorEnabled(store.getUserSecurity(userId))) {
        throw new AppError('Второй фактор уже включён — сначала выключи его.', {
          code: 'AUTH_2FA_ALREADY_ENABLED',
          statusCode: 409,
        });
      }
      const secret = generateTotpSecret();
      store.updateUserSecurity(userId, {
        totp_pending_secret: secret,
        totp_pending_created_at: toIso(dependencies.now()),
      });
      return { secret, otpauthUri: buildOtpauthUri(secret, user.username), issuer: 'Mirage', accountName: user.username };
    },

    /** Step 2: the first code from the app turns 2FA on and yields ten backup codes, shown once. */
    enableTwoFactor(userId: number, code: unknown): { enabled: true; backupCodes: string[] } {
      const row = store.getUserSecurity(userId);
      const now = dependencies.now();
      const pendingCreated = row?.totp_pending_created_at ? Date.parse(row.totp_pending_created_at) : Number.NaN;
      if (!row?.totp_pending_secret || !(now - pendingCreated < PENDING_SETUP_TTL_MS)) {
        throw new AppError('Настройка устарела — начни заново.', { code: 'AUTH_2FA_SETUP_EXPIRED', statusCode: 409 });
      }
      const key = `totp:${userId}`;
      assertAttemptAllowed(key);
      const step = typeof code === 'string' ? verifyTotpCode(row.totp_pending_secret, code, now) : null;
      if (step === null) {
        failAttempt(key, 'Код не подошёл. Проверь, что время на телефоне ставится автоматически.', 'AUTH_INVALID_2FA_CODE', 400);
      }
      store.clearThrottle(key);
      const backupCodes = generateBackupCodes();
      store.updateUserSecurity(userId, {
        totp_secret: row.totp_pending_secret,
        totp_enabled_at: toIso(now),
        totp_pending_secret: null,
        totp_pending_created_at: null,
        last_totp_step: step,
        backup_codes: JSON.stringify(backupCodes.map(hashBackupCode)),
      });
      return { enabled: true, backupCodes };
    },

    /** Turns 2FA off: password plus a TOTP or backup code; remembered devices are forgotten. */
    async disableTwoFactor(userId: number, input: { currentPassword: unknown; code: string | null; backupCode: string | null }) {
      await assertCurrentPassword(userId, input.currentPassword);
      if (!isTwoFactorEnabled(store.getUserSecurity(userId))) {
        return { enabled: false };
      }
      const key = `totp:${userId}`;
      assertAttemptAllowed(key);
      if (!checkSecondFactor(userId, input.code, input.backupCode)) {
        failAttempt(key, 'Код не подошёл.', 'AUTH_INVALID_2FA_CODE', 400);
      }
      store.clearThrottle(key);
      store.updateUserSecurity(userId, {
        totp_secret: null,
        totp_enabled_at: null,
        totp_pending_secret: null,
        totp_pending_created_at: null,
        last_totp_step: null,
        backup_codes: '[]',
      });
      store.removeAllTrustedDevices(userId);
      return { enabled: false };
    },

    /** New set of ten backup codes; the old ones stop working. */
    async regenerateBackupCodes(userId: number, input: { currentPassword: unknown; code: string | null }) {
      await assertCurrentPassword(userId, input.currentPassword);
      const key = `totp:${userId}`;
      assertAttemptAllowed(key);
      if (!checkSecondFactor(userId, input.code, null)) {
        failAttempt(key, 'Код не подошёл.', 'AUTH_INVALID_2FA_CODE', 400);
      }
      store.clearThrottle(key);
      const backupCodes = generateBackupCodes();
      store.updateUserSecurity(userId, { backup_codes: JSON.stringify(backupCodes.map(hashBackupCode)) });
      return { backupCodes };
    },

    /**
     * Б11: changes the password and signs every other device out. The caller
     * keeps working with the returned token (same sign-in when it had one).
     */
    async changePassword(input: {
      userId: number;
      currentSessionId: string | null;
      currentPassword: unknown;
      newPassword: unknown;
      context: ClientContext;
    }): Promise<{ success: true; token: string; revokedSessions: number }> {
      const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';
      if (newPassword.length < MIN_NEW_PASSWORD_LENGTH) {
        throw new AppError(`Новый пароль — от ${MIN_NEW_PASSWORD_LENGTH} символов.`, {
          code: 'AUTH_PASSWORD_TOO_SHORT',
          statusCode: 400,
        });
      }
      if (Buffer.byteLength(newPassword, 'utf8') > MAX_PASSWORD_BYTES) {
        throw new AppError('Новый пароль слишком длинный: не больше 72 байт (≈36 русских или 72 латинских символа).', {
          code: 'AUTH_PASSWORD_TOO_LONG',
          statusCode: 400,
        });
      }
      await assertCurrentPassword(input.userId, input.currentPassword);
      if (newPassword === input.currentPassword) {
        throw new AppError('Новый пароль совпадает с текущим.', { code: 'AUTH_PASSWORD_UNCHANGED', statusCode: 400 });
      }
      const user = requireUser(input.userId);
      const passwordHash = await dependencies.hashPassword(newPassword);
      dependencies.users.updatePasswordHash(input.userId, passwordHash);

      const nowMs = dependencies.now();
      store.updateUserSecurity(input.userId, {
        tokens_valid_after: Math.floor(nowMs / 1000),
        password_changed_at: toIso(nowMs),
      });
      const keep = input.currentSessionId && store.getSession(input.currentSessionId)?.revoked_at === null
        ? input.currentSessionId
        : null;
      const revokedSessions = store.revokeOtherSessions(input.userId, keep);
      const token = keep ? dependencies.signToken(user, keep) : issueSession(user, input.context).token;
      return { success: true, token, revokedSessions };
    },

    listSessions(userId: number, currentSessionId: string | null): AuthSessionView[] {
      const since = toIso(dependencies.now() - SESSION_IDLE_LIMIT_MS);
      return store.listActiveSessions(userId, since).map((row) => toSessionView(row, currentSessionId));
    },

    revokeSession(userId: number, sessionId: string, currentSessionId: string | null): { revoked: true } {
      if (sessionId === currentSessionId) {
        throw new AppError('Это текущее устройство — для него есть «Выйти».', {
          code: 'AUTH_SESSION_IS_CURRENT',
          statusCode: 409,
        });
      }
      if (!store.revokeSession(userId, sessionId)) {
        throw new AppError('Такого входа нет или он уже завершён.', { code: 'AUTH_SESSION_NOT_FOUND', statusCode: 404 });
      }
      return { revoked: true };
    },

    /**
     * «Выйти везде, кроме этого»: revokes listed sign-ins and voids older
     * tokens (including ones from before sign-ins were tracked); the caller
     * gets a fresh token for its own sign-in.
     */
    revokeOtherSessions(userId: number, currentSessionId: string | null, context: ClientContext) {
      const user = requireUser(userId);
      const keep = currentSessionId && store.getSession(currentSessionId)?.revoked_at === null ? currentSessionId : null;
      const revoked = store.revokeOtherSessions(userId, keep);
      store.updateUserSecurity(userId, { tokens_valid_after: Math.floor(dependencies.now() / 1000) });
      const token = keep ? dependencies.signToken(user, keep) : issueSession(user, context).token;
      return { revoked, token };
    },

    /** Logout: ends the caller's own sign-in. */
    revokeCurrentSession(userId: number, currentSessionId: string | null): void {
      if (currentSessionId) {
        store.revokeSession(userId, currentSessionId);
      }
    },

    listTrustedDevices(userId: number): AuthTrustedDeviceView[] {
      return store.listTrustedDevices(userId, toIso(dependencies.now())).map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
      }));
    },

    removeTrustedDevice(userId: number, deviceId: string): { removed: true } {
      if (!store.removeTrustedDevice(userId, deviceId)) {
        throw new AppError('Устройство не найдено.', { code: 'AUTH_DEVICE_NOT_FOUND', statusCode: 404 });
      }
      return { removed: true };
    },
  };
}
