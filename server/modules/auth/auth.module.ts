import { createRequire } from 'node:module';

import { authSecurityDb, getConnection, userDb } from '@/modules/database/index.js';

import {
  authenticateToken,
  generateToken,
  signTwoFactorChallenge,
  verifyTwoFactorChallenge,
} from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createAuthSecurityService } from './services/auth-security.service.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
const databaseConnection = getConnection();

// Mirage (Б11, Х9): throttling, tracked sign-ins, TOTP, password change.
const authSecurityService = createAuthSecurityService({
  now: () => Date.now(),
  store: authSecurityDb,
  users: {
    getUserById: (userId) => userDb.getUserById(userId),
    getPasswordHashById: (userId) => userDb.getPasswordHashById(userId),
    updatePasswordHash: (userId, passwordHash) => userDb.updatePasswordHash(userId, passwordHash),
  },
  hashPassword: (password) => bcrypt.hash(password, 12),
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  signToken: (user, sessionId) => generateToken(user, sessionId),
  signChallenge: (payload) => signTwoFactorChallenge(payload),
  verifyChallenge: (token) => verifyTwoFactorChallenge(token),
});

const authService = createAuthService({
  users: {
    hasUsers: () => userDb.hasUsers(),
    createUser: (username, passwordHash) => userDb.createUser(username, passwordHash),
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
  },
  transaction: {
    begin: () => databaseConnection.prepare('BEGIN').run(),
    commit: () => databaseConnection.prepare('COMMIT').run(),
    rollback: () => databaseConnection.prepare('ROLLBACK').run(),
  },
  hashPassword: (password) => bcrypt.hash(password, 12),
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
  security: authSecurityService,
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken, authSecurityService);
