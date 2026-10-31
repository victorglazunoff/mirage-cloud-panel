import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseTrustProxy, readClientContext } from '@/modules/auth/auth.routes.js';
import { createAuthService } from '@/modules/auth/auth.service.js';
import {
  createAuthSecurityService,
  describeUserAgent,
  isTokenSessionActive,
} from '@/modules/auth/services/auth-security.service.js';
import {
  buildOtpauthUri,
  findBackupCodeIndex,
  generateTotpCode,
  hashBackupCode,
  verifyTotpCode,
} from '@/modules/auth/services/totp.service.js';
import { authSecurityDb, closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import type { AuthAttemptDetails } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
const CONTEXT = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit Chrome/130.0 Safari/537.36', ipAddress: '203.0.113.5' };

test('TOTP matches the RFC 6238 vectors and accepts one step of drift', () => {
  assert.equal(generateTotpCode(RFC_SECRET, 59_000), '287082');
  assert.equal(generateTotpCode(RFC_SECRET, 1_111_111_109_000), '081804');
  assert.equal(verifyTotpCode(RFC_SECRET, '287082', 59_000), 1);
  assert.equal(verifyTotpCode(RFC_SECRET, '287082', 89_000), 1);
  assert.equal(verifyTotpCode(RFC_SECRET, '287082', 150_000), null);
  assert.equal(verifyTotpCode(RFC_SECRET, '28708', 59_000), null);
  assert.match(buildOtpauthUri(RFC_SECRET, 'alice'), /^otpauth:\/\/totp\/Mirage%3Aalice\?secret=GEZ/);
});

test('backup codes are matched by hash, case and dashes ignored', () => {
  const hashes = [hashBackupCode('7F3K-Q9PD'), hashBackupCode('AAAA-BBBB')];
  assert.equal(findBackupCodeIndex(hashes, '7f3kq9pd'), 0);
  assert.equal(findBackupCodeIndex(hashes, 'aaaa bbbb'), 1);
  assert.equal(findBackupCodeIndex(hashes, 'ZZZZ-ZZZZ'), -1);
});

test('user agents become readable device labels', () => {
  assert.deepEqual(describeUserAgent(CONTEXT.userAgent), { label: 'Mac · Chrome', kind: 'laptop' });
  assert.deepEqual(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1'), { label: 'iPhone · Safari', kind: 'phone' });
  assert.equal(describeUserAgent(null).label, 'Неизвестное устройство');
});

test('the client address comes from the proxy header only behind loopback', () => {
  const viaProxy = readClientContext({
    headers: { 'user-agent': 'UA', 'x-forwarded-for': '198.51.100.7' },
    socket: { remoteAddress: '127.0.0.1' },
  } as never);
  assert.deepEqual(viaProxy, { userAgent: 'UA', ipAddress: '198.51.100.7' });
  // A client-forged entry ahead of the one our proxy wrote is ignored.
  const forged = readClientContext({
    headers: { 'x-forwarded-for': '10.9.9.9, 198.51.100.7' },
    socket: { remoteAddress: '::ffff:127.0.0.1' },
  } as never);
  assert.equal(forged.ipAddress, '198.51.100.7');
  const direct = readClientContext({
    headers: { 'x-forwarded-for': '198.51.100.7' },
    socket: { remoteAddress: '203.0.113.9' },
  } as never);
  assert.equal(direct.ipAddress, '203.0.113.9');
});

test('TRUST_PROXY: a proxy on another host, a list of proxies, or no proxy at all', () => {
  const request = (remoteAddress: string, forwardedFor: string) =>
    ({ headers: { 'x-forwarded-for': forwardedFor }, socket: { remoteAddress } }) as never;

  // Unset or `loopback`: only a proxy on this machine is believed.
  assert.deepEqual(parseTrustProxy(undefined), { mode: 'loopback' });
  assert.deepEqual(parseTrustProxy(' Loopback '), { mode: 'loopback' });
  assert.equal(readClientContext(request('10.0.0.5', '198.51.100.7'), parseTrustProxy('')).ipAddress, '10.0.0.5');

  // `true`: any peer is a proxy; the entry it wrote (the last one) is the client.
  const all = parseTrustProxy('true');
  assert.deepEqual(all, { mode: 'all' });
  assert.equal(readClientContext(request('10.0.0.5', '10.9.9.9, 198.51.100.7'), all).ipAddress, '198.51.100.7');

  // `false`: the header is ignored even from loopback.
  const none = parseTrustProxy('none');
  assert.equal(readClientContext(request('127.0.0.1', '198.51.100.7'), none).ipAddress, '127.0.0.1');

  // A list (addresses and CIDR): hops through listed proxies are skipped from the right.
  const list = parseTrustProxy('10.0.0.0/24, 192.0.2.10 not-an-ip 2001:db8::/32');
  assert.equal(list.mode, 'list');
  assert.equal(readClientContext(request('::ffff:10.0.0.5', '10.9.9.9, 198.51.100.7, 192.0.2.10'), list).ipAddress, '198.51.100.7');
  assert.equal(readClientContext(request('2001:db8::1', '203.0.113.4'), list).ipAddress, '203.0.113.4');
  // A peer outside the list cannot forge an address; loopback stays trusted.
  assert.equal(readClientContext(request('203.0.113.9', '198.51.100.7'), list).ipAddress, '203.0.113.9');
  assert.equal(readClientContext(request('127.0.0.1', '198.51.100.7'), list).ipAddress, '198.51.100.7');
  // Every hop is one of ours: the leftmost one is the best guess.
  assert.equal(readClientContext(request('10.0.0.5', '10.0.0.7, 192.0.2.10'), list).ipAddress, '10.0.0.7');
});

type Harness = {
  userId: number;
  clock: { now: number };
  passwords: Map<number, string>;
  security: ReturnType<typeof createAuthSecurityService>;
  auth: ReturnType<typeof createAuthService>;
  signed: Array<{ userId: number; sessionId: string | null }>;
};

async function withSecurity(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'auth-security-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const userId = Number(userDb.createUser('alice', 'hash:correct horse battery').id);
    const clock = { now: Date.parse('2026-10-26T09:00:00Z') };
    const passwords = new Map<number, string>([[userId, 'hash:correct horse battery']]);
    const signed: Harness['signed'] = [];
    const challenges = new Map<string, { userId: number; nonce: string; expMs: number }>();
    const security = createAuthSecurityService({
      now: () => clock.now,
      store: authSecurityDb,
      users: {
        getUserById: (id) => (id === userId ? { id, username: 'alice' } : undefined),
        getPasswordHashById: (id) => passwords.get(id),
        updatePasswordHash: (id, hash) => {
          passwords.set(id, hash);
          return true;
        },
      },
      hashPassword: async (password) => `hash:${password}`,
      comparePassword: async (password, hash) => hash === `hash:${password}`,
      signToken: (user, sessionId) => {
        signed.push({ userId: Number(user.id), sessionId });
        return `token:${sessionId}`;
      },
      signChallenge: (payload) => {
        const token = `challenge:${payload.nonce}`;
        challenges.set(token, { ...payload, expMs: clock.now + 300_000 });
        return token;
      },
      verifyChallenge: (token) => {
        const challenge = challenges.get(token);
        return challenge && challenge.expMs > clock.now ? challenge : null;
      },
    });
    const auth = createAuthService({
      users: {
        hasUsers: () => true,
        createUser: () => {
          throw new Error('not used');
        },
        getUserByUsername: (username) => (username === 'alice'
          ? { id: userId, username, password_hash: passwords.get(userId) ?? '' }
          : undefined),
        updateLastLogin: () => undefined,
      },
      transaction: { begin: () => undefined, commit: () => undefined, rollback: () => undefined },
      hashPassword: async (password) => `hash:${password}`,
      comparePassword: async (password, hash) => hash === `hash:${password}`,
      generateToken: () => 'legacy-token',
      security,
    });
    await runTest({ userId, clock, passwords, security, auth, signed });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return error;
  }
  throw new Error('expected a rejection');
}

test('five wrong passwords lock the login for fifteen minutes with attempts left reported', async () => {
  await withSecurity(async ({ auth, clock }) => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const error = await rejection(auth.login('alice', 'wrong', CONTEXT));
      assert.equal(error.code, 'AUTH_INVALID_CREDENTIALS');
      assert.equal(error.message, 'Логин или пароль не подходят');
      assert.equal((error.details as AuthAttemptDetails).attemptsLeft, 5 - attempt);
    }
    const locked = await rejection(auth.login('alice', 'wrong', CONTEXT));
    assert.equal(locked.code, 'AUTH_LOCKED');
    assert.equal(locked.statusCode, 429);
    assert.equal((locked.details as AuthAttemptDetails).retryAfterSec, 900);

    // Even the right password waits out the lock.
    const stillLocked = await rejection(auth.login('alice', 'correct horse battery', CONTEXT));
    assert.equal(stillLocked.code, 'AUTH_LOCKED');

    clock.now += 15 * 60_000 + 1;
    const result = await auth.login('alice', 'correct horse battery', CONTEXT);
    assert.equal(result.twoFactorRequired ?? false, false);

    // A success resets the counter; unknown users are throttled under their own key.
    const unknown = await rejection(auth.login('nobody', 'x', CONTEXT));
    assert.equal((unknown.details as AuthAttemptDetails).attemptsLeft, 4);
  });
});

