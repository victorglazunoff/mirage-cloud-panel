import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateLegacyDataDirs, resolveMirageDataDir } from '@/data-dirs.js';
import { getMirageDataDir, readMirageEnv } from '@/shared/utils.js';

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mirage-data-dir-'));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function seedLegacy(home: string): void {
  mkdirSync(path.join(home, '.cloudcli', 'assets'), { recursive: true });
  writeFileSync(path.join(home, '.cloudcli', 'assets', 'a.png'), 'png');
  writeFileSync(path.join(home, '.cloudcli', 'auth.db'), 'db');
  writeFileSync(path.join(home, '.cloudcli', 'auth.db-wal'), 'wal');
  writeFileSync(path.join(home, '.cloudcli', 'auth.db.bak-2026-10-01'), 'old');
  writeFileSync(path.join(home, '.cloudcli', 'local-server.json'), '{}');
  mkdirSync(path.join(home, '.claude-code-ui', 'plugins', 'prism'), { recursive: true });
  writeFileSync(path.join(home, '.claude-code-ui', 'plugins', 'prism', 'manifest.json'), '{}');
  writeFileSync(path.join(home, '.claude-code-ui', 'plugins.json'), '{"prism":{}}');
}

test('the data folder is MIRAGE_DATA_DIR, else ~/.mirage, in the bootstrap and at run time alike', () => {
  assert.equal(resolveMirageDataDir({}, '/home/panel'), path.join('/home/panel', '.mirage'));
  assert.equal(resolveMirageDataDir({ MIRAGE_DATA_DIR: ' /srv/mirage ' }, '/home/panel'), '/srv/mirage');
  assert.equal(getMirageDataDir({ MIRAGE_DATA_DIR: '/srv/mirage' }), '/srv/mirage');
  assert.equal(getMirageDataDir({}), path.join(os.homedir(), '.mirage'));
});

test('MIRAGE_* settings fall back to the old CLOUDCLI_* names', () => {
  assert.equal(readMirageEnv('BROWSER_USE_SESSION_TTL_MS', { CLOUDCLI_BROWSER_USE_SESSION_TTL_MS: '5' }), '5');
  assert.equal(readMirageEnv('BROWSER_USE_SESSION_TTL_MS', { MIRAGE_BROWSER_USE_SESSION_TTL_MS: '7', CLOUDCLI_BROWSER_USE_SESSION_TTL_MS: '5' }), '7');
  assert.equal(readMirageEnv('BROWSER_USE_SESSION_TTL_MS', { MIRAGE_BROWSER_USE_SESSION_TTL_MS: ' ', CLOUDCLI_BROWSER_USE_SESSION_TTL_MS: '5' }), '5');
  assert.equal(readMirageEnv('BROWSER_USE_SESSION_TTL_MS', {}), undefined);
});

test('first start copies the CloudCLI folders into the data folder and keeps the old ones', () => {
  withHome((home) => {
    seedLegacy(home);
    const dataDir = path.join(home, '.mirage');
    const logs: string[] = [];
    const copied = migrateLegacyDataDirs({ homeDir: home, dataDir, databasePathIsExplicit: false, log: (line) => logs.push(line) });

    assert.equal(copied.length, 5);
    assert.deepEqual(readdirSync(dataDir).sort(), ['assets', 'auth.db', 'auth.db-wal', 'plugins', 'plugins.json']);
    assert.equal(readFileSync(path.join(dataDir, 'assets', 'a.png'), 'utf8'), 'png');
    assert.equal(readFileSync(path.join(dataDir, 'plugins', 'prism', 'manifest.json'), 'utf8'), '{}');
    // Copied, not moved: the original panel still finds everything.
    assert.ok(existsSync(path.join(home, '.cloudcli', 'auth.db')));
    assert.ok(existsSync(path.join(home, '.claude-code-ui', 'plugins.json')));
    assert.match(logs[0], /copied/);
    assert.equal(readdirSync(home).some((name) => name.includes('.migrating-')), false);

    // Second start: the data folder exists, nothing is copied again.
    writeFileSync(path.join(home, '.cloudcli', 'assets', 'b.png'), 'png');
    assert.deepEqual(migrateLegacyDataDirs({ homeDir: home, dataDir, databasePathIsExplicit: false, log: () => {} }), []);
    assert.equal(existsSync(path.join(dataDir, 'assets', 'b.png')), false);
  });
});

test('with an explicit DATABASE_PATH the old database is left out; nothing old — nothing to do', () => {
  withHome((home) => {
    seedLegacy(home);
    const dataDir = path.join(home, '.mirage');
    migrateLegacyDataDirs({ homeDir: home, dataDir, databasePathIsExplicit: true, log: () => {} });
    assert.deepEqual(readdirSync(dataDir).sort(), ['assets', 'plugins', 'plugins.json']);
  });
  withHome((home) => {
    const dataDir = path.join(home, '.mirage');
    assert.deepEqual(migrateLegacyDataDirs({ homeDir: home, dataDir, databasePathIsExplicit: false, log: () => {} }), []);
    assert.equal(existsSync(dataDir), false, 'a fresh install creates the folder later, when it first writes');
  });
});
