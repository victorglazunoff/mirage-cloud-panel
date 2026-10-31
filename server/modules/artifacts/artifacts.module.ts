import path from 'node:path';

import { authenticateToken } from '@/modules/auth/index.js';
import { getDatabasePath, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { createArtifactsRouter, createSessionArtifactsRouter } from '@/modules/artifacts/artifacts.routes.js';
import { createArtifactsService } from '@/modules/artifacts/services/artifacts.service.js';

/**
 * Where Artifact copies are kept: `MIRAGE_ARTIFACTS_DIR`, else `artifacts/`
 * beside the panel database (`~/.mirage/artifacts`). A test instance with
 * its own database copy therefore gets its own store.
 */
function resolveArtifactsStoreRoot(): string {
  return process.env.MIRAGE_ARTIFACTS_DIR || path.join(path.dirname(getDatabasePath()), 'artifacts');
}

const artifactsService = createArtifactsService({
  storeRoot: resolveArtifactsStoreRoot,
  getSession: (sessionId) => {
    const session = sessionsDb.getSessionById(sessionId);
    return session
      ? { provider: session.provider, jsonlPath: session.jsonl_path, projectPath: session.project_path }
      : null;
  },
  listProjectPaths: () => projectsDb.getProjectPaths().map((project) => project.project_path),
  publishToRun: (sessionId, event) => chatRunRegistry.publishToRun(sessionId, event),
});

/** Mounted by the server entrypoint at `/api/sessions` behind `authenticateToken`. */
export const sessionArtifactsRoutes = createSessionArtifactsRouter(artifactsService);

/** Mounted by the server entrypoint at `/api/artifacts`; the view route checks the token itself, the frame a ticket. */
export const artifactsRoutes = createArtifactsRouter(artifactsService, authenticateToken);

/**
 * Called once by the server entrypoint: starts keeping a copy of every
 * Artifact published in a live turn and announcing it as `artifact_published`.
 */
export function initializeArtifactsLiveCapture(): () => void {
  return chatRunRegistry.addLiveEventListener(artifactsService.handleLiveEvent);
}
