import express from 'express';
import type { Request, Response } from 'express';

import { agentsLiveService } from '@/modules/agents-live/services/agents-live.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import type { LiveAgentsActionResult, ProviderPermissionDecision } from '@/shared/types.js';

function readPathId(value: unknown, name: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 200) {
    throw new AppError(`A ${name} is required.`, { code: 'INVALID_ID', statusCode: 400 });
  }
  return id;
}

/**
 * Parses the body of POST /permissions/:requestId into the runtime's decision
 * shape. `allow` must be an explicit boolean so a malformed body never
 * approves a tool. Exported for the route tests.
 */
export function readPermissionDecision(body: unknown): ProviderPermissionDecision {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (typeof record.allow !== 'boolean') {
    throw new AppError('Field "allow" (boolean) is required.', { code: 'INVALID_DECISION', statusCode: 400 });
  }
  return {
    allow: record.allow,
    message: typeof record.message === 'string' ? record.message : undefined,
    rememberEntry: typeof record.rememberEntry === 'string' ? record.rememberEntry : undefined,
  };
}

/** Action failures are answered 409 with the reason; the body shape stays the same. */
function sendActionResult(res: Response, result: LiveAgentsActionResult): void {
  res.status(result.ok ? 200 : 409).json(createApiSuccessResponse(result));
}

const router = express.Router();

router.get(
  '/live',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await agentsLiveService.getSnapshot()));
  }),
);

router.post(
  '/sessions/:sessionId/stop',
  asyncHandler(async (req: Request, res: Response) => {
    sendActionResult(res, await agentsLiveService.stopSession(readPathId(req.params.sessionId, 'session id')));
  }),
);

router.post(
  '/sessions/:sessionId/agents/:agentId/stop',
  asyncHandler(async (req: Request, res: Response) => {
    sendActionResult(res, await agentsLiveService.stopAgent(
      readPathId(req.params.sessionId, 'session id'),
      readPathId(req.params.agentId, 'agent id'),
    ));
  }),
);

router.post(
  '/permissions/:requestId',
  asyncHandler(async (req: Request, res: Response) => {
    sendActionResult(res, agentsLiveService.answerPermission(
      readPathId(req.params.requestId, 'request id'),
      readPermissionDecision(req.body),
    ));
  }),
);

export default router;
