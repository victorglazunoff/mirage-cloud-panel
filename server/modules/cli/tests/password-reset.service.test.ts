import assert from 'node:assert/strict';
import test from 'node:test';

import { createPasswordResetService } from '../password-reset.service.js';

type StoreUser = { id: number; username: string };

function createHarness(options: {
  databaseExists?: boolean;
  users?: StoreUser[];
  isInteractive?: boolean;
  typedLines?: string[];
  stdin?: string;
} = {}) {
  const logMessages: string[] = [];
  const errorMessages: string[] = [];
  const resets: Array<{ user: StoreUser; passwordHash: string; nowMs: number }> = [];
  const prompts: string[] = [];
  const typedLines = [...(options.typedLines ?? [])];
  let storeClosed = false;
  let storeOpenedWith: string | null = null;

  const service = createPasswordResetService({
    fileSystem: {
      pathExists: () => options.databaseExists ?? true,
      getFileStats: () => ({ size: 0, modifiedAt: new Date(0) }),
    },
    output: {
      log: (message = '') => logMessages.push(message),
      error: (message = '') => errorMessages.push(message),
    },
    isInteractive: options.isInteractive ?? true,
    readHiddenLine: async (prompt) => {
      prompts.push(prompt);
      return typedLines.shift() ?? '';
    },
    readStdin: async () => options.stdin ?? '',
    hashPassword: async (password) => `hashed:${password}`,
    openStore: async (databasePath) => {
      storeOpenedWith = databasePath;
      return {
        listActiveUsers: () => options.users ?? [{ id: 1, username: 'owner' }],
        resetPassword: (user, passwordHash, nowMs) => {
          resets.push({ user, passwordHash, nowMs });
          return { revokedSessions: 2 };
        },
        close: () => {
          storeClosed = true;
        },
      };
    },
    now: () => 1_700_000_000_000,
  });

  return {
    service,
    logMessages,
    errorMessages,
    resets,
    prompts,
    isStoreClosed: () => storeClosed,
    getStoreOpenedWith: () => storeOpenedWith,
  };
}

const request = { databasePath: '/data/auth.db', username: null, passwordFromStdin: false };

test('sets a bcrypt hash for the only user after the password is typed twice', async () => {
  const harness = createHarness({ typedLines: ['correct horse battery', 'correct horse battery'] });

  const exitCode = await harness.service.execute(request);

  assert.equal(exitCode, 0);
  assert.equal(harness.getStoreOpenedWith(), '/data/auth.db');
  assert.deepEqual(harness.resets, [
    { user: { id: 1, username: 'owner' }, passwordHash: 'hashed:correct horse battery', nowMs: 1_700_000_000_000 },
  ]);
  assert.equal(harness.prompts.length, 2);
  assert.equal(harness.isStoreClosed(), true);
});

test('changes nothing when the repeated password differs', async () => {
  const harness = createHarness({ typedLines: ['correct horse battery', 'correct horse batterY'] });

  const exitCode = await harness.service.execute(request);

  assert.equal(exitCode, 1);
  assert.deepEqual(harness.resets, []);
  assert.match(harness.errorMessages.join('\n'), /не совпали/);
  assert.equal(harness.isStoreClosed(), true);
});

test('rejects a password shorter than 12 characters before asking again', async () => {
  const harness = createHarness({ typedLines: ['short', 'short'] });

  const exitCode = await harness.service.execute(request);

  assert.equal(exitCode, 1);
  assert.equal(harness.prompts.length, 1);
  assert.deepEqual(harness.resets, []);
});

test('rejects a password longer than 72 bytes (bcrypt would cut it)', async () => {
  const longPassword = 'пароль'.repeat(7); // 42 Cyrillic characters = 84 bytes
  const harness = createHarness({ stdin: `${longPassword}\n` });

  const exitCode = await harness.service.execute({ ...request, passwordFromStdin: true });

  assert.equal(exitCode, 1);
  assert.match(harness.errorMessages.join('\n'), /72 байт/);
  assert.deepEqual(harness.resets, []);
});

test('reads only the first stdin line with --password-stdin', async () => {
  const harness = createHarness({ isInteractive: false, stdin: 'from-a-script-123\nignored\n' });

  const exitCode = await harness.service.execute({ ...request, passwordFromStdin: true });

  assert.equal(exitCode, 0);
  assert.equal(harness.resets[0]?.passwordHash, 'hashed:from-a-script-123');
  assert.deepEqual(harness.prompts, []);
});

test('refuses to wait for a password without a terminal or --password-stdin', async () => {
  const harness = createHarness({ isInteractive: false });

  const exitCode = await harness.service.execute(request);

  assert.equal(exitCode, 1);
  assert.match(harness.errorMessages.join('\n'), /--password-stdin/);
  assert.deepEqual(harness.resets, []);
});

test('does not create a database that is not there', async () => {
  const harness = createHarness({ databaseExists: false });

  const exitCode = await harness.service.execute(request);

  assert.equal(exitCode, 1);
  assert.equal(harness.getStoreOpenedWith(), null);
  assert.match(harness.errorMessages.join('\n'), /не найдена/);
});

test('asks to register first when the panel has no owner yet', async () => {
  const harness = createHarness({ users: [] });

  const exitCode = await harness.service.execute(request);

  assert.equal(exitCode, 1);
  assert.match(harness.errorMessages.join('\n'), /зарегистрируйтесь/);
});

test('needs a username when there are several users and rejects an unknown one', async () => {
  const users = [{ id: 1, username: 'owner' }, { id: 2, username: 'second' }];

  const withoutName = createHarness({ users });
  assert.equal(await withoutName.service.execute(request), 1);
  assert.match(withoutName.errorMessages.join('\n'), /owner, second/);

  const unknownName = createHarness({ users });
  assert.equal(await unknownName.service.execute({ ...request, username: 'nobody' }), 1);

  const knownName = createHarness({ users, stdin: 'second-password-1' });
  assert.equal(await knownName.service.execute({ ...request, username: 'second', passwordFromStdin: true }), 0);
  assert.equal(knownName.resets[0]?.user.id, 2);
});
