// The «Агенты» screen's HTTP surface (snapshot, stop, permission answers),
// mounted by the app under /api/agents.
export { default as agentsLiveRoutes } from './agents-live.routes.js';

// initializeAgentsLive: called by the server entrypoint at start-up (runtime tap + agents.* on /ws).
// agentsLiveService: the context-usage module reads a session's live cost from it.
export { agentsLiveService, initializeAgentsLive } from './services/agents-live.service.js';
