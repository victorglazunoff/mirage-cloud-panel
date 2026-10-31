import express from 'express';
import type { Request, Response } from 'express';

import { homeOverviewService } from '@/modules/home/services/home-overview.service.js';
import { projectsFolderService } from '@/modules/home/services/projects-folder.service.js';
import { subscriptionLimitsService } from '@/modules/home/services/subscription-limits.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

/**
 * The browser's `getTimezoneOffset()`; real offsets stay within ±14 h, so
 * anything else (or nothing) falls back to UTC.
 */
export function readTimezoneOffset(value: unknown): number {
  const offset = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isInteger(offset) && Math.abs(offset) <= 14 * 60 ? offset : 0;
}

const router = express.Router();

router.get(
  '/overview',
  asyncHandler(async (req: Request, res: Response) => {
    const overview = await homeOverviewService.getOverview({
      userId: readUserId(req),
      tzOffsetMinutes: readTimezoneOffset(req.query.tzOffset),
    });
    res.json(createApiSuccessResponse(overview));
  }),
);

// Mirage «Все проекты» (DarkProjects): every project with stats, live work,
// and the projects folder's sub-folders that are not in the panel yet.
router.get(
  '/projects',
  asyncHandler(async (req: Request, res: Response) => {
    const board = await homeOverviewService.getProjectsBoard({
      tzOffsetMinutes: readTimezoneOffset(req.query.tzOffset),
    });
    const projectsFolder = await projectsFolderService.describeProjectsFolder(
      board.projects.map((project) => project.projectPath),
    );
    res.json(createApiSuccessResponse({ ...board, projectsFolder }));
  }),
);

// The wizard's "Папка есть · 214 файлов" line (with the branch) for a typed folder.
router.get(
  '/folder-info',
  asyncHandler(async (req: Request, res: Response) => {
    const folderPath = typeof req.query.path === 'string' ? req.query.path : '';
    res.json(createApiSuccessResponse(await projectsFolderService.describeFolder(folderPath)));
  }),
);

router.get(
  '/limits',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await subscriptionLimitsService.getLimits()));
  }),
);

export default router;
