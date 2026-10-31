import type { ProviderRuntimeEvent, ProviderRuntimeEventListener } from '@/shared/types.js';

/**
 * Mirage: in-process tap on what the provider runtimes see.
 *
 * The Claude runtime publishes every SDK stream message, permission prompt and
 * process start/end here (see `ProviderRuntimeEvent`). Publishing never
 * throws and never waits: listeners run synchronously and a failing listener
 * is logged and skipped, so the tap cannot disturb a run.
 */
function createProviderRuntimeEvents() {
  const listeners = new Set<ProviderRuntimeEventListener>();

  return {
    /** Used by the provider runtimes to publish what they saw. */
    emit(event: ProviderRuntimeEvent): void {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error('[RuntimeEvents] Listener failed:', error instanceof Error ? error.message : error);
        }
      }
    },

    /** Registers a listener; returns the function that removes it. */
    subscribe(listener: ProviderRuntimeEventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Process-wide tap. Emitted to by the Claude runtime
 * (`claude-runtime.provider.js`); subscribed to by the agents-live module
 * through the providers barrel.
 */
export const providerRuntimeEvents = createProviderRuntimeEvents();
