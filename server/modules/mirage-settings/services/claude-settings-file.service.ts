import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/**
 * Careful access to Claude Code's user settings (`~/.claude/settings.json`).
 *
 * The file belongs to Claude Code and to the user, so a write: reads the
 * current JSON and refuses to touch a file it cannot parse; changes only the
 * keys it was asked to; keeps a timestamped copy next to the file first
 * (`settings.json.mirage-bak-<time>`, never deleted by the panel — a write
 * only happens when a toggle actually changes); and replaces the file
 * atomically (temp file + rename) with its original mode.
 */

const BACKUP_PREFIX = '.mirage-bak-';

type JsonObject = Record<string, unknown>;

/** What a read found; `data` is `{}` when the file is missing or unreadable. */
export type ClaudeSettingsSnapshot = {
  path: string;
  exists: boolean;
  readable: boolean;
  error: string | null;
  data: JsonObject;
};

/** `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. Used by the mirage-settings service. */
export function resolveClaudeSettingsPath(): string {
  const configDirectory = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(configDirectory, 'settings.json');
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestampForFileName(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

/**
 * Creates the file adapter for one settings path. Writes are serialised in
 * process, so two quick toggles cannot interleave their read-modify-write.
 * Used by the mirage-settings service.
 */
export function createClaudeSettingsFile(filePath: string, now: () => number = () => Date.now()) {
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<ClaudeSettingsSnapshot> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        path: filePath,
        exists: code !== 'ENOENT' ? true : false,
        readable: code === 'ENOENT',
        error: code === 'ENOENT' ? null : `Не удалось прочитать файл (${code ?? 'ошибка'}).`,
        data: {},
      };
    }
    try {
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
      if (!isPlainObject(parsed)) {
        return { path: filePath, exists: true, readable: false, error: 'В файле не JSON-объект.', data: {} };
      }
      return { path: filePath, exists: true, readable: true, error: null, data: parsed };
    } catch {
      return { path: filePath, exists: true, readable: false, error: 'Файл не разбирается как JSON.', data: {} };
    }
  }

  async function applyUpdate(mutate: (settings: JsonObject) => void): Promise<{ changed: boolean; backupPath: string | null }> {
    const snapshot = await read();
    if (!snapshot.readable) {
      throw new AppError(
        `~/.claude/settings.json не тронут: ${snapshot.error ?? 'файл не читается'} Исправь файл вручную и повтори.`,
        { code: 'CLAUDE_SETTINGS_UNREADABLE', statusCode: 409 },
      );
    }
    const next = structuredClone(snapshot.data);
    mutate(next);
    if (JSON.stringify(next) === JSON.stringify(snapshot.data)) {
      return { changed: false, backupPath: null };
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let mode = 0o600;
    let backupPath: string | null = null;
    if (snapshot.exists) {
      mode = (await fs.stat(filePath)).mode & 0o777;
      backupPath = `${filePath}${BACKUP_PREFIX}${timestampForFileName(now())}`;
      await fs.copyFile(filePath, backupPath);
      await fs.chmod(backupPath, mode);
    }
    const temporaryPath = `${filePath}.mirage-tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode });
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
    return { changed: true, backupPath };
  }

  return {
    read,
    /** Applies `mutate` to a copy of the current settings and writes it back if anything changed. */
    update(mutate: (settings: JsonObject) => void): Promise<{ changed: boolean; backupPath: string | null }> {
      const run = writeQueue.then(() => applyUpdate(mutate));
      writeQueue = run.catch(() => undefined);
      return run;
    },
  };
}
