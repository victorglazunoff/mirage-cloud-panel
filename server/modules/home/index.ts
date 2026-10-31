// The home screen's HTTP surface (summary, favourites, activity, events,
// subscription limits), mounted by the app under /api/home.
export { default as homeRoutes } from './home.routes.js';

// subscriptionLimitsService: the server entrypoint hands it to the Telegram bot (notifications), which reads the
// session and weekly limits to send «80 % лимита» once per window.
export { subscriptionLimitsService } from './services/subscription-limits.service.js';
