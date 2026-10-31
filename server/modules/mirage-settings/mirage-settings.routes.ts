import express from 'express';
import type { Request, Response } from 'express';

import { mirageSettingsService } from '@/modules/mirage-settings/services/mirage-settings.service.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await mirageSettingsService.getSettings()));
}));

// Deep partial update; the service validates every key and refuses unknown ones.
router.patch('/', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await mirageSettingsService.updateSettings(req.body ?? {})));
}));

export default router;
