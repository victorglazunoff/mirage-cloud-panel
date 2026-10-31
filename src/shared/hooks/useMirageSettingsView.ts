import { useEffect, useSyncExternalStore } from 'react';

import { api, readApiJson } from '@/shared/api';
import { DEFAULT_VOICE_HOTKEY } from '@/shared/constants';
import type { MirageSettingsView } from '@/shared/types';
import { setServerHomeDir, voiceHotkeyLabel } from '@/shared/utils';

/**
 * One copy of `GET /api/mirage-settings` for every screen that only reads it
 * (the shell's voice hotkey, the chat's Claude defaults, the voice hints). The
 * settings screen publishes each saved answer here, so a new hotkey or default
 * applies at once without a reload.
 */
let cachedView: MirageSettingsView | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readSnapshot(): MirageSettingsView | null {
  return cachedView;
}

/**
 * Replaces the shared copy and re-renders every reader. Called by the
 * kabina-settings module after each successful load or save.
 */
export function publishMirageSettingsView(view: MirageSettingsView | null): void {
  cachedView = view;
  // Path shorteners read `~` from here; a null view (signed out) keeps the last known home.
  if (view?.server) setServerHomeDir(view.server.homeDir);
  listeners.forEach((listener) => listener());
}

function loadOnce(): void {
  if (cachedView || inFlight) return;
  inFlight = (async () => {
    try {
      const { data } = await readApiJson<{ data: MirageSettingsView }>(await api.mirageSettings.get());
      publishMirageSettingsView(data);
    } catch {
      // Not signed in yet or the server is away: readers keep their defaults; the next mount retries.
    } finally {
      inFlight = null;
    }
  })();
}

/**
 * Used by the kabina shell, kabina-chat and kabina-voice modules: the panel's own
 * settings (`/api/mirage-settings`), null until the first answer.
 */
export function useMirageSettingsView(): MirageSettingsView | null {
  const view = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  useEffect(() => {
    loadOnce();
  }, []);
  return view;
}

/**
 * Used by the kabina shell, kabina-chat and kabina-voice modules: the push-to-talk
 * combination from settings («Голос → Горячая клавиша»), ⌥ Пробел until they load,
 * and its hint text («⌥ Пробел»).
 */
export function useVoiceHotkey(): { hotkey: string; label: string } {
  const view = useMirageSettingsView();
  const hotkey = view?.settings.voice.hotkey || DEFAULT_VOICE_HOTKEY;
  return { hotkey, label: voiceHotkeyLabel(hotkey) };
}
