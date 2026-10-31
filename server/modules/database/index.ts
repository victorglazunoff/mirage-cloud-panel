export { initializeDatabase } from '@/modules/database/init-db.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { notificationChannelEndpointsDb } from '@/modules/database/repositories/notification-channel-endpoints.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
// providerModelsDb: used by Providers to persist user-managed custom model rows.
export { providerModelsDb } from '@/modules/database/repositories/provider-models.js';
// projectsDb: used by Projects, Worktrees, Git, WebSocket, and notification modules to persist and resolve project records.
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
// sessionDraftsDb: used by User for drafts and Scheduled Messages for server-owned queued turns.
export { sessionDraftsDb } from '@/modules/database/repositories/session-drafts.db.js';
export type {
  QueuedSessionMessageRecord,
  SessionDraftRecord,
} from '@/modules/database/repositories/session-drafts.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
// userPreferencesDb: used by the User module to persist the settings that used to live in browser localStorage.
export { userPreferencesDb } from '@/modules/database/repositories/user-preferences.db.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
export { scheduledMessagesDb } from './repositories/scheduled-messages.db.js';
export type { ScheduledMessageRow, ScheduledMessageStatus } from './repositories/scheduled-messages.db.js';
// calendarEventsDb: used by the Calendar module to persist the user's own events (Mirage Х24).
export { calendarEventsDb } from './repositories/calendar-events.db.js';
export type {
  CalendarEventRow,
  CalendarEventWritableFields,
  CalendarGoogleDeletionRow,
  CalendarGoogleSyncRow,
  CalendarOccurrenceOverrideRow,
} from './repositories/calendar-events.db.js';
// authSecurityDb: used by the Auth module for TOTP, sign-ins, remembered devices and attempt throttling (Mirage Б11, Х9),
// and by the CLI module's `passwd` command to void sign-ins and lift the login lock after a reset.
export { authSecurityDb } from './repositories/auth-security.db.js';
export type {
  AuthSessionRow,
  AuthThrottleRow,
  AuthTrustedDeviceRow,
  UserSecurityRow,
} from './repositories/auth-security.db.js';
// telegramLinkDb: used by the Notifications module's Telegram bot for its linked chat and one-time link codes.
export { telegramLinkDb } from './repositories/telegram-link.db.js';
export type { TelegramLinkRow } from './repositories/telegram-link.db.js';
