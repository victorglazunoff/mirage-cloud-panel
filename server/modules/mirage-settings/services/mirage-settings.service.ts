import os from 'node:os';

import { appConfigDb } from '@/modules/database/index.js';
import type { MirageSettings, MirageSettingsView } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createClaudeSettingsFile, resolveClaudeSettingsPath } from './claude-settings-file.service.js';

/**
 * The Kabina settings screen (DarkSettings): one document of safe keys.
 *
 * `claude.artifacts` / `claude.workflows` are stored where Claude Code reads
 * them — `env.CLAUDE_CODE_ARTIFACT` and `enableWorkflows` in
 * `~/.claude/settings.json`. Everything else is kept in the panel database
 * (`app_config`, one JSON row). The silence ceiling is also pushed into
 * `process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN`, which the Claude runtime
 * re-reads on every use, so it applies without a restart.
 */

const STORAGE_KEY = 'mirage_settings';
const SAVED_AT_KEY = 'mirage_settings_saved_at';
const IDLE_TIMEOUT_ENV = 'CLAUDE_SESSION_IDLE_TIMEOUT_MIN';

const WIDGET_IDS = ['fav', 'work', 'cal', 'lim', 'leads', 'server', 'deploy'] as const;
type WidgetId = (typeof WIDGET_IDS)[number];
const DEFAULT_WIDGETS_ON: ReadonlyArray<WidgetId> = ['fav', 'work', 'cal', 'lim'];

type DatabaseSettings = Omit<MirageSettings, 'claude'> & {
  claude: Omit<MirageSettings['claude'], 'artifacts' | 'workflows'>;
};

type JsonObject = Record<string, unknown>;

type MirageSettingsDependencies = {
  readStored(): string | null;
  writeStored(json: string, savedAtIso: string): void;
  readSavedAt(): string | null;
  claudeSettings: ReturnType<typeof createClaudeSettingsFile>;
  /** The server process's home folder and root flag (`MirageSettingsView.server`). */
  readServerRuntime(): MirageSettingsView['server'];
  env: NodeJS.ProcessEnv;
  now(): number;
};

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field: string, expected: string): AppError {
  return new AppError(`${field}: ${expected}.`, { code: 'MIRAGE_SETTINGS_INVALID', statusCode: 400, details: { field } });
}

function defaultSilenceCeiling(env: NodeJS.ProcessEnv): number {
  const minutes = Number.parseFloat(env[IDLE_TIMEOUT_ENV] ?? '');
  return Number.isFinite(minutes) && minutes >= 1 ? Math.min(Math.round(minutes), 24 * 60) : 30;
}

function buildDefaults(env: NodeJS.ProcessEnv): DatabaseSettings {
  return {
    claude: {
      permissionMode: 'default',
      model: 'opus',
      effort: 'high',
      silenceCeilingMin: defaultSilenceCeiling(env),
      midTurnMessage: 'inject',
    },
    voice: { language: 'ru', engine: 'yandex', sendOnRelease: true, speakReplies: false, hotkey: 'Alt+Space' },
    notifications: {
      channels: { telegram: true, max: false, browser: true },
      events: { turnComplete: false, backgroundDone: false, approvalNeeded: true, limit80: false },
      quietHours: { enabled: true, from: '23:00', to: '08:00' },
    },
    home: { widgets: WIDGET_IDS.map((id) => ({ id, enabled: DEFAULT_WIDGETS_ON.includes(id) })) },
    appearance: { theme: 'cabin', density: 'normal' },
    profile: { displayName: '' },
  };
}

// ----------------- Validation of a deep partial patch -----------------
// Every leaf has an explicit rule; unknown keys are refused so a typo in the
// client does not silently do nothing.

type LeafRule = (value: unknown, field: string) => unknown;

