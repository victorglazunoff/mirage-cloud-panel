import type { AuthLoginResult } from '@/shared/types.js';
import { AppError, getPanelTimeZone, getPanelTimeZoneLabel } from '@/shared/utils.js';

import type { createAuthSecurityService } from './services/auth-security.service.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser, sessionId?: string | null): string;
  /**
   * Mirage (Б11, Х9): attempt throttling, tracked sign-ins and the TOTP step.
   * Optional so the upstream behaviour (and its tests) stay intact without it.
   */
  security?: ReturnType<typeof createAuthSecurityService>;
};

/** Who is signing in; recorded for «Активные входы». */
type LoginContext = {
  userAgent: string | null;
  ipAddress: string | null;
  /** Token of a device remembered for 30 days, to skip the code step. */
  deviceToken?: string | null;
};

// A valid bcrypt hash of a random string: comparing against it when the user
// does not exist keeps the response time the same, so the timing does not
// tell which usernames exist.
const DUMMY_PASSWORD_HASH = '$2b$12$1y5P8Z2tjAwmO/o9YlXxeeQIcx586h3/SHJAtHH0SiR62rXF3aKu6';

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
        // Mirage: the sign-in screen's «сверка часов» — the client compares it with
        // its own clock (TOTP codes fail when the two drift apart).
        serverTime: Date.now(),
        // Mirage: the zone every Kabina clock and time is shown in (MIRAGE_TIMEZONE,
        // else the server's own zone) and its caption (MIRAGE_TIMEZONE_LABEL, null when unset).
        timeZone: getPanelTimeZone(),
        timeZoneLabel: getPanelTimeZoneLabel(),
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown, context: LoginContext = { userAgent: null, ipAddress: null }) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.security
          ? dependencies.security.issueSession(user, context).token
          : dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(
      usernameInput: unknown,
      passwordInput: unknown,
      context: LoginContext = { userAgent: null, ipAddress: null },
    ): Promise<AuthLoginResult> {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      // Mirage: five wrong passwords lock this username for fifteen minutes —
      // only for the address that guessed, so the owner elsewhere still gets in.
      const throttleKey = `login:${username.trim().toLowerCase()}:${context.ipAddress ?? 'unknown'}`;
      dependencies.security?.assertAttemptAllowed(throttleKey);

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : await dependencies.comparePassword(password, DUMMY_PASSWORD_HASH).then(() => false);
      if (!user || !validPassword) {
        if (dependencies.security) {
          dependencies.security.failAttempt(throttleKey, 'Логин или пароль не подходят', 'AUTH_INVALID_CREDENTIALS', 401);
        }
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      if (dependencies.security) {
        dependencies.security.clearAttempts(throttleKey);
        return dependencies.security.completePasswordLogin(user, context, context.deviceToken ?? null);
      }
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown, sessionId: string | null = null) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      // Mirage: a refreshed token stays on the same sign-in.
      return { token: dependencies.generateToken(user as AuthUser, sessionId) };
    },

    logout(user: unknown = null, sessionId: string | null = null) {
      const userId = typeof user === 'object' && user !== null && 'id' in user ? Number(user.id) : Number.NaN;
      if (dependencies.security && Number.isInteger(userId)) {
        dependencies.security.revokeCurrentSession(userId, sessionId);
      }
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
