import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClaudeSettingsFile } from '@/modules/mirage-settings/services/claude-settings-file.service.js';
import { createMirageSettingsService } from '@/modules/mirage-settings/services/mirage-settings.service.js';
import { AppError } from '@/shared/utils.js';

type Harness = {
  directory: string;
  settingsPath: string;
  env: NodeJS.ProcessEnv;
  stored: { json: string | null; savedAt: string | null };
  service: ReturnType<typeof createMirageSettingsService>;
};

async function withSettings(initialFile: string | null, runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mirage-settings-'));
  const settingsPath = path.join(directory, 'settings.json');
  if (initialFile !== null) {
    await writeFile(settingsPath, initialFile, { mode: 0o640 });
  }
  const env: NodeJS.ProcessEnv = {};
  const stored: Harness['stored'] = { json: null, savedAt: null };
  const service = createMirageSettingsService({
    readStored: () => stored.json,
    readSavedAt: () => stored.savedAt,
    writeStored: (json, savedAt) => {
      stored.json = json;
      stored.savedAt = savedAt;
    },
    claudeSettings: createClaudeSettingsFile(settingsPath, () => Date.parse('2026-10-26T09:00:00Z')),
    readServerRuntime: () => ({ homeDir: '/home/panel', isRoot: false }),
    env,
    now: () => Date.parse('2026-10-26T09:00:00Z'),
  });
  try {
    await runTest({ directory, settingsPath, env, stored, service });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const EXISTING = `${JSON.stringify({
  env: { CLAUDE_CODE_ARTIFACT: '1', OTHER: 'keep' },
  enableWorkflows: true,
  permissions: { allow: ['Bash(ls:*)'] },
  model: 'opus',
}, null, 2)}\n`;

test('defaults come from the mock-up and settings.json is read for the two Claude keys', async () => {
  await withSettings(EXISTING, async ({ service }) => {
    const view = await service.getSettings();
    assert.equal(view.settings.claude.artifacts, true);
    assert.equal(view.settings.claude.workflows, true);
    assert.equal(view.settings.claude.permissionMode, 'default');
    assert.equal(view.settings.claude.effort, 'high');
    assert.equal(view.settings.claude.silenceCeilingMin, 30);
    assert.equal(view.settings.claude.midTurnMessage, 'inject');
    assert.deepEqual(view.settings.home.widgets.filter((widget) => widget.enabled).map((widget) => widget.id), ['fav', 'work', 'cal', 'lim']);
    assert.equal(view.claudeSettings.readable, true);
    assert.equal(view.savedAt, null);
    // The client learns `~` and the root flag from here instead of guessing from paths.
    assert.deepEqual(view.server, { homeDir: '/home/panel', isRoot: false });
  });
});

test('toggling artifacts and workflows edits only those keys, atomically, with a backup beside the file', async () => {
  await withSettings(EXISTING, async ({ directory, settingsPath, service }) => {
    const view = await service.updateSettings({ claude: { artifacts: false, workflows: false } });
    assert.equal(view.settings.claude.artifacts, false);
    assert.equal(view.settings.claude.workflows, false);

    const written = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(written, {
      env: { CLAUDE_CODE_ARTIFACT: '0', OTHER: 'keep' },
      enableWorkflows: false,
      permissions: { allow: ['Bash(ls:*)'] },
      model: 'opus',
    });
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o640);

    const files = await readdir(directory);
    const backups = files.filter((name) => name.startsWith('settings.json.mirage-bak-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(directory, backups[0]), 'utf8'), EXISTING);
    assert.equal(files.some((name) => name.includes('mirage-tmp')), false);

    // No change, no write and no new backup.
    await service.updateSettings({ claude: { workflows: false } });
    assert.equal((await readdir(directory)).filter((name) => name.startsWith('settings.json.mirage-bak-')).length, 1);
  });
});

test('a missing settings.json is created; an unparsable one is never overwritten', async () => {
  await withSettings(null, async ({ settingsPath, service }) => {
    await service.updateSettings({ claude: { workflows: true } });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { enableWorkflows: true });
  });

  await withSettings('{ not json', async ({ settingsPath, service }) => {
    await assert.rejects(
      service.updateSettings({ claude: { artifacts: true } }),
      (error: unknown) => error instanceof AppError && error.code === 'CLAUDE_SETTINGS_UNREADABLE',
    );
    assert.equal(await readFile(settingsPath, 'utf8'), '{ not json');
    const view = await service.getSettings();
    assert.equal(view.claudeSettings.readable, false);
  });
});

test('panel keys are stored in the database and the silence ceiling reaches the runtime without restart', async () => {
  await withSettings(EXISTING, async ({ env, stored, service }) => {
    const view = await service.updateSettings({
      claude: { permissionMode: 'auto', model: 'sonnet', effort: 'xhigh', silenceCeilingMin: 120, midTurnMessage: 'queue' },
      voice: { language: 'auto', engine: 'whisper' },
      notifications: { quietHours: { from: '22:30' } },
      appearance: { density: 'compact' },
      home: { widgets: [{ id: 'server', enabled: true }, { id: 'fav', enabled: true }] },
    });
    assert.equal(view.settings.claude.permissionMode, 'auto');
    assert.equal(view.settings.voice.engine, 'whisper');
    assert.equal(view.settings.voice.sendOnRelease, true);
    assert.deepEqual(view.settings.notifications.quietHours, { enabled: true, from: '22:30', to: '08:00' });
    assert.deepEqual(view.settings.home.widgets.slice(0, 3), [
      { id: 'server', enabled: true }, { id: 'fav', enabled: true }, { id: 'work', enabled: false },
    ]);
    assert.equal(view.savedAt, '2026-10-26T09:00:00.000Z');
    assert.ok(stored.json && !stored.json.includes('artifacts'));

    // The Claude runtime re-reads this variable on every use (see claude-sdk-env tests).
    assert.equal(env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN, '120');

    // A restart: the saved ceiling outranks the environment.
    env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN = '45';
    service.applyStoredRuntimeSettings();
    assert.equal(env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN, '120');
  });
});

test('invalid and unknown keys are refused with the field named', async () => {
  await withSettings(EXISTING, async ({ service }) => {
    for (const patch of [
      { claude: { permissionMode: 'bypassPermissions' } },
      { claude: { silenceCeilingMin: 0 } },
      { claude: { artifacts: 'yes' } },
      { voice: { language: 'de' } },
      { notifications: { quietHours: { from: '25:00' } } },
      { home: { widgets: [{ id: 'fav', enabled: true }, { id: 'fav', enabled: false }] } },
      { theme: 'light' },
      [],
    ]) {
      await assert.rejects(
        service.updateSettings(patch),
        (error: unknown) => error instanceof AppError && error.code === 'MIRAGE_SETTINGS_INVALID',
        JSON.stringify(patch),
      );
    }
  });
});

test('«Как тебя называть» is stored trimmed, empty by default, and refuses long or markup names', async () => {
  await withSettings(EXISTING, async ({ service }) => {
    assert.equal((await service.getSettings()).settings.profile.displayName, '');
    const view = await service.updateSettings({ profile: { displayName: '  Иван   Г. ' } });
    assert.equal(view.settings.profile.displayName, 'Иван Г.');
    for (const displayName of ['x'.repeat(41), '<b>', 7]) {
      await assert.rejects(
        service.updateSettings({ profile: { displayName } }),
        (error: unknown) => error instanceof AppError && error.code === 'MIRAGE_SETTINGS_INVALID',
      );
    }
    assert.equal((await service.getSettings()).settings.profile.displayName, 'Иван Г.');
  });
});

test('keys inherited from Object.prototype are refused, not stored or run as rules', async () => {
  await withSettings(EXISTING, async ({ service, stored }) => {
    for (const patch of [
      { constructor: { a: 1 } },
      { notifications: { valueOf: 1 } },
      { profile: { toString: 'x' } },
      { hasOwnProperty: 5 },
      JSON.parse('{"__proto__":{"toString":1}}'),
    ]) {
      await assert.rejects(
        () => service.updateSettings(patch),
        (error: unknown) => error instanceof AppError && error.statusCode === 400,
        JSON.stringify(patch),
      );
    }
    assert.equal(stored.json, null);

    // A row written before the fix keeps only real settings.
    stored.json = JSON.stringify({ constructor: { a: 1 }, profile: { displayName: 'Иван', toString: 'x' } });
    const view = await service.getSettings();
    assert.equal(Object.hasOwn(view.settings, 'constructor'), false);
    assert.equal(Object.hasOwn(view.settings.profile, 'toString'), false);
    assert.equal(view.settings.profile.displayName, 'Иван');
  });
});
