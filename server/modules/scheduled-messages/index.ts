// The HTTP surface for scheduling a message to a session, mounted by the app.
export { default as scheduledMessagesRoutes } from './scheduled-messages.routes.js';

// The timer that sends them, started and stopped with the server.
export {
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
} from './services/scheduled-message-dispatcher.service.js';

// dispatchQueuedMessages: Mirage — the context-usage module sends a queued
// `/compact` right away when its session is idle instead of waiting for the poll.
export { dispatchQueuedMessages } from './services/scheduled-message-dispatcher.service.js';
// scheduledMessagesService: used by the Calendar module (Mirage Х24) to queue a
// «prepare for this event» task into a project session.
export { scheduledMessagesService } from './services/scheduled-messages.service.js';
