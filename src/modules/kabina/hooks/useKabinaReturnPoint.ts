import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Where «Файлы» / «Настройки» (the tool screens) return to: the last other screen the panel
 * showed — its address, a label for «Вернуться в …» and its place in the browser history
 * (react-router keeps an `idx` in `history.state`), so going back restores that very entry.
 */
type KabinaReturnPoint = { path: string; label: string; idx: number | null };

const STORAGE_KEY = 'kabina.return.v1';
const HOME_POINT: KabinaReturnPoint = { path: '/', label: 'главный', idx: null };
/** Overlays live in the query (`?search`, `?voice`); a return never reopens them. */
const OVERLAY_PARAMS = ['search', 'voice'];

// Kept in memory for the tab's life and mirrored to sessionStorage (survives a reload).
let memoryPoint: KabinaReturnPoint | null = null;
const listeners = new Set<() => void>();

function readPoint(): KabinaReturnPoint | null {
  if (memoryPoint) return memoryPoint;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KabinaReturnPoint>;
    if (typeof parsed.path !== 'string' || !parsed.path.startsWith('/')) return null;
    memoryPoint = { path: parsed.path, label: typeof parsed.label === 'string' ? parsed.label : '', idx: typeof parsed.idx === 'number' ? parsed.idx : null };
    return memoryPoint;
  } catch {
    return null;
  }
}

function writePoint(point: KabinaReturnPoint): void {
  memoryPoint = point;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(point));
  } catch {
    // Private mode: the memory copy still works for this tab.
  }
  listeners.forEach((listener) => listener());
}

function historyIdx(): number | null {
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === 'number' ? state.idx : null;
}

function withoutOverlays(search: string): string {
  const params = new URLSearchParams(search);
  OVERLAY_PARAMS.forEach((name) => params.delete(name));
  const rest = params.toString().replace(/=(&|$)/g, '$1');
  return rest ? `?${rest}` : '';
}

/**
 * Used by KabinaShell on every screen: outside the tool screens it records the current
 * address as the return point (an open overlay is not a place to return to).
 */
export function useRecordKabinaReturnPoint(isToolScreen: boolean, label: string, hasOverlay: boolean): void {
  const location = useLocation();
  useEffect(() => {
    if (isToolScreen || hasOverlay) return;
    writePoint({ path: `${location.pathname}${withoutOverlays(location.search)}`, label, idx: historyIdx() });
  }, [hasOverlay, isToolScreen, label, location.pathname, location.search]);
}

/**
 * Used by KabinaShell and KabinaHeader on «Файлы» / «Настройки»: where the toggle buttons,
 * the phone «‹» and Esc lead back to, and the jump itself. When the point is earlier in this
 * tab's history the jump steps back to it (the browser's Back stays meaningful), otherwise it
 * opens the address.
 */
export function useKabinaReturn(): { point: KabinaReturnPoint; goBack: () => void } {
  const navigate = useNavigate();
  // Re-render when another screen records a new point.
  const [point, setPoint] = useState<KabinaReturnPoint>(() => readPoint() ?? HOME_POINT);
  useEffect(() => {
    const update = () => setPoint(readPoint() ?? HOME_POINT);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);

  const goBack = useCallback(() => {
    const target = readPoint() ?? HOME_POINT;
    const current = historyIdx();
    if (target.idx !== null && current !== null && current > target.idx) {
      navigate(target.idx - current);
      return;
    }
    navigate(target.path);
  }, [navigate]);

  return { point, goBack };
}
