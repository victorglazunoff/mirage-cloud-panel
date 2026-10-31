import * as fs from 'node:fs/promises';
import os from 'node:os';

import { projectsDb } from '@/modules/database/index.js';

import { createCommandsCatalogRouter } from './commands-catalog.routes.js';
import { createCommandsCatalogService } from './commands-catalog.service.js';

/** Catalog service shared with the Search module (command hits) and the router below. */
export const commandsCatalogService = createCommandsCatalogService({
  fileSystem: fs,
  homeDirectory: os.homedir,
});

/** Catalog router assembled for the authenticated server mount. */
export const commandsCatalogRoutes = createCommandsCatalogRouter({
  catalogService: commandsCatalogService,
  resolveProjectPath: (projectId) => projectsDb.getProjectPathById(projectId),
});
