import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A fixed secret keeps the middleware from reading app_config at import time,
// and a throwaway database path guarantees no real database is ever opened.
process.env.JWT_SECRET = 'test-secret-for-token-separation';
process.env.DATABASE_PATH = path.join(tmpdir(), `auth-middleware-tokens-${process.pid}.db`);
const {
  authenticateWebSocket,
  generateToken,
  isWebSocketTokenActive,
  signTwoFactorChallenge,
  verifyTwoFactorChallenge,
} = await import('@/modules/auth/auth.middleware.js');

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

test('session tokens carry the sign-in id when one is given', () => {
  const decoded = decodePayload(generateToken({ id: 1, username: 'alice' }, 'session-1'));
  assert.equal(decoded.sid, 'session-1');
  const legacy = decodePayload(generateToken({ id: 1, username: 'alice' }));
  assert.equal('sid' in legacy, false);
});

test('a 2FA challenge never passes as a session token and vice versa', () => {
  const challenge = signTwoFactorChallenge({ userId: 1, nonce: 'n-1' });
  assert.deepEqual(
    { userId: verifyTwoFactorChallenge(challenge)?.userId, nonce: verifyTwoFactorChallenge(challenge)?.nonce },
    { userId: 1, nonce: 'n-1' },
  );
  assert.equal(authenticateWebSocket(challenge), null);
  assert.equal(decodePayload(challenge).purpose, '2fa');

  const session = generateToken({ id: 1, username: 'alice' }, 'session-1');
  assert.equal(verifyTwoFactorChallenge(session), null);
  assert.equal(verifyTwoFactorChallenge('garbage'), null);
});

test('an open socket is never kept on a challenge, a foreign or a garbage token', () => {
  assert.equal(isWebSocketTokenActive(signTwoFactorChallenge({ userId: 1, nonce: 'n-2' })), false);
  const [header, payload] = generateToken({ id: 1, username: 'alice' }, 'session-1').split('.');
  assert.equal(isWebSocketTokenActive(`${header}.${payload}.forged-signature`), false);
  assert.equal(isWebSocketTokenActive('garbage'), false);
  assert.equal(isWebSocketTokenActive(''), false);
});
