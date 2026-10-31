import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  authSecurityDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';

// The repository calls `mirage passwd` (CLI module) relies on, against a real SQLite file.
async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'password-reset-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('listActiveUsers returns active users in id order and skips deactivated ones', async () => {
  await withDatabase(() => {
    const insert = getConnection().prepare('INSERT INTO users (id, username, password_hash, is_active) VALUES (?, ?, ?, ?)');
    insert.run(2, 'second', 'hash', 1);
    insert.run(1, 'owner', 'hash', 1);
    insert.run(3, 'gone', 'hash', 0);

    assert.deepEqual(userDb.listActiveUsers(), [
      { id: 1, username: 'owner' },
      { id: 2, username: 'second' },
    ]);
  });
});

test('clearLoginThrottleForUsername lifts the lock of that username from every address only', async () => {
  await withDatabase(() => {
    const lock = { failed_count: 5, window_started_at: 1, locked_until: 9_999_999_999_999 };
    authSecurityDb.saveThrottle({ throttle_key: 'login:owner:203.0.113.5', ...lock });
    authSecurityDb.saveThrottle({ throttle_key: 'login:owner:unknown', ...lock });
    authSecurityDb.saveThrottle({ throttle_key: 'login:owner2:203.0.113.5', ...lock });
    authSecurityDb.saveThrottle({ throttle_key: 'totp:1', ...lock });

    authSecurityDb.clearLoginThrottleForUsername(' Owner ');

    assert.equal(authSecurityDb.getThrottle('login:owner:203.0.113.5'), undefined);
    assert.equal(authSecurityDb.getThrottle('login:owner:unknown'), undefined);
    assert.ok(authSecurityDb.getThrottle('login:owner2:203.0.113.5'));
    assert.ok(authSecurityDb.getThrottle('totp:1'));
  });
});
