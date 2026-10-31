import { BlockList, isIP } from 'node:net';

import express from 'express';
import type { RequestHandler } from 'express';

import { AppError } from '@/shared/utils.js';

import type { createAuthService } from './auth.service.js';
import type { createAuthSecurityService } from './services/auth-security.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown; authSessionId?: string | null };

function readBody(req: express.Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Which peers may tell the client address through X-Forwarded-For (`TRUST_PROXY`):
 * `loopback` (unset — a proxy on the same machine), `all` (any peer — only when
 * the panel port is reachable from the proxy alone), `none` (never), or a list of
 * proxy addresses / CIDR ranges (loopback stays trusted).
 */
type TrustProxyRule =
  | { mode: 'loopback' | 'all' | 'none' }
  | { mode: 'list'; proxies: BlockList };

const LOOPBACK_PATTERN = /^(::1|127\.)/;

/** `::ffff:203.0.113.9` → `203.0.113.9`, so IPv4 peers on a dual-stack socket match IPv4 rules. */
function normalizeAddress(address: string): string {
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

/**
 * Parses `TRUST_PROXY`: unset/`loopback`; `true`/`1`/`all`; `false`/`0`/`none`;
 * otherwise addresses and CIDR ranges separated by commas or spaces (entries that
 * are neither are skipped). Exported for the auth tests.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxyRule {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value === 'loopback') return { mode: 'loopback' };
  if (['1', 'true', 'yes', 'on', 'all'].includes(value)) return { mode: 'all' };
  if (['0', 'false', 'no', 'off', 'none'].includes(value)) return { mode: 'none' };
  const proxies = new BlockList();
  for (const entry of value.split(/[\s,]+/).filter(Boolean)) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address);
    if (!family) continue;
    const type = family === 4 ? 'ipv4' : 'ipv6';
    const bits = prefix === undefined ? null : Number(prefix);
    if (bits === null) proxies.addAddress(address, type);
    else if (Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128)) proxies.addSubnet(address, bits, type);
  }
  return { mode: 'list', proxies };
}

let envTrustRule: TrustProxyRule | null = null;

/** The rule from the server's environment, parsed once (after `.env` is loaded). */
function trustRuleFromEnv(): TrustProxyRule {
  envTrustRule ??= parseTrustProxy(process.env.TRUST_PROXY);
  return envTrustRule;
}

function isTrustedPeer(address: string, rule: TrustProxyRule): boolean {
  if (rule.mode === 'none') return false;
  if (rule.mode === 'all' || LOOPBACK_PATTERN.test(address)) return true;
  if (rule.mode !== 'list') return false;
  const family = isIP(address);
  return family !== 0 && rule.proxies.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Who is calling: for the sign-in list and the per-address sign-in lock.
 * The forwarded address is used only when the socket peer is a trusted proxy
 * (`TRUST_PROXY`; by default a proxy on this machine, e.g. Caddy on loopback),
 * and it is read from the RIGHT: the entry the nearest proxy wrote. With a list
 * of proxies, hops through other listed proxies are skipped too. Entries a
 * client forged in front of those are never reached, so they stay useless.
 */
export function readClientContext(
  req: express.Request,
  rule: TrustProxyRule = trustRuleFromEnv(),
): { userAgent: string | null; ipAddress: string | null } {
  const rawSocketAddress = req.socket?.remoteAddress ?? null;
  const socketAddress = rawSocketAddress ? normalizeAddress(rawSocketAddress) : null;
  const userAgent = optionalString(req.headers['user-agent']);
  // No socket address at all happens only in tests and in-process calls: treat it as local.
  if (socketAddress && !isTrustedPeer(socketAddress, rule)) return { userAgent, ipAddress: rawSocketAddress };
  if (!socketAddress && rule.mode === 'none') return { userAgent, ipAddress: null };

  const forwarded = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeAddress);
  if (!hops.length) return { userAgent, ipAddress: rawSocketAddress };
  if (rule.mode !== 'list') return { userAgent, ipAddress: hops[hops.length - 1] };
  // Walk back past our own proxies; the first address that is not one of them is the client.
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    if (!isTrustedPeer(hops[index], rule)) return { userAgent, ipAddress: hops[index] };
  }
  return { userAgent, ipAddress: hops[0] };
}

function readUserId(req: express.Request): number {
  const user = (req as AuthenticatedRequest).user as { id?: unknown } | undefined;
  const userId = Number(user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
  }
  return userId;
}

function readSessionId(req: express.Request): string | null {
  return (req as AuthenticatedRequest).authSessionId ?? null;
}

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application services.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
  security?: ReturnType<typeof createAuthSecurityService>,
): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>): RequestHandler =>
    async (req, res, next) => {
      try {
        res.json(await operation(req));
      } catch (error) {
        next(error);
      }
    };

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', respond((req) => {
    const body = readBody(req);
    return service.register(body.username, body.password, readClientContext(req));
  }));

  router.post('/login', respond((req) => {
    const body = readBody(req);
    return service.login(body.username, body.password, {
      ...readClientContext(req),
      deviceToken: optionalString(body.deviceToken),
    });
  }));

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user, readSessionId(req)));
  });

  router.post('/logout', authenticateToken, (req, res) => {
    res.json(service.logout((req as AuthenticatedRequest).user, readSessionId(req)));
  });

  if (!security) {
    return router;
  }

  // ----------------- Mirage: second factor, password, sign-ins -----------------

  // Step two of a login with TOTP on: `{ challengeToken, code | backupCode, rememberDevice }`.
  router.post('/login/2fa', respond((req) => {
    const body = readBody(req);
    return security.completeTwoFactorLogin({
      challengeToken: typeof body.challengeToken === 'string' ? body.challengeToken : '',
      code: optionalString(body.code),
      backupCode: optionalString(body.backupCode),
      rememberDevice: body.rememberDevice === true,
      context: readClientContext(req),
    });
  }));

  router.post('/change-password', authenticateToken, respond((req) => {
    const body = readBody(req);
    return security.changePassword({
      userId: readUserId(req),
      currentSessionId: readSessionId(req),
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      context: readClientContext(req),
    });
  }));

  router.get('/2fa/status', authenticateToken, respond((req) => security.getTwoFactorStatus(readUserId(req))));
  router.post('/2fa/setup', authenticateToken, respond((req) =>
    security.beginTwoFactorSetup(readUserId(req), readBody(req).currentPassword)));
  router.post('/2fa/enable', authenticateToken, respond((req) =>
    security.enableTwoFactor(readUserId(req), readBody(req).code)));
  router.post('/2fa/disable', authenticateToken, respond((req) => {
    const body = readBody(req);
    return security.disableTwoFactor(readUserId(req), {
      currentPassword: body.currentPassword,
      code: optionalString(body.code),
      backupCode: optionalString(body.backupCode),
    });
  }));
  router.post('/2fa/backup-codes', authenticateToken, respond((req) => {
    const body = readBody(req);
    return security.regenerateBackupCodes(readUserId(req), {
      currentPassword: body.currentPassword,
      code: optionalString(body.code),
    });
  }));

  router.get('/sessions', authenticateToken, respond((req) => ({
    sessions: security.listSessions(readUserId(req), readSessionId(req)),
  })));
  router.post('/sessions/revoke-others', authenticateToken, respond((req) =>
    security.revokeOtherSessions(readUserId(req), readSessionId(req), readClientContext(req))));
  router.delete('/sessions/:sessionId', authenticateToken, respond((req) =>
    security.revokeSession(readUserId(req), String(req.params.sessionId), readSessionId(req))));

  router.get('/trusted-devices', authenticateToken, respond((req) => ({
    devices: security.listTrustedDevices(readUserId(req)),
  })));
  router.delete('/trusted-devices/:deviceId', authenticateToken, respond((req) =>
    security.removeTrustedDevice(readUserId(req), String(req.params.deviceId))));

  return router;
}
