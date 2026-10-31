import express from 'express';
import type { Request, Response } from 'express';

import { kabinaFilesService } from '@/modules/kabina-files/kabina-files.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new AppError(`${name} is required`, { code: 'KABINA_FILES_FIELD_REQUIRED', statusCode: 400 });
}

/** Query numbers: absent → undefined; anything but a non-negative integer → 400. */
export function readPageNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(`${name} must be a non-negative integer`, { code: 'INVALID_QUERY_PARAMETER', statusCode: 400 });
  }
  return parsed;
}

const router = express.Router();

// One page of a folder for the lazy tree: ?path=<absolute, or ~ for the workspace root>&offset=&limit=&hidden=1
router.get(
  '/folder',
  asyncHandler(async (req: Request, res: Response) => {
    const page = await kabinaFilesService.listFolder({
      path: readString(req.query.path, 'path'),
      offset: readPageNumber(req.query.offset, 'offset'),
      limit: readPageNumber(req.query.limit, 'limit'),
      showHidden: req.query.hidden === '1' || req.query.hidden === 'true',
    });
    res.json(createApiSuccessResponse(page));
  }),
);

// «В архив»: { path } of the project → moved under ~/.claude/archive/files.
router.post(
  '/projects/:projectId/archive',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await kabinaFilesService.archiveEntry({
      projectId: readString(req.params.projectId, 'projectId'),
      path: readString(body.path, 'path'),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// «Вернуть»: { archivedPath, originalPath } → moved back if the place is free.
router.post(
  '/projects/:projectId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await kabinaFilesService.restoreEntry({
      projectId: readString(req.params.projectId, 'projectId'),
      archivedPath: readString(body.archivedPath, 'archivedPath'),
      originalPath: readString(body.originalPath, 'originalPath'),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

export default router;