test('the lock holds only for the address that guessed: the owner signs in from another one', async () => {
  await withSecurity(async ({ auth }) => {
    const attacker = { ...CONTEXT, ipAddress: '198.51.100.66' };
    const owner = { ...CONTEXT, ipAddress: '203.0.113.5' };

    // A success resets the counter of the address it came from.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await rejection(auth.login('alice', 'wrong', attacker));
    }
    await auth.login('alice', 'correct horse battery', attacker);
    const afterReset = await rejection(auth.login('alice', 'wrong', attacker));
    assert.equal((afterReset.details as AuthAttemptDetails).attemptsLeft, 4);

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await rejection(auth.login('alice', 'wrong', attacker));
    }
    const locked = await rejection(auth.login('ALICE', 'wrong', attacker));
    assert.equal(locked.code, 'AUTH_LOCKED');
    const attackerWithRightPassword = await rejection(auth.login('alice', 'correct horse battery', attacker));
    assert.equal(attackerWithRightPassword.code, 'AUTH_LOCKED');

    // The owner on another address is not locked out and keeps a full count.
    const ownerTypo = await rejection(auth.login('alice', 'wrong', owner));
    assert.equal(ownerTypo.code, 'AUTH_INVALID_CREDENTIALS');
    assert.equal((ownerTypo.details as AuthAttemptDetails).attemptsLeft, 4);
    const result = await auth.login('alice', 'correct horse battery', owner);
    assert.equal(result.success, true);

    // Unknown address is throttled too (under its own key).
    const anonymous = await rejection(auth.login('alice', 'wrong', { ...CONTEXT, ipAddress: null }));
    assert.equal((anonymous.details as AuthAttemptDetails).attemptsLeft, 4);
  });
});

