import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** Overlays the shell can show over any screen; each lives in the URL as `?search` / `?voice` (ПЛАН-КАБИНА). */
type KabinaOverlay = 'search' | 'voice';

const OVERLAYS: KabinaOverlay[] = ['search', 'voice'];

/** Marks history entries this hook pushed, so closing can step back instead of leaving a dead entry. */
type OverlayHistoryState = { kabinaOverlay?: KabinaOverlay } | null;

function withoutOverlays(search: string): string {
  const params = new URLSearchParams(search);
  OVERLAYS.forEach((overlay) => params.delete(overlay));
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Used by KabinaShell: which overlay is open, read from the query string, plus
 * open/close that keep the browser Back button meaningful (Back closes it).
 */
export function useKabinaOverlays() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const current: KabinaOverlay | null = OVERLAYS.find((overlay) => params.has(overlay)) ?? null;

  const open = useCallback((overlay: KabinaOverlay) => {
    const base = withoutOverlays(location.search);
    const search = base ? `${base}&${overlay}` : `?${overlay}`;
    const replace = current !== null;
    navigate({ pathname: location.pathname, search, hash: location.hash }, { replace, state: { kabinaOverlay: overlay } });
  }, [current, location.hash, location.pathname, location.search, navigate]);

  const close = useCallback(() => {
    if (!current) return;
    const state = location.state as OverlayHistoryState;
    if (state?.kabinaOverlay === current && window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate({ pathname: location.pathname, search: withoutOverlays(location.search), hash: location.hash }, { replace: true });
  }, [current, location.hash, location.pathname, location.search, location.state, navigate]);

  return { current, open, close };
}
