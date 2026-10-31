import { SEARCH_SCOPES } from '@/modules/kabina-search/utils/searchModel';
import type { SearchScope } from '@/modules/kabina-search/utils/searchModel';

/** What ⌘K keeps between openings, remounts (phone ↔ desktop layout) and reloads of the tab. */
export type SearchMemory = {
  query: string;
  scope: SearchScope;
  /** Key of the highlighted row; null — the first row. */
  selectedKey: string | null;
};

const STORAGE_KEY = 'kabina-search:last';
const EMPTY: SearchMemory = { query: '', scope: 'all', selectedKey: null };

// In-memory copy: the source of truth while the tab lives (storage can be blocked or full).
let memory: SearchMemory | null = null;

function parse(raw: string | null): SearchMemory {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<SearchMemory> | null;
    return {
      query: typeof value?.query === 'string' ? value.query : '',
      scope: SEARCH_SCOPES.includes(value?.scope as SearchScope) ? value?.scope as SearchScope : 'all',
      selectedKey: typeof value?.selectedKey === 'string' ? value.selectedKey : null,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Used by KabinaSearch for its initial state: the last query, section and highlighted row.
 * A width change that swaps the phone and desktop shells, or a reload of the tab
 * (DevTools device emulation reloads it), must not wipe what was typed.
 */
export function readSearchMemory(): SearchMemory {
  if (memory) return memory;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  memory = parse(raw);
  return memory;
}

/** Used by KabinaSearch whenever the query, section or highlighted row changes. */
export function writeSearchMemory(next: SearchMemory): void {
  memory = next;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or a full storage: the in-memory copy still covers remounts.
  }
}

/** Tests only: forget the in-memory copy so the next read goes to sessionStorage. */
export function resetSearchMemoryCache(): void {
  memory = null;
}