const oneOf = (...allowed: string[]): LeafRule => (value, field) => {
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid(field, `одно из ${allowed.join(', ')}`);
  return value;
};
const boolean: LeafRule = (value, field) => {
  if (typeof value !== 'boolean') throw invalid(field, 'true или false');
  return value;
};
const clockTime: LeafRule = (value, field) => {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw invalid(field, 'время ЧЧ:ММ');
  return value;
};
const modelId: LeafRule = (value, field) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._[\]-]{1,80}$/.test(value)) throw invalid(field, 'идентификатор модели (opus, sonnet, haiku или полный id)');
  return value;
};
const minutes: LeafRule = (value, field) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 24 * 60) throw invalid(field, 'целое число минут от 1 до 1440');
  return value;
};
const hotkey: LeafRule = (value, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 40) throw invalid(field, 'сочетание клавиш до 40 символов');
  return value.trim();
};
/** «Как тебя называть»: a short name for the home greeting; empty means «take it from the login». */
const displayName: LeafRule = (value, field) => {
  if (typeof value !== 'string') throw invalid(field, 'строка до 40 символов');
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length > 40 || /[<>{}]/.test(name)) throw invalid(field, 'имя до 40 символов без < > { }');
  return name;
};
const widgets: LeafRule = (value, field) => {
  if (!Array.isArray(value)) throw invalid(field, 'список виджетов');
  const seen = new Set<string>();
  const list = value.map((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || !(WIDGET_IDS as readonly string[]).includes(entry.id)
      || typeof entry.enabled !== 'boolean' || seen.has(entry.id)) {
      throw invalid(`${field}[${index}]`, `{ id: ${WIDGET_IDS.join('|')}, enabled: boolean } без повторов`);
    }
    seen.add(entry.id);
    return { id: entry.id as WidgetId, enabled: entry.enabled };
  });
  // Widgets the client did not mention keep their place at the end, switched off.
  return [...list, ...WIDGET_IDS.filter((id) => !seen.has(id)).map((id) => ({ id, enabled: false }))];
};

type Schema = { [key: string]: LeafRule | Schema };

/**
 * The rule for `key`, own keys only: a plain `schema[key]` would also find
 * `constructor`, `toString`, `__proto__`… on Object.prototype and let them in
 * (stored as junk, or run as a «rule» that throws and answers 500).
 */
function ruleFor(schema: Schema, key: string): LeafRule | Schema | undefined {
  return Object.hasOwn(schema, key) ? schema[key] : undefined;
}

const PATCH_SCHEMA: Schema = {
  claude: {
    permissionMode: oneOf('default', 'auto', 'plan', 'acceptEdits'),
    model: modelId,
    effort: oneOf('low', 'medium', 'high', 'xhigh', 'max'),
    artifacts: boolean,
    workflows: boolean,
    silenceCeilingMin: minutes,
    midTurnMessage: oneOf('inject', 'queue'),
  },
  voice: {
    language: oneOf('ru', 'en', 'auto'),
    engine: oneOf('yandex', 'whisper'),
    sendOnRelease: boolean,
    speakReplies: boolean,
    hotkey,
  },
  notifications: {
    channels: { telegram: boolean, max: boolean, browser: boolean },
    events: { turnComplete: boolean, backgroundDone: boolean, approvalNeeded: boolean, limit80: boolean },
    quietHours: { enabled: boolean, from: clockTime, to: clockTime },
  },
  home: { widgets },
  appearance: { theme: oneOf('cabin', 'light'), density: oneOf('normal', 'compact') },
  profile: { displayName },
};

/** Validates `patch` against the schema and returns the cleaned copy. */
function validatePatch(patch: unknown, schema: Schema, prefix: string): JsonObject {
  if (!isPlainObject(patch)) throw invalid(prefix || 'тело запроса', 'объект');
  const cleaned: JsonObject = {};
  for (const [key, value] of Object.entries(patch)) {
    const field = prefix ? `${prefix}.${key}` : key;
    const rule = ruleFor(schema, key);
    if (!rule) throw invalid(field, 'неизвестная настройка');
    cleaned[key] = typeof rule === 'function' ? rule(value, field) : validatePatch(value, rule, field);
  }
  return cleaned;
}

function deepMerge(base: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key] as JsonObject, value) : value;
  }
  return merged;
}

/** Keeps only stored values that still pass validation, so an old or hand-edited row cannot break the screen. */
function sanitizeStored(stored: unknown, schema: Schema): JsonObject {
  if (!isPlainObject(stored)) return {};
  const kept: JsonObject = {};
  for (const [key, value] of Object.entries(stored)) {
    const rule = ruleFor(schema, key);
    if (!rule) continue;
    try {
      kept[key] = typeof rule === 'function' ? rule(value, key) : sanitizeStored(value, rule);
    } catch {
      // Dropped: the default for this key applies.
    }
  }
  return kept;
}

function readArtifactsFlag(settings: JsonObject): boolean {
  const env = isPlainObject(settings.env) ? settings.env : {};
  const raw = env.CLAUDE_CODE_ARTIFACT;
  // The panel's SDK runs default artifacts on (buildClaudeSdkEnv); only an
  // explicit 0/false in settings.json turns them off.
  if (raw === undefined || raw === null) return true;
  return !['0', 'false', 'no', 'off', ''].includes(String(raw).trim().toLowerCase());
}

