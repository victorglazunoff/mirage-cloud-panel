// Mirage data folder bootstrap: where the panel keeps its database, uploads,
// artifacts, plugins and small state files, and the one-time copy from the
// folders the original CloudCLI UI used.
//
// Used only by load-env.ts, before any other server module is evaluated. Like
// load-env.ts it imports nothing but Node built-ins: shared/utils.ts reads the
// environment while it is evaluated, before `.env` is loaded, so the data
// folder rule is repeated here and in `getMirageDataDir` (shared/utils.ts).
import fs from 'node:fs';
import path from 'node:path';

/** The original CloudCLI UI's data folder: database, assets, browser profiles, shell themes. */
const LEGACY_DATA_FOLDER = '.cloudcli';
/** The original plugin folder: `plugins/` and `plugins.json`. */
const LEGACY_PLUGINS_FOLDER = '.claude-code-ui';
/** Database files: skipped when DATABASE_PATH points elsewhere (the database is not here then). */
const DATABASE_FILES = new Set(['auth.db', 'auth.db-wal', 'auth.db-shm']);

/**
 * The panel's data folder: `MIRAGE_DATA_DIR`, else `~/.mirage`. Mirrors
 * `getMirageDataDir` in shared/utils.ts (see the note at the top).
 */
export function resolveMirageDataDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env.MIRAGE_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir, '.mirage');
}

type LegacyMigrationInput = {
  homeDir: string;
  dataDir: string;
  /** DATABASE_PATH was set explicitly: the legacy database is not copied. */
  databasePathIsExplicit: boolean;
  log(message: string): void;
};

/**
 * First start of Mirage on a machine that ran CloudCLI UI: when the data folder
 * does not exist yet but `~/.cloudcli` or `~/.claude-code-ui` does, their
 * contents are COPIED into it (the old folders are left as they were, so the
 * original panel keeps working and nothing is lost). `~/.cloudcli/*` lands in
 * the data folder itself, `~/.claude-code-ui/plugins{,.json}` beside it.
 * Skipped: the running-server marker, database backups (`auth.db.bak*`) and,
 * with an explicit DATABASE_PATH, the database itself. The copy is built in a
 * temporary folder and renamed into place, so a failure leaves no half-copied
 * data folder. Returns what was copied (empty when nothing was to do).
 *
 * Exported for the bootstrap tests.
 */
export function migrateLegacyDataDirs(input: LegacyMigrationInput): string[] {
  const { homeDir, dataDir, databasePathIsExplicit, log } = input;
  if (fs.existsSync(dataDir)) return [];
  const legacyData = path.join(homeDir, LEGACY_DATA_FOLDER);
  const legacyPlugins = path.join(homeDir, LEGACY_PLUGINS_FOLDER);
  const sources: Array<{ from: string; to: string }> = [];
  if (fs.existsSync(legacyData)) {
    for (const name of fs.readdirSync(legacyData)) {
      if (name === 'local-server.json' || name.startsWith('auth.db.bak')) continue;
      if (databasePathIsExplicit && DATABASE_FILES.has(name)) continue;
      sources.push({ from: path.join(legacyData, name), to: name });
    }
  }
  for (const name of ['plugins', 'plugins.json']) {
    const from = path.join(legacyPlugins, name);
    if (fs.existsSync(from)) sources.push({ from, to: name });
  }
  if (!sources.length) return [];

  const staging = `${dataDir}.migrating-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const source of sources) {
      fs.cpSync(source.from, path.join(staging, source.to), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    }
    fs.renameSync(staging, dataDir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    log(`[mirage] Could not copy the CloudCLI data into ${dataDir}: ${error instanceof Error ? error.message : String(error)}. `
      + 'The old folders are untouched; copy them by hand or remove the new folder and restart.');
    return [];
  }
  const copied = sources.map((source) => source.from);
  log(`[mirage] First start: copied ${copied.join(', ')} into ${dataDir} (the old folders are kept).`);
  return copied;
}
