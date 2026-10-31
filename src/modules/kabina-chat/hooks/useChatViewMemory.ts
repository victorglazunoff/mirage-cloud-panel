import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** What the chat looked like when it was left (for Files / Settings and back). */
type ChatView = { panel: 'ctx' | 'art' | null; artifactId: string | null; isArtifactFull: boolean; fromBottom: number; at: number };

/** A view older than this is not restored: coming back next day starts at the end of the feed. */
const VIEW_TTL_MS = 30 * 60_000;
/** The authors' first scroll re-anchors to the bottom for up to ~1 s; the restore waits it out. */
const RESTORE_AFTER_MS = 1_100;

const views = new Map<string, ChatView>();

/** Used by the kabina-chat screen for its first state: the view the dialog was left with, if recent. */
export function readChatView(sessionId: string | null): ChatView | null {
  const saved = sessionId ? views.get(sessionId) : undefined;
  return saved && Date.now() - saved.at < VIEW_TTL_MS ? saved : null;
}

type ChatViewMemoryInput = {
  sessionId: string | null;
  scrollContainerRef: RefObject<HTMLElement | null>;
  setIsUserScrolledUp: (value: boolean) => void;
  /** The feed has messages on screen (the restore waits for them). */
  hasMessages: boolean;
  panel: 'ctx' | 'art' | null;
  artifactId: string | null;
  isArtifactFull: boolean;
};

/**
 * Used by the kabina-chat screen: leaving the chat (Files, Settings, another screen) keeps the
 * open side panel, the artifact and how far up the feed was read; coming back to the same
 * dialog brings the reading position back (the panels come from `readChatView`).
 */
export function useChatViewMemory(input: ChatViewMemoryInput): void {
  const { sessionId, scrollContainerRef, setIsUserScrolledUp, hasMessages, panel, artifactId, isArtifactFull } = input;
  const initialRef = useRef<ChatView | null | undefined>(undefined);
  if (initialRef.current === undefined) initialRef.current = readChatView(sessionId);
  const latestRef = useRef({ panel, artifactId, isArtifactFull });
  latestRef.current = { panel, artifactId, isArtifactFull };
  const restoredRef = useRef(false);

  // How far above the end the feed is read; kept on every scroll (a detached feed measures 0).
  const fromBottomRef = useRef(0);
  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) return undefined;
    const measure = () => {
      fromBottomRef.current = Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop);
    };
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    return () => node.removeEventListener('scroll', measure);
  }, [hasMessages, scrollContainerRef, sessionId]);

  // Remember on leave (unmount or another dialog).
  useEffect(() => {
    if (!sessionId) return undefined;
    return () => {
      views.set(sessionId, { ...latestRef.current, fromBottom: fromBottomRef.current, at: Date.now() });
    };
  }, [sessionId]);

  // Restore the reading position once, after the feed settled at the bottom.
  useEffect(() => {
    const saved = initialRef.current;
    if (restoredRef.current || !saved || !hasMessages || saved.fromBottom < 48) return undefined;
    const timer = window.setTimeout(() => {
      const node = scrollContainerRef.current;
      if (!node) return;
      restoredRef.current = true;
      const target = node.scrollHeight - node.clientHeight - saved.fromBottom;
      if (target <= 0) return;
      setIsUserScrolledUp(true);
      node.scrollTop = target;
    }, RESTORE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [hasMessages, scrollContainerRef, setIsUserScrolledUp]);
}
