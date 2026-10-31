import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import type { CommandsCatalogService } from './commands-catalog.service.js';

type CommandsCatalogRouterDependencies = {
  catalogService: CommandsCatalogService;
  /** Resolves a database project id to its absolute directory, or null when unknown. */
  resolveProjectPath: (projectId: string) => string | null;
};

/**
 * Creates the `GET /` router mounted at `/api/commands/catalog`. Exported for the module
 * composition root and route tests. Query: `projectId` (optional) adds project-level
 * commands and skills.
 */
export function createCommandsCatalogRouter(dependencies: CommandsCatalogRouterDependencies): express.Router {
  const router = express.Router();

  router.get('/', asyncHandler(async (request, response) => {
    const projectId = typeof request.query.projectId === 'string' ? request.query.projectId.trim() : '';
    const projectPath = projectId ? dependencies.resolveProjectPath(projectId) : null;
    if (projectId && !projectPath) {
      response.status(404).json({ error: 'Project not found' });
      return;
    }
    response.json(await dependencies.catalogService.getCatalog(projectPath));
  }));

  return router;
}
