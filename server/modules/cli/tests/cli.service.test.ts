import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliEnvironment, CliOutput, PasswordResetCommandRequest } from '@/shared/types.js';

import { createCliService } from '../cli.service.js';

function createHarness() {
  const logMessages: string[] = [];
  const errorMessages: string[] = [];
  const environment: CliEnvironment = {};
  const output: CliOutput = {
    log: (message = '') => logMessages.push(message),
    error: (message = '') => errorMessages.push(message),
  };
  let serverStarts = 0;
  let sandboxArguments: string[] = [];
  const passwordResetRequests: PasswordResetCommandRequest[] = [];
  const service = createCliService({
    applicationRoot: '/application',
    defaultDatabasePath: '/home/user/.mirage/auth.db',
    homeDirectory: '/home/user',
    packageMetadata: {
      version: '1.2.3',
      homepage: 'https://cloudcli.example',
      bugsUrl: 'https://cloudcli.example/issues',
    },
    environment,
    fileSystem: {
      pathExists: () => false,
      getFileStats: () => ({ size: 0, modifiedAt: new Date(0) }),
    },
    output,
    sandboxService: {
      execute: async (argumentsList) => {
        sandboxArguments = argumentsList;
        return 7;
      },
    },
    passwordResetService: {
      execute: async (request) => {
        passwordResetRequests.push(request);
        return 0;
      },
    },
    getLatestPackageVersion: async () => '1.2.3',
    manualUpdateCommand: 'git pull --ff-only && npm ci && npm run build',
    startServer: async () => {
      serverStarts += 1;
    },
    startBrowserUseMcp: async () => undefined,
  });

  return {
    service,
    environment,
    logMessages,
    errorMessages,
    getServerStarts: () => serverStarts,
    getSandboxArguments: () => sandboxArguments,
    passwordResetRequests,
  };
}

test('applies CLI options to the injected environment before starting the server', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run([
    '--port',
    '8080',
    '--database-path=/data/app.db',
  ]);

  assert.equal(exitCode, 0);
  assert.equal(harness.environment.SERVER_PORT, '8080');
  assert.equal(harness.environment.DATABASE_PATH, '/data/app.db');
  assert.equal(harness.getServerStarts(), 1);
});

test('passes only sandbox arguments to the injected sandbox service', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['sandbox', 'ls']);

  assert.equal(exitCode, 7);
  assert.deepEqual(harness.getSandboxArguments(), ['ls']);
});

test('returns a failure code for an unknown command without exiting the process', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['unknown']);

  assert.equal(exitCode, 1);
  assert.match(harness.errorMessages[0], /Unknown command: unknown/);
});

test('passwd passes the username, stdin flag and database path to the password reset service', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['passwd', 'owner', '--password-stdin', '--database-path', '/data/app.db']);

  assert.equal(exitCode, 0);
  assert.equal(harness.getServerStarts(), 0);
  assert.deepEqual(harness.passwordResetRequests, [
    { databasePath: '/data/app.db', username: 'owner', passwordFromStdin: true },
  ]);
});

test('reset-password without a username uses the default database and an interactive prompt', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['reset-password']);

  assert.equal(exitCode, 0);
  assert.deepEqual(harness.passwordResetRequests, [
    { databasePath: '/home/user/.mirage/auth.db', username: null, passwordFromStdin: false },
  ]);
});

test('update only explains the git update and links the releases (the package is not on npm)', async () => {
  const harness = createHarness();

  const exitCode = await harness.service.run(['update']);

  assert.equal(exitCode, 0);
  assert.equal(harness.getServerStarts(), 0);
  const printed = harness.logMessages.join('\n');
  assert.match(printed, /latest version \(1\.2\.3\)/);
  assert.match(printed, /git pull --ff-only && npm ci && npm run build/);
  assert.match(printed, /github\.com\/victorglazunoff\/mirage-cloud-panel\/releases/);
  assert.doesNotMatch(printed, /npm (install|update) -g/);
});
