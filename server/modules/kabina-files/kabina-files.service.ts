import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { AppError, normalizeProjectPath, resolvePathUnderRoots, WORKSPACES_ROOT } from '@/shared/utils.js';

/** A page of a folder never holds more than this many entries (the screen asks for 200). */
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 200;
/** How many hidden names the footer spells out («скрыто 2: .git, .env»). */
const HIDDEN_NAMES_SHOWN = 4;

/** One entry of a folder page. `childCount` is the folder's own entry count (null for files or unreadable folders). */
type KabinaFileEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  modified: string | null;
  isHidden: boolean;
  isSymlink: boolean;
  childCount: number | null;
};

/** One page of a folder: the entries in display order (folders first) and how many there are in all. */
type KabinaFolderPage = {
  path: string;
  /** The parent folder, or null at the workspace root (the screen cannot go above it). */
  parent: string | null;
  entries: KabinaFileEntry[];
  total: number;
  offset: number;
  hiddenCount: number;
  hiddenNames: string[];
  /** The disk the folder is on: used and total bytes. Null where `statfs` is unavailable. */
  disk: { usedBytes: number; totalBytes: number } | null;
  /** The workspace root and the archive folder, for the screen's «Места» (Сервер, Загрузки, Архив). */
  places: { root: string; archive: string };
};

type KabinaFilesDependencies = {
  /** Root of everything the screen may list (the panel's workspace root, `/root` on the server). */
  workspaceRoot: string;
  /** Where «В архив» moves things (`~/.claude/archive`). */
  archiveRoot: string;
  getProjectPathById(projectId: string): string | null;
  now(): Date;
};

const defaultDependencies: KabinaFilesDependencies = {
  workspaceRoot: WORKSPACES_ROOT,
  archiveRoot: path.join(os.homedir(), '.claude', 'archive'),
  getProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  now: () => new Date(),
};

function notFound(message: string): AppError {
  return new AppError(message, { code: 'KABINA_FILES_NOT_FOUND', statusCode: 404 });
}