test('logins create sign-ins that can be listed, revoked and voided', async () => {
  await withSecurity(async ({ userId, auth, security, clock }) => {
    const first = await auth.login('alice', 'correct horse battery', CONTEXT);
    const second = await auth.login('alice', 'correct horse battery', { userAgent: 'Mozilla/5.0 (iPhone) Mobile Safari/604.1', ipAddress: null });
    assert.ok('token' in first && 'token' in second);
    const firstSessionId = first.token.replace('token:', '');
    const secondSessionId = second.token.replace('token:', '');

    const sessions = security.listSessions(userId, firstSessionId);
    assert.equal(sessions.length, 2);
    assert.equal(sessions.find((session) => session.current)?.deviceLabel, 'Mac · Chrome');

    const nowSec = Math.floor(clock.now / 1000);
    assert.equal(isTokenSessionActive({ userId, iat: nowSec, sid: secondSessionId }, clock.now), true);
    security.revokeSession(userId, secondSessionId, firstSessionId);
    assert.equal(isTokenSessionActive({ userId, iat: nowSec, sid: secondSessionId }, clock.now), false);
    assert.throws(() => security.revokeSession(userId, firstSessionId, firstSessionId), AppError);

    // A pre-Mirage token (no sid) works until «выйти везде» voids it.
    assert.equal(isTokenSessionActive({ userId, iat: nowSec - 10 }, clock.now), true);
    const { token } = security.revokeOtherSessions(userId, firstSessionId, CONTEXT);
    assert.equal(token, `token:${firstSessionId}`);
    assert.equal(isTokenSessionActive({ userId, iat: nowSec - 3600 }, clock.now), false);

    // Idle for more than 30 days: the sign-in no longer counts.
    assert.equal(isTokenSessionActive({ userId, iat: Math.floor(clock.now / 1000) + 1, sid: firstSessionId }, clock.now + 31 * 24 * 3600_000), false);

    security.revokeCurrentSession(userId, firstSessionId);
    assert.equal(security.listSessions(userId, null).length, 0);
  });
});

test('password change checks the current password, enforces length and signs other devices out', async () => {
  await withSecurity(async ({ userId, auth, security, passwords }) => {
    const mine = await auth.login('alice', 'correct horse battery', CONTEXT);
    const other = await auth.login('alice', 'correct horse battery', CONTEXT);
    assert.ok('token' in mine && 'token' in other);
    const mySessionId = mine.token.replace('token:', '');

    const tooShort = await rejection(security.changePassword({
      userId, currentSessionId: mySessionId, currentPassword: 'correct horse battery', newPassword: 'short', context: CONTEXT,
    }));
    assert.equal(tooShort.code, 'AUTH_PASSWORD_TOO_SHORT');

    const wrong = await rejection(security.changePassword({
      userId, currentSessionId: mySessionId, currentPassword: 'nope', newPassword: 'a much longer password', context: CONTEXT,
    }));
    assert.equal(wrong.code, 'AUTH_WRONG_PASSWORD');
    assert.equal(wrong.statusCode, 403);
    assert.equal((wrong.details as AuthAttemptDetails).attemptsLeft, 4);

    const result = await security.changePassword({
      userId, currentSessionId: mySessionId, currentPassword: 'correct horse battery', newPassword: 'a much longer password', context: CONTEXT,
    });
    assert.equal(result.revokedSessions, 1);
    assert.equal(result.token, `token:${mySessionId}`);
    assert.equal(passwords.get(userId), 'hash:a much longer password');
    assert.deepEqual(security.listSessions(userId, mySessionId).map((session) => session.id), [mySessionId]);
    assert.ok(authSecurityDb.getUserSecurity(userId)?.tokens_valid_after);

    const oldPassword = await rejection(auth.login('alice', 'correct horse battery', CONTEXT));
    assert.equal(oldPassword.code, 'AUTH_INVALID_CREDENTIALS');
  });
});

