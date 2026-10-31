import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { publishMirageSettingsView } from '@/shared/hooks/useMirageSettingsView';
import type { MirageSettings, MirageSettingsPatch, MirageSettingsView } from '@/shared/types';

/** How long «СОХРАНЕНО · ТОЛЬКО ЧТО» stays before it settles to the time. */
const FRESH_MS = 2600;

function mergeDeep<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = result[key];
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
      ? mergeDeep(current, value)
      : value;
  }
  return result as T;
}

type SaveState = 'idle' | 'saving' | 'fresh' | 'error';

/**
 * Loads `/api/mirage-settings` and autosaves every change: the screen updates at
 * once (optimistic), the PATCH carries only the changed keys, and the answer
 * (the whole settings) replaces the local copy. A failed save rolls back and
 * keeps the error for the «не сохранено» badge. Used by the kabina-settings screen.
 */
export function useMirageSettings() {
  // The server view: settings plus where settings.json lives and when it was last saved.
  const [view, setView] = useState<MirageSettingsView | null>(null);
  // Loading error (the screen shows it instead of the sections).
  const [loadError, setLoadError] = useState<string | null>(null);
  // Autosave badge: saving now, just saved (fresh), failed, or settled.
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const freshTimer = useRef<number | null>(null);
  // Saves run one after another so a slow answer never overwrites a newer change.
  const queue = useRef<Promise<void>>(Promise.resolve());

  // The route wraps the view in the `{ success, data }` envelope.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: next } = await readApiJson<{ data: MirageSettingsView }>(await api.mirageSettings.get());
        if (!cancelled) {
          setView(next);
          publishMirageSettingsView(next);
        }
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить настройки');
      }
    })();
    return () => {
      cancelled = true;
      if (freshTimer.current !== null) window.clearTimeout(freshTimer.current);
    };
  }, []);

  const update = useCallback((patch: MirageSettingsPatch) => {
    let previous: MirageSettingsView | null = null;
    setView((current) => {
      previous = current;
      return current ? { ...current, settings: mergeDeep<MirageSettings>(current.settings, patch) } : current;
    });
    setSaveState('saving');
    queue.current = queue.current.then(async () => {
      try {
        const { data: next } = await readApiJson<{ data: MirageSettingsView }>(await api.mirageSettings.update(patch));
        setView(next);
        // The shell (voice hotkey) and the chat (Claude defaults) read the shared copy.
        publishMirageSettingsView(next);
        setSaveError(null);
        setSaveState('fresh');
        if (freshTimer.current !== null) window.clearTimeout(freshTimer.current);
        freshTimer.current = window.setTimeout(() => setSaveState('idle'), FRESH_MS);
      } catch (error) {
        if (previous) setView(previous);
        setSaveError(error instanceof Error ? error.message : 'Не сохранилось');
        setSaveState('error');
      }
    });
  }, []);

  return { view, loadError, saveState, saveError, update };
}
