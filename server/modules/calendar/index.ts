// calendarRoutes: mounted by the server entrypoint under /api/calendar (Mirage Х24):
// own events, scheduled messages and systemd timers in one feed, phrase parsing, «prepare»,
// Google Calendar sync status and «Синхронизировать сейчас».
export { default as calendarRoutes } from './calendar.routes.js';
// googleCalendarSync: started and stopped by the server entrypoint (two-way Google Calendar sync).
export { googleCalendarSync } from './services/google-sync.service.js';
// toNominativeFullName: used by the Voice module to bring a dictated name ("с Ольгой") back to the nominative.
export { toNominativeFullName } from './services/russian-name-case.service.js';
// calendarService: the server entrypoint hands `listReminders` to the Telegram bot (calendar reminders).
export { calendarService } from './services/calendar.service.js';