test('TOTP: setup, enable with backup codes, login challenge, replay guard, remembered device, disable', async () => {
  await withSecurity(async ({ userId, auth, security, clock }) => {
    await assert.rejects(security.beginTwoFactorSetup(userId, 'wrong'), AppError);
    const setup = await security.beginTwoFactorSetup(userId, 'correct horse battery');
    assert.match(setup.otpauthUri, /^otpauth:\/\/totp\//);
    assert.equal(security.getTwoFactorStatus(userId).pendingSetup, true);

    assert.throws(() => security.enableTwoFactor(userId, '000000'), AppError);
    const enabled = security.enableTwoFactor(userId, generateTotpCode(setup.secret, clock.now));
    assert.equal(enabled.backupCodes.length, 10);
    assert.match(enabled.backupCodes[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const stored = authSecurityDb.getUserSecurity(userId);
    assert.ok(stored && !stored.backup_codes.includes(enabled.backupCodes[0]), 'only hashes are stored');
    assert.deepEqual(security.getTwoFactorStatus(userId), {
      enabled: true, enabledAt: stored?.totp_enabled_at ?? null, pendingSetup: false, backupCodesLeft: 10, trustedDevices: 0,
    });

    // Password step now returns a challenge, not a token.
    const step1 = await auth.login('alice', 'correct horse battery', CONTEXT);
    assert.equal(step1.twoFactorRequired, true);
    assert.ok('challengeToken' in step1);

    // The code used to enable is already spent within its window.
    const replay = (() => {
      try {
        security.completeTwoFactorLogin({ challengeToken: step1.challengeToken, code: generateTotpCode(setup.secret, clock.now), backupCode: null, rememberDevice: false, context: CONTEXT });
      } catch (error) {
        return error as AppError;
      }
      return null;
    })();
    assert.equal(replay?.code, 'AUTH_INVALID_2FA_CODE');
    assert.equal((replay?.details as AuthAttemptDetails | undefined)?.attemptsLeft, 4);

    clock.now += 30_000;
    const step2 = security.completeTwoFactorLogin({
      challengeToken: step1.challengeToken, code: generateTotpCode(setup.secret, clock.now), backupCode: null, rememberDevice: true, context: CONTEXT,
    });
    assert.ok('token' in step2 && step2.trustedDevice);
    // A challenge is single-use.
    assert.throws(() => security.completeTwoFactorLogin({
      challengeToken: step1.challengeToken, code: null, backupCode: enabled.backupCodes[0], rememberDevice: false, context: CONTEXT,
    }), (error: unknown) => error instanceof AppError && error.code === 'AUTH_2FA_CHALLENGE_EXPIRED');

    // The remembered device skips the code step for 30 days.
    const remembered = await auth.login('alice', 'correct horse battery', { ...CONTEXT, deviceToken: step2.trustedDevice.deviceToken });
    assert.ok('token' in remembered);
    clock.now += 31 * 24 * 3600_000;
    const expired = await auth.login('alice', 'correct horse battery', { ...CONTEXT, deviceToken: step2.trustedDevice.deviceToken });
    assert.equal(expired.twoFactorRequired, true);

    // A backup code works once.
    assert.ok('challengeToken' in expired);
    const viaBackup = security.completeTwoFactorLogin({
      challengeToken: expired.challengeToken, code: null, backupCode: enabled.backupCodes[0].toLowerCase(), rememberDevice: false, context: CONTEXT,
    });
    assert.ok('token' in viaBackup);
    assert.equal(security.getTwoFactorStatus(userId).backupCodesLeft, 9);

    await assert.rejects(security.disableTwoFactor(userId, { currentPassword: 'correct horse battery', code: '000000', backupCode: null }), AppError);
    clock.now += 30_000;
    await security.disableTwoFactor(userId, { currentPassword: 'correct horse battery', code: generateTotpCode(setup.secret, clock.now), backupCode: null });
    assert.equal(security.getTwoFactorStatus(userId).enabled, false);
    const plain = await auth.login('alice', 'correct horse battery', CONTEXT);
    assert.ok('token' in plain);
  });
});
