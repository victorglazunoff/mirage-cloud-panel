import express from 'express';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

import type { ArtifactsRouteServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { buildArtifactFrameHeaders } from '@/modules/artifacts/services/artifact-view.service.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{16,200}$/;

function invalidRequest(message: string): AppError {
  return new AppError(message, { code: 'INVALID_ARTIFACT_REQUEST', statusCode: 400 });
}

function notFound(message: string): AppError {
  return new AppError(message, { code: 'ARTIFACT_NOT_FOUND', statusCode: 404 });
}

function readMatching(value: unknown, pattern: RegExp, fieldName: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw invalidRequest(`Invalid ${fieldName}`);
  }
  return value;
}

function readOptionalMatching(value: unknown, pattern: RegExp, fieldName: string): string | null {
  if (value === undefined || value === '') {
    return null;
  }
  return readMatching(value, pattern, fieldName);
}

/** Wraps an async handler so its rejection reaches the error middleware (Express 4). */
function asyncRoute(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/**
 * Used by the Artifacts composition root: `GET /:sessionId/artifacts`, mounted
 * at `/api/sessions` behind the panel's token check.
 */
export function createSessionArtifactsRouter(services: ArtifactsRouteServices): Router {
  const router = express.Router();

  router.get('/:sessionId/artifacts', asyncRoute(async (request, response) => {
    const sessionId = readMatching(request.params.sessionId, SESSION_ID_PATTERN, 'sessionId');
    const result = await services.listSessionArtifacts(sessionId);
    if (!result) {
      throw notFound('Session not found');
    }
    response.json(result);
  }));

  return router;
}

/**
 * Used by the Artifacts composition root: the `/api/artifacts` routes.
 *
 * - `GET /:artifactId/view?version=&sessionId=&format=json` — behind
 *   `authenticate` (the panel token, header or `?token=`). Answers with the
 *   frame URL as JSON, or redirects to it, so `<iframe src=".../view?token=…">`
 *   works and the token never stays in the frame's own URL.
 * - `GET /:artifactId/frame/:ticket/*` — public but ticket-guarded: the
 *   Artifact itself, served with the sandboxing CSP.
 */
export function createArtifactsRouter(services: ArtifactsRouteServices, authenticate: RequestHandler): Router {
  const router = express.Router();

  router.get('/:artifactId/view', authenticate, asyncRoute(async (request, response) => {
    const artifactId = readMatching(request.params.artifactId, ARTIFACT_ID_PATTERN, 'artifactId');
    const version = readOptionalMatching(request.query.version, VERSION_PATTERN, 'version');
    const sessionId = readOptionalMatching(request.query.sessionId, SESSION_ID_PATTERN, 'sessionId');

    const ticket = await services.createViewTicket({ artifactId, version, sessionId });
    if (!ticket) {
      throw notFound('Artifact not found');
    }

    response.setHeader('Cache-Control', 'no-store');
    if (request.query.format === 'json') {
      response.json(ticket);
      return;
    }
    response.redirect(302, ticket.url);
  }));

  router.get('/:artifactId/frame/:ticket/*', asyncRoute(async (request, response) => {
    const artifactId = readMatching(request.params.artifactId, ARTIFACT_ID_PATTERN, 'artifactId');
    const ticket = readMatching(request.params.ticket, TICKET_PATTERN, 'ticket');
    // Express has already decoded the wildcard; decoding again would turn a
    // literal "%2e" in a file name into a dot.
    const filePath = (request.params as Record<string, string>)[0] ?? '';

    const frame = await services.renderFrame({ artifactId, ticket, filePath });
    if (!frame) {
      throw notFound('Artifact file not found');
    }

    response.set(buildArtifactFrameHeaders(frame.isDocument));
    response.type(frame.contentType);
    response.send(frame.body);
  }));

  // Registered after the wildcard: without the trailing slash the page's
  // relative links would resolve one level up, outside its ticket.
  router.get('/:artifactId/frame/:ticket', (request, response) => {
    const artifactId = readMatching(request.params.artifactId, ARTIFACT_ID_PATTERN, 'artifactId');
    const ticket = readMatching(request.params.ticket, TICKET_PATTERN, 'ticket');
    response.redirect(302, `${request.baseUrl}/${encodeURIComponent(artifactId)}/frame/${ticket}/`);
  });

  return router;
}
