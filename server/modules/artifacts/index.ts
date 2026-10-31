// Used by the server entrypoint: `sessionArtifactsRoutes` at `/api/sessions` (token-protected),
// `artifactsRoutes` at `/api/artifacts` (view: token, frame: ticket), and the live capture hook.
export {
  artifactsRoutes,
  initializeArtifactsLiveCapture,
  sessionArtifactsRoutes,
} from '@/modules/artifacts/artifacts.module.js';
