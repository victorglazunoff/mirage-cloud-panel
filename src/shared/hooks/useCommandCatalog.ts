import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { CommandCatalogResponse } from '@/shared/types';

/** Catalogs already fetched this page load, per project (`''` = no project); the catalog changes rarely. */
const catalogCache = new Map<string, CommandCatalogResponse>();

/**
 * Used by the ⌘K search (command previews) and the «/» menu: the slash-command catalog of
 * `GET /api/commands/catalog`, with the open project's own commands and skills when
 * `projectId` is set. Served from a page-lifetime cache after the first answer.
 */
export function useCommandCatalog(projectId: string | null): {
  catalog: CommandCatalogResponse | null;
  failed: boolean;
} {
  const cacheKey = projectId ?? '';
  // The catalog for the current project; seeded from the cache so reopening the menu is instant.
  const [catalog, setCatalog] = useState<CommandCatalogResponse | null>(() => catalogCache.get(cacheKey) ?? null);
  // True when the request failed, so the menu can say so instead of spinning forever.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const cached = catalogCache.get(cacheKey);
    if (cached) {
      setCatalog(cached);
      setFailed(false);
      return undefined;
    }
    const controller = new AbortController();
    setFailed(false);
    api.commandsCatalog(projectId, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`catalog ${response.status}`);
        const body = (await response.json()) as CommandCatalogResponse;
        catalogCache.set(cacheKey, body);
        setCatalog(body);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [cacheKey, projectId]);

  return { catalog, failed };
}
