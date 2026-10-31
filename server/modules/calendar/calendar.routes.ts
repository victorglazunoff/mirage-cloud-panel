import express from 'express';
import type { Request, Response } from 'express';

import { CALENDAR_TYPES, calendarService } from '@/modules/calendar/services/calendar.service.js';
import { googleCalendarSync } from '@/modules/calendar/services/google-sync.service.js';
import type { CalendarEventInput, CalendarEventStatus, CalendarEventType } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', { code: 'USER_REQUIRED', statusCode: 401 });
  }
  return userId;
}

function readQueryString(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function readFlag(value: unknown): boolean {
  const raw = readQueryString(value);
  return raw === '1' || raw === 'true';
}

/** `?type=call,meeting` (or repeated `type=`) → a whitelisted list, null for all. */
export function readTypeFilter(value: unknown): CalendarEventType[] | null {
  const raw = (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (raw.length === 0) return null;
  const unknown = raw.filter((entry) => !CALENDAR_TYPES.includes(entry as CalendarEventType));
  if (unknown.length > 0) {
    throw new AppError(`Неизвестный тип: ${unknown.join(', ')}.`, { code: 'CALENDAR_INVALID_INPUT', statusCode: 400 });
  }
  return raw as CalendarEventType[];
}

function readBody(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * `scope` of an action on one occurrence of a series: `series` («Вся серия»)
 * or `occurrence` («Только это», the default). Anything else is a 400.
 */
export function readOccurrenceScope(value: unknown): 'occurrence' | 'series' {
  const raw = readQueryString(value);
  if (raw === null || raw === 'occurrence') return 'occurrence';
  if (raw === 'series') return 'series';
  throw new AppError('scope: occurrence или series.', { code: 'CALENDAR_INVALID_INPUT', statusCode: 400 });
}

const router = express.Router();

router.get('/events', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await calendarService.listEvents({
    userId: readUserId(req),
    from: readQueryString(req.query.from),
    to: readQueryString(req.query.to),
    types: readTypeFilter(req.query.type),
    project: readQueryString(req.query.project),
    includeCancelled: readFlag(req.query.includeCancelled),
    includePackagedTimers: readFlag(req.query.includeSystemTimers),
    timeZone: readQueryString(req.query.tz),
  })));
}));

router.post('/events', asyncHandler(async (req: Request, res: Response) => {
  const event = calendarService.createEvent(readUserId(req), readBody(req) as CalendarEventInput);
  res.status(201).json(createApiSuccessResponse(event));
}));

router.get('/events/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(calendarService.getEvent(readUserId(req), String(req.params.id))));
}));

router.patch('/events/:id', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(
    calendarService.updateEvent(readUserId(req), String(req.params.id), readBody(req) as CalendarEventInput),
  ));
}));

// `?scope=series` on an occurrence id deletes the whole series; by default only that occurrence.
router.delete('/events/:id', asyncHandler(async (req: Request, res: Response) => {
  calendarService.deleteEvent(readUserId(req), String(req.params.id), readOccurrenceScope(req.query.scope));
  res.json(createApiSuccessResponse({ deleted: true }));
}));

// «Отметить сделанным» (`{ done: false }` — «Вернуть в план»).
router.post('/events/:id/done', asyncHandler(async (req: Request, res: Response) => {
  const done = readBody(req).done !== false;
  res.json(createApiSuccessResponse(
    calendarService.setStatus(readUserId(req), String(req.params.id), done ? 'done' : 'planned'),
  ));
}));

router.post('/events/:id/status', asyncHandler(async (req: Request, res: Response) => {
  const status = readBody(req).status as CalendarEventStatus;
  res.json(createApiSuccessResponse(calendarService.setStatus(readUserId(req), String(req.params.id), status)));
}));

// «Перенести»: `{ startsAt }`, `{ shiftMinutes }` or `{ preset: 'plus30m' | 'plus1h' | 'tomorrow' }`;
// on an occurrence `scope: 'series'` moves the whole series by the same step.
router.post('/events/:id/reschedule', asyncHandler(async (req: Request, res: Response) => {
  const body = readBody(req);
  res.json(createApiSuccessResponse(calendarService.reschedule(readUserId(req), String(req.params.id), {
    startsAt: typeof body.startsAt === 'string' ? body.startsAt : undefined,
    shiftMinutes: typeof body.shiftMinutes === 'number' ? body.shiftMinutes : undefined,
    preset: typeof body.preset === 'string' ? body.preset : undefined,
  }, readOccurrenceScope(body.scope))));
}));

// «Поручить Claude подготовить».
router.post('/events/:id/prepare', asyncHandler(async (req: Request, res: Response) => {
  const body = readBody(req);
  const result = calendarService.prepare(readUserId(req), String(req.params.id), {
    projectId: readOptionalString(body.projectId),
    sessionId: readOptionalString(body.sessionId),
    at: readOptionalString(body.at),
    instructions: readOptionalString(body.instructions),
    timeZone: readOptionalString(body.tz),
  });
  res.status(201).json(createApiSuccessResponse(result));
}));

// «Открыть журнал» of a server schedule.
router.get('/timers/:unit/journal', asyncHandler(async (req: Request, res: Response) => {
  readUserId(req);
  res.json(createApiSuccessResponse(await calendarService.readTimerJournal(String(req.params.unit))));
}));

// Google Calendar badge: last success, error, what is still waiting.
router.get('/sync-status', asyncHandler(async (req: Request, res: Response) => {
  readUserId(req);
  res.json(createApiSuccessResponse(googleCalendarSync.getStatus()));
}));

// «Синхронизировать сейчас».
router.post('/sync', asyncHandler(async (req: Request, res: Response) => {
  readUserId(req);
  res.json(createApiSuccessResponse(await googleCalendarSync.syncNow()));
}));

router.post('/parse', asyncHandler(async (req: Request, res: Response) => {
  const body = readBody(req);
  if (typeof body.text !== 'string') {
    throw new AppError('text: нужна строка с фразой.', { code: 'CALENDAR_INVALID_INPUT', statusCode: 400 });
  }
  res.json(createApiSuccessResponse(calendarService.parsePhrase({
    text: body.text,
    timeZone: readOptionalString(body.tz),
    now: readOptionalString(body.now),
  })));
}));

export default router;
