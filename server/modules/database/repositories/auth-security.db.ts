import { getConnection } from '@/modules/database/connection.js';

/** The user's sign-in security row (`user_security`). */
export type UserSecurityRow = {
  user_id: number;
  totp_secret: string | null;
  totp_enabled_at: string | null;
  totp_pending_secret: string | null;
  totp_pending_created_at: string | null;
  last_totp_step: number | null;
  backup_codes: string;
  tokens_valid_after: number | null;
  password_changed_at: string | null;
};

/** One sign-in (`auth_sessions`), referenced by the JWT `sid` claim. */
export type AuthSessionRow = {
  id: string;
  user_id: number;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

/** One remembered device (`auth_trusted_devices`). */
export type AuthTrustedDeviceRow = {
  id: string;
  user_id: number;
  token_hash: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
};

/** Failed-attempt counter for one throttle key (`auth_throttle`). */
export type AuthThrottleRow = {
  throttle_key: string;
  failed_count: number;
  window_started_at: number;
  locked_until: number | null;
};

type UserSecurityWritable = Partial<Omit<UserSecurityRow, 'user_id'>>;

const USER_SECURITY_COLUMNS: ReadonlyArray<keyof UserSecurityWritable> = [
  'totp_secret', 'totp_enabled_at', 'totp_pending_secret', 'totp_pending_created_at',
  'last_totp_step', 'backup_codes', 'tokens_valid_after', 'password_changed_at',
];

/**
 * Persistence of the Mirage sign-in security features. Used by the Auth
 * module (service and middleware) and by `mirage passwd` (CLI module); secrets
 * live here and nowhere else.
 */
export const authSecurityDb = {
  getUserSecurity(userId: number): UserSecurityRow | undefined {
    return getConnection()
      .prepare('SELECT * FROM user_security WHERE user_id = ?')
      .get(userId) as UserSecurityRow | undefined;
  },

  /** Upserts the given columns; columns left `undefined` keep their value. */
  updateUserSecurity(userId: number, fields: UserSecurityWritable): void {
    const db = getConnection();
    db.prepare('INSERT OR IGNORE INTO user_security (user_id) VALUES (?)').run(userId);
    const columns = USER_SECURITY_COLUMNS.filter((column) => fields[column] !== undefined);
    if (columns.length === 0) {
      return;
    }
    db.prepare(
      `UPDATE user_security SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE user_id = ?`,
    ).run(...columns.map((column) => fields[column] ?? null), userId);
  },

  /**
   * Accepts a TOTP time step only if it is newer than the last accepted one,
   * in one statement, so two concurrent logins cannot both use the same code.
   */
  claimTotpStep(userId: number, step: number): boolean {
    return getConnection()
      .prepare(
        `UPDATE user_security SET last_totp_step = ?
         WHERE user_id = ? AND (last_totp_step IS NULL OR last_totp_step < ?)`,
      )
      .run(step, userId, step).changes > 0;
  },

  /** Replaces the hash list only if it still equals `expectedJson` (single use under races). */
  consumeBackupCode(userId: number, expectedJson: string, nextJson: string): boolean {
    return getConnection()
      .prepare('UPDATE user_security SET backup_codes = ? WHERE user_id = ? AND backup_codes = ?')
      .run(nextJson, userId, expectedJson).changes > 0;
  },

  // Timestamps here are ISO strings (not CURRENT_TIMESTAMP) so they compare
  // correctly with the ISO cut-offs the service passes in.
  createSession(input: { id: string; userId: number; userAgent: string | null; ipAddress: string | null; nowIso: string }): void {
    getConnection()
      .prepare(
        `INSERT INTO auth_sessions (id, user_id, user_agent, ip_address, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.userId, input.userAgent, input.ipAddress, input.nowIso, input.nowIso);
  },

  getSession(id: string): AuthSessionRow | undefined {
    return getConnection()
      .prepare('SELECT * FROM auth_sessions WHERE id = ?')
      .get(id) as AuthSessionRow | undefined;
  },

  listActiveSessions(userId: number, seenAfterIso: string): AuthSessionRow[] {
    return getConnection()
      .prepare(
        `SELECT * FROM auth_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND last_seen_at >= ?
         ORDER BY last_seen_at DESC`,
      )
      .all(userId, seenAfterIso) as AuthSessionRow[];
  },

  touchSession(id: string, nowIso: string): void {
    getConnection().prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(nowIso, id);
  },

  revokeSession(userId: number, id: string): boolean {
    return getConnection()
      .prepare(
        `UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .run(id, userId).changes > 0;
  },

  /** Revokes every live sign-in of the user except `keepSessionId`; returns how many. */
  revokeOtherSessions(userId: number, keepSessionId: string | null): number {
    return getConnection()
      .prepare(
        `UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`,
      )
      .run(userId, keepSessionId).changes;
  },

  /** Drops sign-ins revoked or idle since before `olderThanIso`, so the table stays small. */
  pruneSessions(olderThanIso: string): void {
    getConnection()
      .prepare(
        `DELETE FROM auth_sessions
         WHERE last_seen_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      )
      .run(olderThanIso, olderThanIso);
  },

  createTrustedDevice(input: { id: string; userId: number; tokenHash: string; label: string | null; expiresAtIso: string }): void {
    getConnection()
      .prepare(
        `INSERT INTO auth_trusted_devices (id, user_id, token_hash, label, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.userId, input.tokenHash, input.label, input.expiresAtIso);
  },

  findTrustedDevice(userId: number, tokenHash: string, nowIso: string): AuthTrustedDeviceRow | undefined {
    return getConnection()
      .prepare(
        `SELECT * FROM auth_trusted_devices
         WHERE user_id = ? AND token_hash = ? AND expires_at > ?`,
      )
      .get(userId, tokenHash, nowIso) as AuthTrustedDeviceRow | undefined;
  },

  markTrustedDeviceUsed(id: string, nowIso: string): void {
    getConnection().prepare('UPDATE auth_trusted_devices SET last_used_at = ? WHERE id = ?').run(nowIso, id);
  },

  listTrustedDevices(userId: number, nowIso: string): AuthTrustedDeviceRow[] {
    return getConnection()
      .prepare(
        `SELECT * FROM auth_trusted_devices
         WHERE user_id = ? AND expires_at > ?
         ORDER BY created_at DESC`,
      )
      .all(userId, nowIso) as AuthTrustedDeviceRow[];
  },

  removeTrustedDevice(userId: number, id: string): boolean {
    return getConnection()
      .prepare('DELETE FROM auth_trusted_devices WHERE id = ? AND user_id = ?')
      .run(id, userId).changes > 0;
  },

  removeAllTrustedDevices(userId: number): number {
    return getConnection()
      .prepare('DELETE FROM auth_trusted_devices WHERE user_id = ?')
      .run(userId).changes;
  },

  getThrottle(key: string): AuthThrottleRow | undefined {
    return getConnection()
      .prepare('SELECT * FROM auth_throttle WHERE throttle_key = ?')
      .get(key) as AuthThrottleRow | undefined;
  },

  saveThrottle(row: AuthThrottleRow): void {
    getConnection()
      .prepare(
        `INSERT INTO auth_throttle (throttle_key, failed_count, window_started_at, locked_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(throttle_key) DO UPDATE SET
           failed_count = excluded.failed_count,
           window_started_at = excluded.window_started_at,
           locked_until = excluded.locked_until`,
      )
      .run(row.throttle_key, row.failed_count, row.window_started_at, row.locked_until);
  },

  clearThrottle(key: string): void {
    getConnection().prepare('DELETE FROM auth_throttle WHERE throttle_key = ?').run(key);
  },

  /**
   * Drops the failed-login counters of one username from every address
   * (`login:<username>:<ip>` keys), so `mirage passwd` also lifts a lockout.
   */
  clearLoginThrottleForUsername(username: string): void {
    const prefix = `login:${username.trim().toLowerCase()}:`;
    getConnection()
      .prepare('DELETE FROM auth_throttle WHERE substr(throttle_key, 1, length(?)) = ?')
      .run(prefix, prefix);
  },
};
