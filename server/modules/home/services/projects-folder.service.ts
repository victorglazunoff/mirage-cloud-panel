import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeProjectPath, resolvePathUnderRoots, WORKSPACES_ROOT } from '@/shared/utils.js';

/** Counting stops here: the wizard only needs "214 файлов", not an exact count of a huge tree. */
const FILE_COUNT_CAP = 1000;
/** Folders that are build output or dependencies, never "the project's files". */
const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt', '.cache',
  '__pycache__', '.venv', 'venv', 'vendor', 'target', 'coverage',
]);
/** Folder summaries are cached briefly: the board is polled and folders change rarely. */
const SUMMARY_TTL_MS = 60_000;

/** A folder as the "New project" wizard describes it: how many files and which git branch. */
type FolderSummary = {
  name: string;
  path: string;
  /** Files below the folder (dependencies and build output skipped), capped at `FILE_COUNT_CAP`. */
  fileCount: number;
  fileCountCapped: boolean;
  isGit: boolean;
  /** Current branch from `.git/HEAD`; null when detached or not a repository. */
  gitBranch: string | null;
  /** Last change of the folder or one of its own entries (UTC ISO): the wizard lists the liveliest first. */
  modifiedAt: string | null;
};

type ProjectsFolder = {
  /** The folder holding most projects (e.g. `~/Documents/Claude Code/Проекты`). */
  path: string;
  /** Its sub-folders that are not projects of the panel yet, most recently changed first. */
  unadded: FolderSummary[];
};

async function countFiles(root: string): Promise<{ count: number; capped: boolean }> {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) pending.push(path.join(directory, entry.name));
        continue;
      }
      count += 1;
      if (count >= FILE_COUNT_CAP) return { count, capped: true };
    }
  }
  return { count, capped: false };
}

/** Latest mtime of the folder and its direct entries (dependencies skipped); null when unreadable. */
async function readLastChange(folder: string): Promise<string | null> {
  try {
    const own = await fs.stat(folder);
    let latest = own.mtimeMs;
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const stats = await Promise.all(entries
      .filter((entry) => !SKIPPED_DIRECTORY_NAMES.has(entry.name))
      .map((entry) => fs.stat(path.join(folder, entry.name)).catch(() => null)));
    for (const stat of stats) {
      if (stat && stat.mtimeMs > latest) latest = stat.mtimeMs;
    }
    return new Date(latest).toISOString();
  } catch {
    return null;
  }
}

async function readGitBranch(folder: string): Promise<{ isGit: boolean; branch: string | null }> {
  try {
    const head = await fs.readFile(path.join(folder, '.git', 'HEAD'), 'utf8');
    const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
    return { isGit: true, branch: match ? match[1] : null };
  } catch {
    try {
      await fs.access(path.join(folder, '.git'));
      return { isGit: true, branch: null };
    } catch {
      return { isGit: false, branch: null };
    }
  }
}

/**
 * The parent folder most registered projects live in. With fewer than two
 * projects sharing a parent there is no "projects folder" to suggest from.
 */
function findProjectsFolder(projectPaths: string[]): string | null {
  const counts = new Map<string, number>();
  for (const projectPath of projectPaths) {
    const parent = path.dirname(normalizeProjectPath(projectPath));
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 1;
  for (const [parent, count] of counts) {
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Builds the folder facts of the projects board and the wizard: which folders
 * of the projects folder are not in the panel yet, and what a folder holds.
 */
export function createProjectsFolderService() {
  const summaryCache = new Map<string, { at: number; summary: FolderSummary }>();

  async function summarize(folder: string): Promise<FolderSummary> {
    const cached = summaryCache.get(folder);
    if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.summary;
    const [{ count, capped }, git, modifiedAt] = await Promise.all([countFiles(folder), readGitBranch(folder), readLastChange(folder)]);
    const summary: FolderSummary = {
      name: path.basename(folder),
      path: folder,
      fileCount: count,
      fileCountCapped: capped,
      isGit: git.isGit,
      gitBranch: git.branch,
      modifiedAt,
    };
    summaryCache.set(folder, { at: Date.now(), summary });
    return summary;
  }

  return {
    /** Sub-folders of the projects folder that no project (active or archived) points at. */
    async describeProjectsFolder(projectPaths: string[]): Promise<ProjectsFolder | null> {
      const folder = findProjectsFolder(projectPaths);
      if (!folder) return null;
      const registered = new Set(projectPaths.map((projectPath) => normalizeProjectPath(projectPath)));
      let entries;
      try {
        entries = await fs.readdir(folder, { withFileTypes: true });
      } catch {
        return null;
      }
      const candidates = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => normalizeProjectPath(path.join(folder, entry.name)))
        .filter((candidate) => !registered.has(candidate))
        .sort((left, right) => left.localeCompare(right));
      const summaries = await Promise.all(candidates.map((candidate) => summarize(candidate)));
      // «По активности»: the folder touched last comes first; ties keep the name order.
      const unadded = summaries
        .map((summary, index) => ({ summary, index }))
        .sort((left, right) => (right.summary.modifiedAt ?? '').localeCompare(left.summary.modifiedAt ?? '') || left.index - right.index)
        .map(({ summary }) => summary);
      return { path: folder, unadded };
    },

    /**
     * Facts about one folder the wizard was given. Only folders under the
     * workspace root are looked at; anything else answers null.
     */
    async describeFolder(folderPath: string): Promise<FolderSummary | null> {
      const resolved = await resolvePathUnderRoots(folderPath, [WORKSPACES_ROOT]);
      if (!resolved) return null;
      try {
        if (!(await fs.stat(resolved)).isDirectory()) return null;
      } catch {
        return null;
      }
      return summarize(normalizeProjectPath(resolved));
    },
  };
}

/** Used by the home routes for `GET /api/home/projects` and `GET /api/home/folder-info`. */
export const projectsFolderService = createProjectsFolderService();
