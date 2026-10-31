import { useCallback, useEffect, useRef, useState } from 'react';

import type { FeedItem } from '@/modules/kabina-chat/utils/chatFeed';

/** Feed rows drawn at first; «раньше в диалоге» adds this many more at a time. */
export const FEED_WINDOW_STEP = 120;
/** Older pages fetched on their own while the loaded rows draw nothing at all. */
const MAX_AUTO_PAGES = 6;

type UseFeedWindowArgs = {
  /** Every feed row built from the loaded history, oldest first. */
  items: FeedItem[];
  /** The viewed dialog; the window starts over in another one. */
  sessionId: string | null;
  /** The server holds history older than the loaded rows. */
  hasMoreOnServer: boolean;
  /** The viewed dialog's history has arrived (or failed) — not still on its way. */
  isHistoryReady: boolean;
  isLoadingMore: boolean;
  /** Fetches the page before the loaded rows; resolves true when rows were added. */
  loadOlderPage: () => Promise<boolean>;
};

export type FeedWindow = {
  /** The rows to draw: the newest part of `items`. */
  visibleItems: FeedItem[];
  /** «раньше в диалоге» has something to show — hidden rows or older pages. */
  hasEarlier: boolean;
  /** Shows hidden rows first, then fetches the previous page from the server. */
  loadEarlier: () => void;
};

/**
 * Used by the kabina-chat screen to window the feed by what it draws.
 *
 * The authors' window counts transcript messages, thinking and folded subagent
 * rows included, so the newest hundred could draw nothing and the feed read
 * «пусто» under a running turn. Here the window counts feed rows, the button
 * reaches the server once the loaded rows are all on screen, and a dialog
 * whose loaded rows draw nothing pulls older pages by itself.
 */
export function useFeedWindow({
  items,
  sessionId,
  hasMoreOnServer,
  isHistoryReady,
  isLoadingMore,
  loadOlderPage,
}: UseFeedWindowArgs): FeedWindow {
  const [size, setSize] = useState(FEED_WINDOW_STEP);
  const autoPagesRef = useRef(0);

  useEffect(() => {
    setSize(FEED_WINDOW_STEP);
    autoPagesRef.current = 0;
  }, [sessionId]);

  const hiddenCount = Math.max(0, items.length - size);
  const visibleItems = hiddenCount > 0 ? items.slice(hiddenCount) : items;

  const loadEarlier = useCallback(() => {
    if (hiddenCount > 0) {
      setSize((current) => current + FEED_WINDOW_STEP);
      return;
    }
    if (hasMoreOnServer && !isLoadingMore) {
      // The page lands above the rows on screen, so it must stay in the window.
      setSize((current) => current + FEED_WINDOW_STEP);
      void loadOlderPage();
    }
  }, [hasMoreOnServer, hiddenCount, isLoadingMore, loadOlderPage]);

  const isBlank = items.length === 0;
  useEffect(() => {
    if (!isBlank || !isHistoryReady || !hasMoreOnServer || isLoadingMore) return;
    if (autoPagesRef.current >= MAX_AUTO_PAGES) return;
    autoPagesRef.current += 1;
    void loadOlderPage();
  }, [hasMoreOnServer, isBlank, isHistoryReady, isLoadingMore, loadOlderPage]);

  return { visibleItems, hasEarlier: hiddenCount > 0 || hasMoreOnServer, loadEarlier };
}
