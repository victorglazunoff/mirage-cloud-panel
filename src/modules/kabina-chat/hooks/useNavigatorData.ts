import { useCallback, useEffect, useRef, useState } from 'react';

import { panelTimezoneOffset } from '@/modules/kabina';
import { sessionTitle } from '@/modules/kabina-chat/SessionsColumn';
import { api, readApiJson } from '@/shared/api';
import type { HomeProjectsBoard, NavSession, NavSessionsPage, ProjectSession, SessionTitleSearchResult } from '@/shared/types';

/** Dialogs fetched per unfold / «ещё». */
const PAGE_SIZE = 15;
/** A cached board or page older than this is shown at once and refreshed behind it. */
const STALE_MS = 15_000;
/** Typing pauses this long before the server title search runs. */
const SEARCH_DEBOUNCE_MS = 220;

/**
 * Module-level caches: the navigator closes and opens many times a minute (and on every
 * dialog switch the chat remounts), so the second opening is instant.
 */
let boardCache: { board: HomeProjectsBoard; at: number } | null = null;
const pagesCache = new Map<string, NavSessionsPage & { at: number }>();

function toNavSession(session: ProjectSession, projectId: string): NavSession {
  return {
    id: session.id,
    projectId,
    title: sessionTitle(session),
    lastActivity: String(session.lastActivity ?? session.updated_at ?? '') || null,
  };
}

type NavigatorData = {
  board: HomeProjectsBoard | null;
  boardError: boolean;
  pages: ReadonlyMap<string, NavSessionsPage>;
  /** Loads the first page of a project's dialogs (unfold); a cached page shows at once. */
  ensureSessions: (projectId: string) => void;
  loadMoreSessions: (projectId: string) => void;
  /** Other projects' dialogs whose title matches the query (server, debounced). */
  titleHits: NavSession[];
  isSearching: boolean;
};

/**
 * Used by the chat navigator: the projects board (status, favourites, counts — the same read
 * model as «Все проекты»), dialogs of unfolded projects, and a title search across every
 * project. Loads only while `active` (the navigator is open).
 */
export function useNavigatorData(active: boolean, query: string): NavigatorData {
  // Projects with live status; seeded from the module cache so a re-open draws at once.
  const [board, setBoard] = useState<HomeProjectsBoard | null>(() => boardCache?.board ?? null);
  // The board failed and there is nothing cached: the «Все проекты» tab says so.
  const [boardError, setBoardError] = useState(false);
  // Pages of unfolded projects; a fresh Map on every change so the list re-renders.
  const [pages, setPages] = useState<ReadonlyMap<string, NavSessionsPage>>(() => new Map(pagesCache));
  // Server title matches for the current query.
  const [titleHits, setTitleHits] = useState<NavSession[]>([]);
  // A title search is in flight (the results group shows «ищу…»).
  const [isSearching, setIsSearching] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const publishPages = useCallback(() => {
    if (mountedRef.current) setPages(new Map(pagesCache));
  }, []);

  useEffect(() => {
    if (!active) return;
    if (boardCache) setBoard(boardCache.board);
    if (boardCache && Date.now() - boardCache.at < STALE_MS) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.home.projects(panelTimezoneOffset());
        const body = await readApiJson<{ data: HomeProjectsBoard }>(response);
        boardCache = { board: body.data, at: Date.now() };
        if (!cancelled) {
          setBoard(body.data);
          setBoardError(false);
        }
      } catch {
        if (!cancelled && !boardCache) setBoardError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const fetchPage = useCallback(async (projectId: string, offset: number) => {
    const previous = pagesCache.get(projectId);
    pagesCache.set(projectId, {
      sessions: previous?.sessions ?? [],
      total: previous?.total ?? null,
      hasMore: previous?.hasMore ?? false,
      loading: true,
      at: previous?.at ?? 0,
    });
    publishPages();
    try {
      const response = await api.projectSessions(projectId, { limit: PAGE_SIZE, offset });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { sessions?: ProjectSession[]; sessionMeta?: { total?: number; hasMore?: boolean } };
      const fresh = (body.sessions ?? []).map((session) => toNavSession(session, projectId));
      const kept = offset > 0 ? (pagesCache.get(projectId)?.sessions ?? []) : [];
      const ids = new Set(kept.map((session) => session.id));
      pagesCache.set(projectId, {
        sessions: [...kept, ...fresh.filter((session) => !ids.has(session.id))],
        total: typeof body.sessionMeta?.total === 'number' ? body.sessionMeta.total : null,
        hasMore: Boolean(body.sessionMeta?.hasMore),
        loading: false,
        at: Date.now(),
      });
    } catch {
      const current = pagesCache.get(projectId);
      if (current) pagesCache.set(projectId, { ...current, loading: false, at: current.at || Date.now() });
    }
    publishPages();
  }, [publishPages]);

  const ensureSessions = useCallback((projectId: string) => {
    const cached = pagesCache.get(projectId);
    if (cached?.loading) return;
    if (cached && Date.now() - cached.at < STALE_MS) return;
    void fetchPage(projectId, 0);
  }, [fetchPage]);

  const loadMoreSessions = useCallback((projectId: string) => {
    const cached = pagesCache.get(projectId);
    if (cached?.loading) return;
    void fetchPage(projectId, cached?.sessions.length ?? 0);
  }, [fetchPage]);

  // Title search across every project: the server streams title matches first (before it
  // scans transcripts), so the stream is closed as soon as they arrive.
  useEffect(() => {
    const trimmed = query.trim();
    if (!active || trimmed.length < 2 || typeof EventSource === 'undefined') {
      setTitleHits([]);
      setIsSearching(false);
      return undefined;
    }
    setIsSearching(true);
    let source: EventSource | null = null;
    const timer = window.setTimeout(() => {
      source = new EventSource(api.searchConversationsUrl(trimmed, 30));
      const finish = () => {
        source?.close();
        setIsSearching(false);
      };
      source.addEventListener('title-results', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as { titleResults?: SessionTitleSearchResult[] };
          setTitleHits((data.titleResults ?? [])
            .filter((hit) => hit.projectId)
            .map((hit) => ({
              id: hit.sessionId,
              projectId: hit.projectId as string,
              title: hit.sessionTitle,
              lastActivity: hit.lastActivity,
              projectName: hit.projectDisplayName,
            })));
        } catch {
          setTitleHits([]);
        }
        finish();
      });
      source.addEventListener('done', finish);
      source.addEventListener('error', finish);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      source?.close();
    };
  }, [active, query]);

  return { board, boardError, pages, ensureSessions, loadMoreSessions, titleHits, isSearching };
}
