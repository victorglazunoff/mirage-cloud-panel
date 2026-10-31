import path from 'node:path';

import ignore from 'ignore';

import type {
  FileTreeDirectoryEntry,
  FileTreeListing,
  FileTreeNode,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import {
  AppError,
  FORBIDDEN_WORKSPACE_PATHS,
  normalizeProjectPath,
  resolvePathUnderRoots,
} from '@/shared/utils.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// File Tree consumes this guard when recursively listing a project so a very
// broad workspace (for example, a user's home directory) cannot exhaust the
// server heap before the browser has a chance to switch to a narrower project.
const MAXIMUM_FILE_TREE_ENTRIES = 10_000;

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => boolean;

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): boolean {
  return !isDirectory || !HARD_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath));
}

function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): boolean {
  return includeEntryByHardExclusions(entryPath, isDirectory)
    && (!isDirectory || !IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)));
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

/**
 * Mirage: one uploaded file whose name is already taken in the target folder (or by an earlier
 * file of the same upload). `name` is the relative path as sent, `suggestedName` the same path
 * with the first free «name (N).ext». The «Файлы» screen offers it for editing.
 */
type UploadNameConflict = { index: number; name: string; suggestedName: string };

/** Mirage: «README.md» → «README (2).md», «.env» → «.env (2)», «docs» → «docs (2)». */
function numberedFileName(fileName: string, copyNumber: number): string {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${stem} (${copyNumber})${extension}`;
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  if (!resolvedPath.startsWith(normalizedProjectRoot)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

function createGitignoreEntryFilter(
  projectRoot: string,
  gitignoreContent: string,
): FileTreeEntryFilter {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    if (!includeEntryByHardExclusions(entryPath, isDirectory)) return false;

    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    return !gitignore.ignores(matchPath);
  };
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  /**
   * Streams one directory and keeps at most `limit` of the entries the tree will show.
   *
   * Entries are filtered first, so ignored entries never count. Reading stops at
   * `limit + 1` visible entries (the extra one only proves the directory has
   * more), so a pathologically large directory is never read into memory in full.
   */
  async function collectVisibleEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    limit: number,
  ): Promise<{ entries: FileTreeDirectoryEntry[]; hasMore: boolean }> {
    const visibleEntries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        if (!includeEntry(path.join(directoryPath, entry.name), entry.isDirectory())) {
          continue;
        }
        if (visibleEntries.length >= limit) {
          // Leaving the loop closes the directory stream.
          return { entries: visibleEntries, hasMore: true };
        }
        visibleEntries.push(entry);
      }
    } catch (error) {
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return { entries: [], hasMore: false };
    } finally {
      release();
    }

    return { entries: visibleEntries, hasMore: false };
  }

  async function describeEntry(directoryPath: string, entry: FileTreeDirectoryEntry): Promise<FileTreeNode> {
    const itemPath = path.join(directoryPath, entry.name);
    const item: FileTreeNode = {
      name: entry.name,
      path: itemPath,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: 0,
      modified: null,
      permissions: '000',
      permissionsRwx: '---------',
    };

    try {
      await acquire();
      try {
        const stats = await fileSystem.lstat(itemPath);
        const ownerPermissions = (stats.mode >> 6) & 7;
        const groupPermissions = (stats.mode >> 3) & 7;
        const otherPermissions = stats.mode & 7;

        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
        item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
          + permissionBitsToRwx(groupPermissions)
          + permissionBitsToRwx(otherPermissions);
        if (stats.isSymbolicLink()) {
          item.isSymlink = true;
        }
      } finally {
        release();
      }
    } catch {
      // Metadata failures should not hide an otherwise readable tree entry.
    }

    return item;
  }

  /**
   * Lists a directory tree breadth-first under one shared entry budget
   * (`MAXIMUM_FILE_TREE_ENTRIES`), so a very broad project (or a home
   * directory) cannot exhaust the server heap.
   *
   * Mirage: a tree over the budget used to fail with 413 and the browser got
   * nothing — no file tree, no @-mentions. Now the walk keeps what fits: every
   * level is listed in tree order before the next one, so the top of the
   * project is always complete and only the deepest folders are cut. A folder
   * whose listing was cut or never read carries `childrenTruncated`, and the
   * result says `truncated`, which the route turns into a response header.
   */
  async function buildFileTree(
    rootPath: string,
    maximumDepth: number,
    includeEntry: FileTreeEntryFilter = includeEntryByFallbackDirectoryNames,
  ): Promise<FileTreeListing> {
    type PendingDirectory = { directoryPath: string; depth: number; owner: FileTreeNode | null; target: FileTreeNode[] };
    const tree: FileTreeNode[] = [];
    let remaining = MAXIMUM_FILE_TREE_ENTRIES;
    let truncated = false;
    let level: PendingDirectory[] = [{ directoryPath: rootPath, depth: 0, owner: null, target: tree }];
    // Folders read at once: each may hold up to the whole remaining budget in memory.
    const readBatchSize = Math.min(concurrencyLimit, 16);

    const markCut = (pending: PendingDirectory) => {
      truncated = true;
      if (pending.owner) {
        pending.owner.childrenTruncated = true;
      }
    };

    while (level.length > 0) {
      const nextLevel: PendingDirectory[] = [];
      // A few folders are read at once; the budget is charged afterwards in tree
      // order, so which folders get cut never depends on which read finished first.
      for (let start = 0; start < level.length; start += readBatchSize) {
        const batch = level.slice(start, start + readBatchSize);
        const budgetAtStart = remaining;
        const listings = await Promise.all(batch.map((pending) => (
          budgetAtStart > 0
            ? collectVisibleEntries(pending.directoryPath, includeEntry, budgetAtStart)
            : Promise.resolve({ entries: [], hasMore: true })
        )));

        for (let index = 0; index < batch.length; index += 1) {
          const pending = batch[index];
          const listing = listings[index];
          const kept = listing.entries.slice(0, Math.max(0, remaining));
          remaining -= kept.length;
          if (listing.hasMore || kept.length < listing.entries.length) {
            markCut(pending);
          }
          if (kept.length === 0) {
            if (pending.owner?.childrenTruncated) {
              // Never read: no children rather than a folder that looks empty.
              delete pending.owner.children;
            }
            continue;
          }

          const items = await Promise.all(kept.map((entry) => describeEntry(pending.directoryPath, entry)));
          items.sort((left, right) => {
            if (left.type !== right.type) {
              return left.type === 'directory' ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
          });
          pending.target.push(...items);

          if (pending.depth >= maximumDepth) {
            continue;
          }
          for (const item of items) {
            // Skip recursing into pseudo-filesystems and other system-critical
            // directories (e.g. /proc, /sys) — they're never valid project roots,
            // and /proc in particular can contain thousands of virtual entries
            // that make traversal from a broad root (e.g. "/") pathologically slow.
            if (item.type !== 'directory' || FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(item.path))) {
              continue;
            }
            item.children = [];
            nextLevel.push({ directoryPath: item.path, depth: pending.depth + 1, owner: item, target: item.children });
          }
        }
      }
      level = nextLevel;
    }

    return { tree, truncated, limit: MAXIMUM_FILE_TREE_ENTRIES };
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.reason ?? validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a path the viewer is allowed to read.
   *
   * A file reference in a transcript is normally inside the project, but a
   * background command's log lives in the system temp directory and a
   * background agent's output file is a link from there into the Claude
   * projects directory, and the transcript quotes those paths verbatim. Those
   * resolve through the read-only root policy instead of the project root.
   *
   * The agent may also point at a file in another folder of the workspace, the
   * same tree `browseWorkspace` lists, so anything under the workspace root is
   * readable too. Symlinks are resolved before that comparison. The writing
   * endpoints keep using `resolvePathInsideProject` alone, so nothing outside
   * the project can be changed.
   */
  async function resolveReadablePath(projectRoot: string, targetPath: string): Promise<string> {
    if (path.isAbsolute(targetPath)) {
      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
      if (readOnlyPath) {
        return readOnlyPath;
      }

      const workspacePath = await resolvePathUnderRoots(targetPath, [dependencies.workspace.rootPath]);
      if (workspacePath) {
        return workspacePath;
      }
    }

    return resolvePathInsideProject(projectRoot, targetPath);
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  /** Mirage: anything at the path — file, folder, even a dangling link — takes the name. */
  async function entryExists(candidatePath: string): Promise<boolean> {
    try {
      await fileSystem.lstat(candidatePath);
      return true;
    } catch (error) {
      const errorCode = readErrorCode(error);
      if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') return false;
      throw error;
    }
  }

  /**
   * Mirage: the first «name (N).ext» (N from 2) of the relative path `fileName` that is free on
   * disk under `targetDirectory` and not in `claimedPaths` (destinations of the same upload).
   */
  async function suggestFreeUploadName(
    fileName: string,
    targetDirectory: string,
    claimedPaths: Set<string>,
  ): Promise<string> {
    const folder = path.dirname(fileName);
    const baseName = path.basename(fileName);
    for (let copyNumber = 2; ; copyNumber += 1) {
      const numberedName = numberedFileName(baseName, copyNumber);
      const candidateName = folder === '.' ? numberedName : path.join(folder, numberedName);
      const candidatePath = path.join(targetDirectory, candidateName);
      if (!claimedPaths.has(candidatePath) && !(await entryExists(candidatePath))) {
        return candidateName;
      }
    }
  }

  /**
   * Mirage: the uploaded files whose destination already exists or was already claimed by an
   * earlier file of the same upload, each with a free name that collides with neither.
   */
  async function findUploadNameConflicts(
    plannedFiles: Array<{ file: FileTreeUploadedFile; fileName: string; destinationPath: string }>,
    requestFiles: FileTreeUploadedFile[],
    targetDirectory: string,
  ): Promise<UploadNameConflict[]> {
    const claimedPaths = new Set(plannedFiles.map((planned) => planned.destinationPath));
    const seenPaths = new Set<string>();
    const conflicts: UploadNameConflict[] = [];
    for (const { file, fileName, destinationPath } of plannedFiles) {
      const isTaken = seenPaths.has(destinationPath) || await entryExists(destinationPath);
      seenPaths.add(destinationPath);
      if (!isTaken) continue;
      const suggestedName = await suggestFreeUploadName(fileName, targetDirectory, claimedPaths);
      // The next conflict must not be offered the same free name.
      claimedPaths.add(path.join(targetDirectory, suggestedName));
      conflicts.push({ index: requestFiles.indexOf(file), name: fileName, suggestedName });
    }
    return conflicts;
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const { tree: fileTree } = await buildFileTree(resolvedPath, 1);
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.reason ?? validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listProjectFiles(projectId, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      let includeEntry: FileTreeEntryFilter | undefined;
      if (options?.respectGitignore) {
        try {
          const gitignoreContent = await fileSystem.readTextFile(path.join(projectRoot, '.gitignore'));
          includeEntry = createGitignoreEntryFilter(projectRoot, gitignoreContent);
        } catch (error) {
          if (readErrorCode(error) !== 'ENOENT') {
            dependencies.logger.error(`Error reading .gitignore in "${projectRoot}"`, error);
          }
        }
      }

      return buildFileTree(projectRoot, 10, includeEntry);
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        // Mirage: the project root given as an absolute path («Файлы» sends absolute folders) is
        // the root itself; `resolvePathInsideProject` only accepts paths strictly below it.
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          || path.resolve(projectRoot, input.targetPath) === path.resolve(projectRoot)
          ? path.resolve(projectRoot)
          : resolvePathInsideProject(projectRoot, input.targetPath);

        const plannedFiles: Array<{ file: FileTreeUploadedFile; fileName: string; destinationPath: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }
          plannedFiles.push({ file, fileName, destinationPath });
        }

        // Mirage: an upload never replaces anything. Every name is checked before the first file
        // is written, so a refused upload leaves the folder exactly as it was.
        const conflicts = await findUploadNameConflicts(plannedFiles, input.files, resolvedTargetDirectory);
        if (conflicts.length > 0) {
          const folderLabel = `${path.basename(resolvedTargetDirectory)}/`;
          throw new AppError(
            conflicts.length === 1
              ? `"${conflicts[0].name}" is already in ${folderLabel} — upload it under another name`
              : `${conflicts.length} files are already in ${folderLabel} — upload them under other names`,
            { statusCode: 409, code: 'FILE_EXISTS', details: { targetPath: resolvedTargetDirectory, conflicts } },
          );
        }

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (const { file, fileName, destinationPath } of plannedFiles) {
          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          // Mirage: the copy itself refuses an existing destination (a file that appeared after
          // the check above), so even a race cannot overwrite.
          try {
            await fileSystem.copyFile(file.temporaryPath, destinationPath);
          } catch (error) {
            if (readErrorCode(error) !== 'EEXIST') throw error;
            throw new AppError(`"${fileName}" appeared in ${path.basename(resolvedTargetDirectory)}/ during the upload`, {
              statusCode: 409,
              code: 'FILE_EXISTS',
              details: {
                targetPath: resolvedTargetDirectory,
                conflicts: [{
                  index: input.files.indexOf(file),
                  name: fileName,
                  suggestedName: await suggestFreeUploadName(fileName, resolvedTargetDirectory, new Set()),
                }],
              },
            });
          }
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
