// mirageSettingsRoutes: mounted by the server entrypoint under /api/mirage-settings
// (Kabina settings screen: Claude defaults, voice, notifications, home widgets, theme).
export { default as mirageSettingsRoutes } from './mirage-settings.routes.js';

// applyStoredMirageRuntimeSettings: called by the server entrypoint after the
// database is ready, so a silence ceiling saved in the UI survives restarts.
export { applyStoredMirageRuntimeSettings } from './services/mirage-settings.service.js';

// mirageSettingsService: the notifications module's Telegram bot reads
// `notifications.*` (channel, event switches, quiet hours) before each message.
export { mirageSettingsService } from './services/mirage-settings.service.js';
