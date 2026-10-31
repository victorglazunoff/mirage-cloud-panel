import { useEffect, useRef } from 'react';

import { useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import type { ChatMessage } from '@/shared/types';
import { subscribeChatEcho } from '@/shared/utils';

type ChatEchoArgs = {
  /** The dialog on screen; echoes for other sessions are ignored (they show from history). */
  sessionId: string | null;
  addMessage: (message: ChatMessage) => void;
  setIsUserScrolledUp: (value: boolean) => void;
  scrollToBottom: () => void;
};

/**
 * Used by the kabina-chat screen: a message the voice overlay sent into this
 * dialog as a new turn (`chat.send`) appears at once, the way the composer's
 * own send shows it — the user's line in the feed, the turn marked running.
 * A steered message needs nothing here: the server's `chat_steered` frame
 * already draws it with the «вклинено» label. The local line is retired by the
 * persisted turn like any composer echo.
 */
export function useChatEcho({ sessionId, addMessage, setIsUserScrolledUp, scrollToBottom }: ChatEchoArgs): void {
  const { markSessionProcessing } = useSessionProtectionActions();
  const latest = useRef({ sessionId, addMessage, setIsUserScrolledUp, scrollToBottom, markSessionProcessing });
  latest.current = { sessionId, addMessage, setIsUserScrolledUp, scrollToBottom, markSessionProcessing };

  useEffect(() => subscribeChatEcho((announcement) => {
    const current = latest.current;
    if (announcement.via !== 'sent' || !current.sessionId || announcement.sessionId !== current.sessionId) return;
    current.addMessage({ type: 'user', content: announcement.content, timestamp: new Date(announcement.at) });
    current.markSessionProcessing(announcement.sessionId, { statusText: null, canInterrupt: true });
    current.setIsUserScrolledUp(false);
    window.setTimeout(() => current.scrollToBottom(), 100);
  }), []);
}
