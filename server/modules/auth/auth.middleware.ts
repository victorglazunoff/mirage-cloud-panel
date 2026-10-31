// @ts-nocheck -- JWT request augmentation is narrowed by Auth route contracts.
import { createHmac } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { IS_PLATFORM } from '@/shared/utils.js';

import { userDb, appConfigDb } from '../database/index.js';

import { isTokenSessionActive } from './services/auth-security.service.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Mirage (Х9): the 2FA challenge is signed with a key derived from the JWT
// secret, so a challenge can never pass as a session token and vice versa.
const CHALLENGE_SECRET = createHmac('sha256', JWT_SECRET).update('mirage-2fa-challenge').digest('hex');
const CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * Mirage (Б11, Х9): whether a verified token still stands — not voided by a
 * password change or «выйти везде», and its sign-in (`sid`) not revoked.
 * Purpose-scoped tokens (challenges) are never session tokens.
 */
const isSessionTokenUsable = (decoded) => {
  if (!decoded || typeof decoded !== 'object' || decoded.purpose) {
    return false;
  }
  try {
    return isTokenSessionActive(
      { userId: Number(decoded.userId), iat: decoded.iat, sid: typeof decoded.sid === 'string' ? decoded.sid : undefined },
      Date.now(),
    );
  } catch (error) {
    // A database hiccup must not lock everyone out; the JWT itself is valid.
    console.warn('Session check failed:', error instanceof Error ? error.message : String(error));
    return true;
  }
};

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode:  use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_INVALID',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!isSessionTokenUsable(decoded)) {
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'This sign-in was ended. Please log in again.',
        code: 'AUTH_SESSION_REVOKED',
      });
    }

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. User not found.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user, decoded.sid);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    // Mirage: the sign-in this token belongs to (null for pre-Mirage tokens).
    req.authSessionId = typeof decoded.sid === 'string' ? decoded.sid : null;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }

    console.warn(
      'Token verification failed:',
      error instanceof Error ? error.message : String(error),
    );
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
};

// Generate JWT token. Mirage: `sessionId` ties it to an `auth_sessions` row.
const generateToken = (user: { id: number | bigint; username: string }, sessionId?: string | null): string => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      ...(sessionId ? { sid: sessionId } : {}),
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// Mirage (Х9): five-minute token linking the password step to the code step.
const signTwoFactorChallenge = ({ userId, nonce }) => jwt.sign(
  { purpose: '2fa', userId, nonce },
  CHALLENGE_SECRET,
  { expiresIn: CHALLENGE_TTL_SECONDS },
);

const verifyTwoFactorChallenge = (token) => {
  try {
    const decoded = jwt.verify(String(token ?? ''), CHALLENGE_SECRET);
    if (decoded?.purpose !== '2fa' || !Number.isInteger(decoded.userId) || typeof decoded.nonce !== 'string') {
      return null;
    }
    return { userId: decoded.userId, nonce: decoded.nonce, expMs: decoded.exp * 1000 };
  } catch {
    return null;
  }
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!isSessionTokenUsable(decoded)) {
      return null;
    }
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError)) {
      console.warn(
        'WebSocket token verification failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
};

/**
 * Mirage (Б11): whether the token an open WebSocket was authenticated with is
 * still honoured. The websocket gateway re-checks it periodically, so «выйти
 * везде», a password change or a revoked sign-in also ends sockets opened
 * before it. Expiry alone does not end a socket (it outliving the token's
 * 7 days is not a revocation); the next connect checks expiry as usual.
 */
const isWebSocketTokenActive = (token) => {
  if (IS_PLATFORM) {
    return true;
  }
  try {
    const decoded = jwt.verify(String(token ?? ''), JWT_SECRET, { ignoreExpiration: true });
    return isSessionTokenUsable(decoded) && Boolean(userDb.getUserById(decoded.userId));
  } catch {
    return false;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  signTwoFactorChallenge,
  verifyTwoFactorChallenge,
  authenticateWebSocket,
  isWebSocketTokenActive,
  JWT_SECRET
};
