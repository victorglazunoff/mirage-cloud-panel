import type { WebSocket } from 'ws';

import type { AnyRecord } from '@/shared/types.js';

/**
 * Mirage: a feature module's handler for its own message types on the chat
 * socket (`/ws`), e.g. agents-live's `agents.subscribe`. `userId` is the
 * authenticated user of the connection.
 */
export type ChatSocketExtension = {
  /** Message `type` values the extension owns (must not clash with `chat.*`). */
  types: string[];
  handle(ws: WebSocket, data: AnyRecord, context: { userId: string | number | null }): void | Promise<void>;
  /** Called once when a chat socket closes, so the extension can drop it. */
  onClose?(ws: WebSocket): void;
};

const handlersByType = new Map<string, ChatSocketExtension>();
const extensions = new Set<ChatSocketExtension>();

/**
 * Registers a feature module's message types on the chat socket. Exported
 * through the websocket barrel; used by agents-live at server start.
 * Returns the function that removes the extension again (tests).
 */
export function registerChatSocketExtension(extension: ChatSocketExtension): () => void {
  for (const type of extension.types) {
    if (type.startsWith('chat.')) {
      throw new Error(`Chat socket extension may not claim "${type}".`);
    }
    handlersByType.set(type, extension);
  }
  extensions.add(extension);
  return () => {
    extensions.delete(extension);
    for (const type of extension.types) {
      if (handlersByType.get(type) === extension) {
        handlersByType.delete(type);
      }
    }
  };
}

/** The extension owning a message type, if any; used by the chat gateway's dispatch. */
export function findChatSocketExtension(type: string): ChatSocketExtension | undefined {
  return handlersByType.get(type);
}

/** Tells every extension a chat socket closed; used by the chat gateway. */
export function notifyChatSocketExtensionsClosed(ws: WebSocket): void {
  for (const extension of extensions) {
    try {
      extension.onClose?.(ws);
    } catch (error) {
      console.error('[WS] Extension close handler failed:', error instanceof Error ? error.message : error);
    }
  }
}
