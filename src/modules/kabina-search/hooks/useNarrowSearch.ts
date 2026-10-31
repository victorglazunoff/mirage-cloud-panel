import { useEffect, useState } from 'react';

/** Same breakpoint as the `@media (max-width: 760px)` block of kabinaSearch.css. */
const NARROW_QUERY = '(max-width: 760px)';

function matchesNarrow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

/**
 * Used by KabinaSearch: true on a phone-width screen, where the field gets a shorter
 * placeholder and the preview becomes a bottom sheet. Follows rotation and resizes live.
 */
export function useNarrowSearch(): boolean {
  const [isNarrow, setIsNarrow] = useState(matchesNarrow);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(NARROW_QUERY);
    const update = () => setIsNarrow(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, []);

  return isNarrow;
}