/** Creates the settings service; tests inject a temp settings file and fake storage. */
export function createMirageSettingsService(dependencies: MirageSettingsDependencies) {
  const { claudeSettings: claudeSettingsFile } = dependencies;
  const dbSchema: Schema = {
    ...PATCH_SCHEMA,
    claude: Object.fromEntries(Object.entries(PATCH_SCHEMA.claude as Schema).filter(([key]) => key !== 'artifacts' && key !== 'workflows')),
  };

  const readDatabaseSettings = (): DatabaseSettings => {
    let stored: unknown = {};
    try {
      stored = JSON.parse(dependencies.readStored() ?? '{}');
    } catch {
      stored = {};
    }
    return deepMerge(buildDefaults(dependencies.env), sanitizeStored(stored, dbSchema)) as DatabaseSettings;
  };

  const buildView = async (): Promise<MirageSettingsView> => {
    const snapshot = await claudeSettingsFile.read();
    const database = readDatabaseSettings();
    return {
      settings: {
        ...database,
        claude: {
          ...database.claude,
          artifacts: readArtifactsFlag(snapshot.data),
          workflows: snapshot.data.enableWorkflows === true,
        },
      },
      claudeSettings: { path: snapshot.path, exists: snapshot.exists, readable: snapshot.readable, error: snapshot.error },
      savedAt: dependencies.readSavedAt(),
      server: dependencies.readServerRuntime(),
    };
  };

  /** Pushes runtime-relevant settings into the live process. */
  const applyRuntime = (settings: DatabaseSettings): void => {
    dependencies.env[IDLE_TIMEOUT_ENV] = String(settings.claude.silenceCeilingMin);
  };

  return {
    getSettings: buildView,

    /**
     * Applies a deep partial update. settings.json is written first and only
     * for the two keys it owns; the database row is saved after, so a refused
     * settings.json write leaves nothing half-applied.
     */
    async updateSettings(patch: unknown): Promise<MirageSettingsView> {
      const cleaned = validatePatch(patch, PATCH_SCHEMA, '');
      const claudePatch = isPlainObject(cleaned.claude) ? { ...cleaned.claude } : null;

      if (claudePatch && ('artifacts' in claudePatch || 'workflows' in claudePatch)) {
        const artifacts = claudePatch.artifacts as boolean | undefined;
        const workflows = claudePatch.workflows as boolean | undefined;
        await claudeSettingsFile.update((settings) => {
          if (artifacts !== undefined) {
            const env = isPlainObject(settings.env) ? settings.env : {};
            env.CLAUDE_CODE_ARTIFACT = artifacts ? '1' : '0';
            settings.env = env;
          }
          if (workflows !== undefined) {
            settings.enableWorkflows = workflows;
          }
        });
        delete claudePatch.artifacts;
        delete claudePatch.workflows;
      }

      const databasePatch: JsonObject = { ...cleaned };
      if (claudePatch) {
        if (Object.keys(claudePatch).length > 0) databasePatch.claude = claudePatch;
        else delete databasePatch.claude;
      }
      if (Object.keys(databasePatch).length > 0) {
        const next = deepMerge(readDatabaseSettings() as unknown as JsonObject, databasePatch) as DatabaseSettings;
        dependencies.writeStored(JSON.stringify(next), new Date(dependencies.now()).toISOString());
        if (isPlainObject(databasePatch.claude) && 'silenceCeilingMin' in databasePatch.claude) {
          applyRuntime(next);
        }
      }
      return buildView();
    },

    /**
     * Called once at server start: a ceiling saved from the settings screen
     * outranks the service's environment. Without a saved value nothing changes.
     */
    applyStoredRuntimeSettings(): void {
      const raw = dependencies.readStored();
      if (!raw) return;
      try {
        const stored = sanitizeStored(JSON.parse(raw), dbSchema);
        const claude = isPlainObject(stored.claude) ? stored.claude : {};
        if (typeof claude.silenceCeilingMin === 'number') {
          dependencies.env[IDLE_TIMEOUT_ENV] = String(claude.silenceCeilingMin);
        }
      } catch {
        // A corrupt row keeps the environment's value.
      }
    },
  };
}

/** Used by the mirage-settings routes and the server start-up. */
export const mirageSettingsService = createMirageSettingsService({
  readStored: () => appConfigDb.get(STORAGE_KEY),
  readSavedAt: () => appConfigDb.get(SAVED_AT_KEY),
  writeStored: (json, savedAtIso) => {
    appConfigDb.set(STORAGE_KEY, json);
    appConfigDb.set(SAVED_AT_KEY, savedAtIso);
  },
  claudeSettings: createClaudeSettingsFile(resolveClaudeSettingsPath()),
  readServerRuntime: () => ({
    homeDir: os.homedir(),
    // uid 0 is root; Windows has no getuid and no root.
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  }),
  env: process.env,
  now: () => Date.now(),
});

/** Server start-up hook: applies a silence ceiling saved from the settings screen. */
export function applyStoredMirageRuntimeSettings(): void {
  mirageSettingsService.applyStoredRuntimeSettings();
}