function forbidden(message: string): AppError {
  return new AppError(message, { code: 'KABINA_FILES_FORBIDDEN', statusCode: 403 });
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** `name`, then `name (2)`, `name (3)`… — the first one that does not exist yet. */
async function freePath(candidate: string): Promise<string> {
  if (!(await pathExists(candidate))) return candidate;
  const extension = path.extname(candidate);
  const stem = candidate.slice(0, candidate.length - extension.length);
  for (let index = 2; ; index += 1) {
    const next = `${stem} (${index})${extension}`;
    if (!(await pathExists(next))) return next;
  }
}

/**
 * Where a write to `candidate` really lands: its nearest existing ancestor
 * folder resolved through symlinks, plus the parts that do not exist yet
 * (`move` creates them as plain folders). The entry itself is not followed.
 */
async function resolveWriteTarget(candidate: string): Promise<string> {
  const missing: string[] = [path.basename(candidate)];
  let folder = path.dirname(candidate);
  for (;;) {
    const real = await fs.realpath(folder).catch(() => null);
    if (real) return path.join(real, ...missing);
    const up = path.dirname(folder);
    if (up === folder) return candidate;
    missing.unshift(path.basename(folder));
    folder = up;
  }
}

/** `rename`, falling back to copy + remove when the archive sits on another filesystem. */
async function move(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.cp(source, destination, { recursive: true, preserveTimestamps: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

/**
 * The Kabina «Файлы» screen (DarkFiles): folder pages for the lazy tree with
 * honest counts (no silent cut at 10 000 entries, Б13), and «В архив» —
 * moving a file or folder of a project to `~/.claude/archive` instead of
 * deleting it, with a way back.
 */
export function createKabinaFilesService(overrides: Partial<KabinaFilesDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };

  /**
   * The folder, resolved through symlinks, only when it is under the workspace root.
   * `~` names the workspace root itself, so a client that knows no project yet can
   * start there without guessing the server's paths.
   */
  async function resolveListable(folderPath: string): Promise<string> {
    const resolvedRoot = normalizeProjectPath(await fs.realpath(dependencies.workspaceRoot).catch(() => dependencies.workspaceRoot));
    if (folderPath === '~' || normalizeProjectPath(path.resolve(folderPath)) === resolvedRoot) return resolvedRoot;
    const resolved = await resolvePathUnderRoots(folderPath, [dependencies.workspaceRoot]);
    if (!resolved) throw forbidden('Папка вне рабочей области панели');
    return resolved;
  }

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectPath = dependencies.getProjectPathById(projectId);
    if (!projectPath) throw notFound('Проект не найден');
    return normalizeProjectPath(await fs.realpath(projectPath).catch(() => projectPath));
  }

  /** A path of the project (absolute or project-relative), resolved, that is inside it and not the project folder itself. */
  async function resolveInsideProject(projectRoot: string, targetPath: string): Promise<string> {
    const absolute = path.isAbsolute(targetPath) ? targetPath : path.join(projectRoot, targetPath);
    // The entry itself is not followed (a symlink is archived as a link), only its parent folder.
    const parent = await fs.realpath(path.dirname(path.resolve(absolute))).catch(() => null);
    if (!parent) throw notFound('Файл или папка не найдены');
    const resolved = path.join(parent, path.basename(absolute));
    if (!isInside(projectRoot, resolved)) throw forbidden('В архив можно убрать только то, что лежит внутри проекта');
    return resolved;
  }

  async function countEntries(folder: string, showHidden: boolean): Promise<number | null> {
    try {
      const names = await fs.readdir(folder);
      return showHidden ? names.length : names.filter((name) => !name.startsWith('.')).length;
    } catch {
      return null;
    }
  }

  return {
    /** One page of a folder: folders first, then files, by name; hidden entries only when asked for. */
    async listFolder(input: { path: string; offset?: number; limit?: number; showHidden?: boolean }): Promise<KabinaFolderPage> {
      const folder = await resolveListable(input.path);
      let dirents;
      try {
        dirents = await fs.readdir(folder, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTDIR') throw new AppError('Это файл, а не папка', { code: 'NOT_A_DIRECTORY', statusCode: 400 });
        if (code === 'EACCES' || code === 'EPERM') throw forbidden('Нет доступа к папке');
        throw notFound('Папка не найдена');
      }

      const hidden = dirents.filter((entry) => entry.name.startsWith('.'));
      const visible = input.showHidden ? dirents : dirents.filter((entry) => !entry.name.startsWith('.'));
      const sorted = visible.sort((left, right) => {
        const leftDir = left.isDirectory();
        const rightDir = right.isDirectory();
        if (leftDir !== rightDir) return leftDir ? -1 : 1;
        return left.name.localeCompare(right.name, 'ru');
      });
      const offset = Math.max(0, input.offset ?? 0);
      const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, input.limit ?? DEFAULT_PAGE_SIZE));
      const page = sorted.slice(offset, offset + limit);

      const entries = await Promise.all(page.map(async (entry): Promise<KabinaFileEntry> => {
        const entryPath = path.join(folder, entry.name);
        let size = 0;
        let modified: string | null = null;
        let isSymlink = false;
        let isDirectory = entry.isDirectory();
        try {
          const stats = await fs.lstat(entryPath);
          size = stats.size;
          modified = stats.mtime.toISOString();
          isSymlink = stats.isSymbolicLink();
          if (isSymlink) isDirectory = (await fs.stat(entryPath).catch(() => null))?.isDirectory() ?? false;
        } catch {
          // An entry that vanished or cannot be read still shows by name.
        }
        return {
          name: entry.name,
          path: entryPath,
          type: isDirectory ? 'directory' : 'file',
          size: isDirectory ? 0 : size,
          modified,
          isHidden: entry.name.startsWith('.'),
          isSymlink,
          childCount: isDirectory ? await countEntries(entryPath, Boolean(input.showHidden)) : null,
        };
      }));

      let disk: KabinaFolderPage['disk'] = null;
      try {
        const stats = await fs.statfs(folder);
        const totalBytes = stats.blocks * stats.bsize;
        disk = { totalBytes, usedBytes: totalBytes - stats.bfree * stats.bsize };
      } catch {
        // statfs is missing on some platforms; the screen then hides the disk gauge.
      }

      const resolvedRoot = normalizeProjectPath(await fs.realpath(dependencies.workspaceRoot).catch(() => dependencies.workspaceRoot));
      return {
        path: folder,
        parent: folder === resolvedRoot ? null : path.dirname(folder),
        entries,
        total: sorted.length,
        offset,
        hiddenCount: hidden.length,
        hiddenNames: hidden.map((entry) => entry.name).sort().slice(0, HIDDEN_NAMES_SHOWN),
        disk,
        places: { root: resolvedRoot, archive: dependencies.archiveRoot },
      };
    },

    /**
     * «В архив»: moves a file or folder of the project to
     * `<archive>/files/<date>/<project folder>/<path in project>`; nothing is deleted.
     */
    async archiveEntry(input: { projectId: string; path: string }): Promise<{ originalPath: string; archivedPath: string }> {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const source = await resolveInsideProject(projectRoot, input.path);
      if (!(await pathExists(source))) throw notFound('Файл или папка не найдены');
      const day = dependencies.now().toISOString().slice(0, 10);
      const relative = path.relative(projectRoot, source);
      const destination = await freePath(path.join(dependencies.archiveRoot, 'files', day, path.basename(projectRoot), relative));
      await move(source, destination);
      return { originalPath: source, archivedPath: destination };
    },

    /** «Вернуть»: moves an archived entry back to where it was, if that place is still free. */
    async restoreEntry(input: { projectId: string; archivedPath: string; originalPath: string }): Promise<{ restoredPath: string }> {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const archiveFiles = path.join(dependencies.archiveRoot, 'files');
      const archived = path.resolve(input.archivedPath);
      if (!isInside(archiveFiles, archived)) throw forbidden('Вернуть можно только из архива панели');
      if (!(await pathExists(archived))) throw notFound('В архиве этого уже нет');
      // A symlinked folder in the way must not carry the entry out of the project.
      const original = await resolveWriteTarget(path.resolve(input.originalPath));
      if (!isInside(projectRoot, original)) throw forbidden('Вернуть можно только внутрь проекта');
      if (await pathExists(original)) {
        throw new AppError('На этом месте уже есть файл с таким именем', { code: 'KABINA_FILES_TARGET_EXISTS', statusCode: 409 });
      }
      await move(archived, original);
      return { restoredPath: original };
    },
  };
}

/** Used by the kabina-files routes (`/api/kabina-files`). */
export const kabinaFilesService = createKabinaFilesService();
