import express from 'express';
import type { Request, Response } from 'express';

import { getTelegramNotificationsService } from '@/modules/notifications/services/telegram-notifications.service.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/**
 * Mirage Telegram bot, mounted under /api/notifications/telegram (auth is
 * applied by the parent mount). No route ever returns the bot token.
 */
const router = express.Router();

router.get('/status', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await getTelegramNotificationsService().getStatus()));
}));

// One-time code + t.me deep link; the chat is linked when it sends /start <code>.
router.post('/link', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await getTelegramNotificationsService().issueLinkCode()));
}));

router.delete('/link', asyncHandler(async (_req: Request, res: Response) => {
  const unlinked = getTelegramNotificationsService().unlink();
  res.json(createApiSuccessResponse({ unlinked }));
}));

// «Прислать тестовое» on the settings screen.
router.post('/test', asyncHandler(async (_req: Request, res: Response) => {
  await getTelegramNotificationsService().sendTest();
  res.json(createApiSuccessResponse({ sent: true }));
}));

export default router;
