import { useCallback, useEffect, useRef } from 'react';

/*
 * Every open layer that closes on Esc (modal, sheet, popover, menu), oldest first. Their key
 * listeners sit on `document` in different phases, and listeners of one phase run in the order
 * they were added — the oldest layer first — so `stopPropagation` alone let one Esc close the
 * modal and the menu inside it, or the outer layer instead of the inner one. Each layer asks
 * `isTop()` and only the newest one acts.
 */
const openLayers: symbol[] = [];

/**
 * Used by the Kabina layers (modal and sheet, HUD and bell popovers, ⌘K, voice, chat and
 * calendar menus): registers the layer while `active` and returns `isTop` — true only for the
 * newest open layer, the one a press of Esc belongs to.
 */
export function useEscapeLayer(active: boolean): () => boolean {
  const idRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    const id = Symbol('escape-layer');
    openLayers.push(id);
    idRef.current = id;
    return () => {
      const index = openLayers.indexOf(id);
      if (index >= 0) openLayers.splice(index, 1);
      if (idRef.current === id) idRef.current = null;
    };
  }, [active]);

  return useCallback(() => idRef.current !== null && openLayers[openLayers.length - 1] === idRef.current, []);
}

/** Used by the Kabina shell: whether any Esc layer is open (then Esc is theirs, not «back»). */
export function hasOpenEscapeLayer(): boolean {
  return openLayers.length > 0;
}
