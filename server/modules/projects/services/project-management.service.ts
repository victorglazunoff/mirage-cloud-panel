import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import type {
  CreateProjectPathResult,
  ProjectRepositoryRow,
  WorkspacePathValidationResult,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';

type CreateProjectInput = {
  projectPath: string;
  customName?: string | null;
};

type CreateProjectDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  ensureWorkspaceDirectory: (projectPath: string) => Promise<void>;
  persistProjectPath: (projectPath: string, customName: string | null) => CreateProjectPathResult;
  getProjectByPath: (projectPath: string) => ProjectRepositoryRow | null;
};

type ProjectApiView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  customName: string | null;
  isArchived: boolean;
  isStarred: boolean;
  sessions: [];
  sessionMeta: {
    hasMore: false;
    total: 0;
  };
};

type CreateProjectServiceResult = {
  outcome: 'created' | 'reactivated_archived';
  project: ProjectApiView;
};

const defaultDependencies: CreateProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureWorkspaceDirectory: async (projectPath: string): Promise<void> => {
    await fs.mkdir(projectPath, { recursive: true });
    const directoryStats = await fs.stat(projectPath);
    if (!directoryStats.isDirectory()) {
      throw new AppError('Path exists but is not a directory', {
        code: 'PROJECT_PATH_NOT_DIRECTORY',
        statusCode: 400,
      });
    }
  },
  persistProjectPath: (projectPath: string, customName: string | null): CreateProjectPathResult =>
    projectsDb.createProjectPath(projectPath, customName),
  getProjectByPath: (projectPath: string): ProjectRepositoryRow | null =>
    projectsDb.getProjectPath(projectPath),
};

function resolveDisplayName(customName: string | null | undefined, projectPath: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  return path.basename(projectPath) || projectPath;
}

function mapProjectRowToApiView(projectRow: ProjectRepositoryRow): ProjectApiView {
  return {
    projectId: projectRow.project_id,
    path: projectRow.project_path,
    fullPath: projectRow.project_path,
    displayName: resolveDisplayName(projectRow.custom_project_name, projectRow.project_path),
    customName: projectRow.custom_project_name,
    isArchived: Boolean(projectRow.isArchived),
    isStarred: Boolean(projectRow.isStarred),
    sessions: [],
    sessionMeta: {
      hasMore: false,
      total: 0,
    },
  };
}

/**
 * Mirage (DarkProjects wizard): `~` and `~/…` mean the server user's home, the
 * way the folder browser already reads them.
 */
function expandHomePrefix(projectPath: string): string {
  const trimmed = projectPath.trim();
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** What the "New project" wizard learns about a folder before creating it. */
type ProjectPathCheck = {
  valid: boolean;
  code: string | null;
  title: string | null;
  reason: string | null;
  resolvedPath: string | null;
  exists: boolean;
  existingProject: { projectId: string; displayName: string; isArchived: boolean } | null;
};

/**
 * Checks a folder for the "New project" wizard without creating anything
 * (Mirage, Б18): the policy refusal with its human reason, whether the folder
 * exists, and whether the panel already has a project on it.
 *
 * Used by the projects routes (`GET /api/projects/validate-path`).
 */
export async function checkProjectPath(
  projectPath: string,
  dependencies: Pick<CreateProjectDependencies, 'validatePath' | 'getProjectByPath'> = defaultDependencies,
): Promise<ProjectPathCheck> {
  const normalizedPath = normalizeProjectPath(expandHomePrefix(projectPath || ''));
  const validation = await dependencies.validatePath(normalizedPath);
  if (!validation.valid || !validation.resolvedPath) {
    return {
      valid: false,
      code: validation.code ?? 'WORKSPACE_PATH_CHECK_FAILED',
      title: validation.title ?? 'Папка не подходит',
      reason: validation.reason ?? validation.error ?? null,
      resolvedPath: null,
      exists: false,
      existingProject: null,
    };
  }

  const resolvedPath = normalizeProjectPath(validation.resolvedPath);
  let exists = false;
  try {
    exists = (await fs.stat(resolvedPath)).isDirectory();
  } catch {
    // A missing folder is fine: the wizard creates it.
  }

  const existingRow = dependencies.getProjectByPath(resolvedPath);
  return {
    valid: true,
    code: null,
    title: null,
    reason: null,
    resolvedPath,
    exists,
    existingProject: existingRow
      ? {
          projectId: existingRow.project_id,
          displayName: resolveDisplayName(existingRow.custom_project_name, existingRow.project_path),
          isArchived: Boolean(existingRow.isArchived),
        }
      : null,
  };
}

export async function createProject(
  input: CreateProjectInput,
  dependencies: CreateProjectDependencies = defaultDependencies,
): Promise<CreateProjectServiceResult> {
  const normalizedPath = normalizeProjectPath(expandHomePrefix(input.projectPath || ''));
  if (!normalizedPath) {
    throw new AppError('path is required', {
      code: 'PROJECT_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    // Mirage (Б18): `details` carries the human reason, which the wizard
    // already shows verbatim; `message` is the short Russian title.
    throw new AppError(pathValidation.title ?? 'Invalid project path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: pathValidation.reason ?? pathValidation.error ?? 'Path validation failed',
    });
  }

  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);
  await dependencies.ensureWorkspaceDirectory(resolvedProjectPath);

  const normalizedCustomName = resolveDisplayName(input.customName ?? null, resolvedProjectPath);
  const persistedProject = dependencies.persistProjectPath(resolvedProjectPath, normalizedCustomName);

  if (persistedProject.outcome === 'active_conflict') {
    throw new AppError('Project path already exists and is active', {
      code: 'PROJECT_ALREADY_EXISTS',
      statusCode: 409,
      details: `Project path already exists: ${resolvedProjectPath}`,
    });
  }

  const projectRow = persistedProject.project ?? dependencies.getProjectByPath(resolvedProjectPath);
  if (!projectRow) {
    throw new AppError('Failed to resolve project after creation', {
      code: 'PROJECT_CREATE_FAILED',
      statusCode: 500,
    });
  }

  // Archived rows intentionally remain archived when reused, as requested.
  return {
    outcome: persistedProject.outcome,
    project: mapProjectRowToApiView(projectRow),
  };
}

/**
 * Sets `projects.custom_project_name` for the given `projectId` (or clears it when empty).
 */
export function updateProjectDisplayName(projectId: string, newDisplayName: unknown): void {
  const trimmed = typeof newDisplayName === 'string' ? newDisplayName.trim() : '';
  projectsDb.updateCustomProjectNameById(projectId, trimmed.length > 0 ? trimmed : null);
}
