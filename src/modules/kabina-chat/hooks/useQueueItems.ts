import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { readQueuedMessage, replaceQueuedMessage, subscribeToChatDrafts } from '@/shared/chatDrafts';
import type { QueuedDraft } from '@/shared/types';

/**
 * The server keeps one queued message per session and appends each "после
 * хода" follow-up to it with a blank line. The queue list shows the follow-ups
 * separately, so this page remembers the parts it queued; when they no longer
 * add up to what the server holds (another tab, a reload), the whole message
 * is shown as one item.
 */
const SEPARATOR = '\n\n';
const partsByScope = new Map<string, string[]>();

/** Records a follow-up the kabina composer has just put into the queue. */
export function rememberQueuedPart(scope: string | null, text: string, queuedBefore: string | null): void {
  if (!scope || !text.trim()) return;
  const known = partsByScope.get(scope);
  const base = queuedBefore && known && known.join(SEPARATOR) === queuedBefore ? known : queuedBefore ? [queuedBefore] : [];
  partsByScope.set(scope, [...base, text.trim()]);
}

/** Splits a queued message into the follow-ups this page knows it consists of. */
export function splitQueuedContent(scope: string, content: string): string[] {
  const known = partsByScope.get(scope);
  if (known && known.join(SEPARATOR) === content) return known;
  return content.trim() ? [content] : [];
}

type UseQueueItemsArgs = {
  sessionKey: string | null;
  queuedDraft: QueuedDraft | null;
  /** Authors' composer action: deletes the whole queued message. */
  deleteQueuedDraft: () => void;
};

/**
 * Used by the kabina-chat queue («ОЧЕРЕДЬ · ПОСЛЕ ХОДА»): the follow-ups as
 * separate rows, and edit / remove / move of one row. A change rewrites the
 * session's queued message in one server write; removing the last row
 * deletes it through the composer, exactly as the authors' card does.
 */
export function useQueueItems({ sessionKey, queuedDraft, deleteQueuedDraft }: UseQueueItemsArgs) {
  // A string snapshot: the store hands out a fresh object on every read.
  const storedContent = useSyncExternalStore(
    subscribeToChatDrafts,
    () => (sessionKey ? readQueuedMessage(sessionKey)?.content ?? null : null),
    () => null,
  );
  // The composer's card says whether anything is queued; the drafts store has
  // the freshest text (it changes first when a row is edited here).
  const content = queuedDraft ? (storedContent ?? queuedDraft.content) : '';

  const items = useMemo(
    () => (sessionKey && content ? splitQueuedContent(sessionKey, content) : []),
    [content, sessionKey],
  );

  const write = useCallback((next: string[]) => {
    if (!sessionKey || !queuedDraft) return;
    const parts = next.map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) {
      partsByScope.delete(sessionKey);
      deleteQueuedDraft();
      return;
    }
    partsByScope.set(sessionKey, parts);
    const stored = readQueuedMessage(sessionKey);
    void replaceQueuedMessage(sessionKey, {
      content: parts.join(SEPARATOR),
      options: stored?.options ?? queuedDraft.options,
      attachments: stored?.attachments ?? queuedDraft.uploadedAttachments,
    });
  }, [deleteQueuedDraft, queuedDraft, sessionKey]);

  const editItem = useCallback((index: number, text: string) => {
    write(items.map((item, i) => (i === index ? text : item)));
  }, [items, write]);

  const removeItem = useCallback((index: number) => {
    write(items.filter((_, i) => i !== index));
  }, [items, write]);

  const moveItem = useCallback((from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    write(next);
  }, [items, write]);

  return { items, editItem, removeItem, moveItem };
}
