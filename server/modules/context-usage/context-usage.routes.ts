import express from 'express';
import type { Request, Response } from 'express';

import { contextUsageService } from '@/modules/context-usage/services/context-usage.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', { code: 'USER_REQUIRED', statusCode: 401 });
  }
  return userId;
}

/** Validates the `:sessionId` path segment. Exported for the route tests. */
export function readSessionIdParam(value: unknown): string {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (!sessionId || sessionId.length > 200) {
    throw new AppError('A session id is required.', { code: 'INVALID_SESSION_ID', statusCode: 400 });
  }
  return sessionId;
}

const router = express.Router();

router.get(
  '/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    res.json(createApiSuccessResponse(
      await contextUsageService.getContextUsage(readSessionIdParam(req.params.sessionId), { fresh }),
    ));
  }),
);

router.get(
  '/:sessionId/size',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(
      await contextUsageService.getTranscriptSize(readSessionIdParam(req.params.sessionId)),
    ));
  }),
);

router.post(
  '/:sessionId/compact',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(
      contextUsageService.queueCompact(readUserId(req), readSessionIdParam(req.params.sessionId)),
    ));
  }),
);

router.delete(
  '/:sessionId/compact',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(
      contextUsageService.cancelCompact(readUserId(req), readSessionIdParam(req.params.sessionId)),
    ));
  }),
);

export default router;
