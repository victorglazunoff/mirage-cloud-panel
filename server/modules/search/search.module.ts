import os from 'node:os';
import path from 'node:path';

import { commandsCatalogService } from '@/modules/commands-catalog/index.js';
import { projectsDb, sessionsDb } from '@/modules/database/index.js';

import { listProjectFilesWithRipgrep, searchDialogsWithRipgrep } from './search-ripgrep.js';
import { createSearchRouter } from './search.routes.js';
import { createSearchService } from './search.service.js';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const searchService = createSearchService({
  listProjects: () => projectsDb.getProjectPaths().map((row) => ({
    projectId: row.project_id,
    path: row.project_path,
    displayName: row.custom_project_name?.trim() || path.basename(row.project_path),
    isStarred: Boolean(row.isStarred),
  })),
  findSession: (providerSessionId) => {
    const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
    return row
      ? {
          sessionId: row.session_id,
          provider: row.provider,
          title: row.custom_name,
          projectPath: row.project_path,
          lastActivity: row.updated_at ?? row.created_at ?? null,
        }
      : null;
  },
  getCatalog: () => commandsCatalogService.getCatalog(null),
  searchDialogs: (query, options) => searchDialogsWithRipgrep(query, { rootDir: CLAUDE_PROJECTS_DIR, ...options }),
  listFiles: (projectPath, timeoutMs) => listProjectFilesWithRipgrep(projectPath, { maxFiles: 30_000, timeoutMs }),
  now: Date.now,
});

/** Search router assembled for the authenticated server mount. */
export const searchRoutes = createSearchRouter({ searchService });
