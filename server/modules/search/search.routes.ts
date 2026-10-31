import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import { parseSearchRequest } from './search.service.js';
import type { SearchService } from './search.service.js';

type SearchRouterDependencies = {
  searchService: SearchService;
};

/**
 * Creates the router mounted at `/api/search`. Exported for the module composition root
 * and route tests. `GET /?q=&types=project,session,file,command,action&limit=&projectId=`;
 * `limit` is per group (default 8, max 50).
 */
export function createSearchRouter(dependencies: SearchRouterDependencies): express.Router {
  const router = express.Router();

  router.get('/', asyncHandler(async (request, response) => {
    const searchRequest = parseSearchRequest(request.query);
    const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : null;
    response.json(await dependencies.searchService.search(searchRequest, { projectId }));
  }));

  return router;
}
