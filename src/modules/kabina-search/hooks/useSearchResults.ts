import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { SearchResponse } from '@/shared/types';

/** Pause after the last keystroke before asking the server (dialog search runs ripgrep). */
const DEBOUNCE_MS = 180;
/** Per-group cap; a single tab shows up to this many rows, «Всё» cuts each group further. */
const GROUP_LIMIT = 30;

/**
 * Used by KabinaSearch: debounced `GET /api/search` for the typed query. The last answer is
 * kept, but KabinaSearch shows it only while it still belongs to the typed query (an older
 * answer under a newer query would show wrong rows with a wrong counter); a newer query
 * aborts the older request, and a late answer of an aborted one is dropped.
 */
export function useSearchResults(query: string, projectId: string | null) {
  // Last answer that matched a query the user typed; kept while a newer one loads.
  const [response, setResponse] = useState<SearchResponse | null>(null);
  // True between the keystroke and the answer, for the «ищу…» note.
  const [isLoading, setIsLoading] = useState(true);
  // True when the last request failed (server down, auth expired).
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setFailed(false);
    const timer = window.setTimeout(() => {
      api.search(query.trim(), { limit: GROUP_LIMIT, projectId }, { signal: controller.signal })
        .then(async (result) => {
          if (!result.ok) throw new Error(`search ${result.status}`);
          const body = (await result.json()) as SearchResponse;
          if (controller.signal.aborted) return;
          setResponse(body);
          setFailed(false);
          setIsLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setFailed(true);
          setIsLoading(false);
        });
    }, query.trim() ? DEBOUNCE_MS : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, query]);

  return { response, isLoading, failed };
}
