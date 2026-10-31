import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';

import spawn from 'cross-spawn';

import type { CliApplication, CliPackageMetadata } from '@/shared/types.js';
import { findApplicationRoot, getMirageDataDir, getModuleDirectory } from '@/shared/utils.js';

import { GIT_UPDATE_COMMAND, REPOSITORY_NAME, REPOSITORY_OWNER } from '../../../shared/brand.js';

import { createCliService } from './cli.service.js';
import { createPasswordResetService } from './password-reset.service.js';
import { createSandboxCommandService } from './sandbox.service.js';

/**
 * Runs database bootstrap code without its progress lines ("Database schema
 * applied", "Database connection closed"): `mirage passwd` talks to a person
 * in a terminal, and those lines are server-log noise there.
 */
async function withoutConsoleLog<T>(work: () => T | Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await work();
  } finally {
    console.log = originalLog;
  }
}

/** Asks one line in the terminal without echoing what is typed (for passwords). */
function readHiddenLine(prompt: string): Promise<string> {
  let muted = false;
  const mutableOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk);
      }
      callback();
    },
  });
  const terminal = readline.createInterface({ input: process.stdin, output: mutableOutput, terminal: true });
  return new Promise((resolve) => {
    terminal.question(prompt, (answer) => {
      terminal.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

function readStandardInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Creates the production CLI application for the executable entrypoint. This is
 * the CLI module's single composition root: it reads package metadata and wires
 * all concrete Node filesystem, subprocess, environment, clock, and module-start
 * adapters before passing them into otherwise isolated services.
 */
export function createCliApplication(): CliApplication {
  const applicationRoot = findApplicationRoot(getModuleDirectory(import.meta.url));
  const packageMetadataJson = JSON.parse(
    fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'),
  ) as { name: string; version: string; homepage?: string; bugs?: { url?: string } };
  const packageMetadata: CliPackageMetadata = {
    version: packageMetadataJson.version,
    homepage: packageMetadataJson.homepage,
    bugsUrl: packageMetadataJson.bugs?.url,
  };
  const fileSystem = {
    pathExists: (filePath: string) => fs.existsSync(filePath),
    getFileStats: (filePath: string) => {
      const stats = fs.statSync(filePath);
      return { size: stats.size, modifiedAt: stats.mtime };
    },
  };
  const output = {
    log: (message?: string) => console.log(message),
    error: (message?: string) => console.error(message),
  };
  const homeDirectory = os.homedir();
  const sandboxService = createSandboxCommandService({
    homeDirectory,
    fileSystem,
    output,
    runSandboxCommand: (argumentsList, inheritOutput = false) => {
      const result = execFileSync('sbx', argumentsList, {
        encoding: 'utf8',
        stdio: inheritOutput ? 'inherit' : 'pipe',
      });
      return result || '';
    },
    spawnDetachedSandbox: (argumentsList) => {
      const childProcess = spawn('sbx', argumentsList, {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      childProcess.unref();
    },
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });

  const passwordResetService = createPasswordResetService({
    fileSystem,
    output,
    isInteractive: Boolean(process.stdin.isTTY),
    readHiddenLine,
    readStdin: readStandardInput,
    hashPassword: (password) => {
      // Same bcrypt cost as registration and the password change in the Auth module.
      const bcrypt = createRequire(import.meta.url)('bcrypt') as { hash(value: string, rounds: number): Promise<string> };
      return bcrypt.hash(password, 12);
    },
    openStore: async (databasePath) => {
      // The database module reads DATABASE_PATH when it opens the connection.
      process.env.DATABASE_PATH = databasePath;
      const database = await import('../database/index.js');
      // A database left by CloudCLI UI may lack the sign-in tables; the server would add them on start too.
      await withoutConsoleLog(() => database.initializeDatabase());
      return {
        listActiveUsers: () => database.userDb.listActiveUsers(),
        resetPassword: (user, passwordHash, nowMs) => database.getConnection().transaction(() => {
          database.userDb.updatePasswordHash(user.id, passwordHash);
          database.authSecurityDb.updateUserSecurity(user.id, {
            tokens_valid_after: Math.floor(nowMs / 1000),
            password_changed_at: new Date(nowMs).toISOString(),
          });
          database.authSecurityDb.clearLoginThrottleForUsername(user.username);
          return { revokedSessions: database.authSecurityDb.revokeOtherSessions(user.id, null) };
        })(),
        close: () => {
          void withoutConsoleLog(() => database.closeConnection());
        },
      };
    },
    now: () => Date.now(),
  });

  return createCliService({
    applicationRoot,
    defaultDatabasePath: path.join(getMirageDataDir(), 'auth.db'),
    homeDirectory,
    packageMetadata,
    environment: process.env,
    fileSystem,
    output,
    sandboxService,
    passwordResetService,
    getLatestPackageVersion: async () => {
      // Yield first so the default `start` command can begin loading the server
      // before this best-effort check runs. The panel is not on npm: the latest
      // version is the latest GitHub release (the web client asks the same API).
      await new Promise<void>((resolve) => setImmediate(resolve));
      const response = await fetch(
        `https://api.github.com/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/releases/latest`,
        { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) {
        throw new Error(`GitHub releases answered ${response.status}`);
      }
      const release = await response.json() as { tag_name?: string };
      if (!release.tag_name) {
        throw new Error('The latest release has no tag');
      }
      return release.tag_name.replace(/^v/, '');
    },
    manualUpdateCommand: GIT_UPDATE_COMMAND,
    startServer: async () => {
      // The server executable is an entrypoint rather than a feature module,
      // so it has no barrel contract to import through.
      // eslint-disable-next-line boundaries/no-unknown
      await import('../../index.js');
    },
    startBrowserUseMcp: async () => {
      const { startBrowserUseMcp } = await import('../browser-use/index.js');
      await startBrowserUseMcp();
    },
  });
}
