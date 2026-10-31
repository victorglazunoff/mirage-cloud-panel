import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type {
  ChatEchoAnnouncement,
  MatchParts,
  Project,
  ProjectSession,
  QuickSettingsTab,
  SlashCommand,
  VoiceHotkeyChord,
} from '@/shared/types';
import { PRODUCT_SHORT_NAME } from '@/shared/constants';

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = PRODUCT_SHORT_NAME;

/**
 * Resolves the human-readable label for a session: the persisted `summary` (the custom
 * name the sessions API returns for every provider, Cursor included), else the `name` a
 * Cursor session object may carry locally, else the provider's placeholder. Reads the
 * same fields in the same order as the sidebar row, so the header, document title and
 * sidebar never disagree about a session's name.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  const title = (session.summary as string) || (session.name as string);
  if (session.__provider === 'cursor') {
    return title || 'Untitled Session';
  }

  return title || 'New Session';
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

// ---------------------------

//----------------- SLASH COMMANDS ------------

/**
 * Whether a slash command is a provider skill (as opposed to a built-in or a
 * custom `.md` command). Skills are mapped with `type: 'skill'`; the metadata
 * check catches entries that only carry the skill marker there. Used wherever
 * commands are grouped or executed differently by kind.
 */
export const isSkillCommand = (command: SlashCommand): boolean =>
  command.type === 'skill' || command.metadata?.type === 'skill';

// ---------------------------

//----------------- QUICK SETTINGS PANEL ------------

/** DOM id of a quick settings tab button; pairs with `getQuickSettingsTabPanelId` for aria-controls / aria-labelledby. */
export const getQuickSettingsTabId = (tab: QuickSettingsTab): string => `quick-settings-tab-${tab}`;

/** DOM id of the tabpanel a quick settings tab controls; pairs with `getQuickSettingsTabId`. */
export const getQuickSettingsTabPanelId = (tab: QuickSettingsTab): string => `quick-settings-tabpanel-${tab}`;

// ---------------------------

//----------------- RUSSIAN WORDING, MIRAGE SEARCH AND COMMANDS ------------

/**
 * Picks the Russian plural form for a count: `pluralRu(2, ['файл', 'файла', 'файлов'])` → 'файла'.
 * Used by the ⌘K search, the «/» menu and the Kabina projects and files screens.
 */
export function pluralRu(count: number, forms: [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

/**
 * Splits `text` around the first case- and ё-insensitive occurrence of `needle`, so the ⌘K
 * search and the «/» menu wrap the hit in a highlight without re-implementing the match.
 */
export function splitMatch(text: string, needle: string): MatchParts {
  const fold = (value: string) => value.toLowerCase().replace(/ё/g, 'е');
  const trimmed = needle.trim();
  const index = trimmed ? fold(text).indexOf(fold(trimmed)) : -1;
  if (index < 0) return { before: text, match: '', after: '' };
  return {
    before: text.slice(0, index),
    match: text.slice(index, index + trimmed.length),
    after: text.slice(index + trimmed.length),
  };
}

// ---------------------------

//----------------- SERVER HOME FOLDER ------------

/** The server user's home folder from `/api/mirage-settings`; null until it answered. */
let serverHomeDir: string | null = null;

/**
 * Remembers the server user's home folder (`MirageSettingsView.server.homeDir`).
 * Called by the shared mirage-settings view store whenever a view arrives, and by tests.
 */
export function setServerHomeDir(homeDir: string | null | undefined): void {
  const trimmed = typeof homeDir === 'string' ? homeDir.replace(/\/+$/, '') : '';
  serverHomeDir = trimmed || null;
}

/**
 * The server user's home folder, or null until the server told it. Used by the
 * path shorteners (`tildePath`, Kabina search and chat) as their default home.
 */
export function getServerHomeDir(): string | null {
  return serverHomeDir;
}

/**
 * Shortens an absolute server path for display: the server user's home folder
 * becomes `~` (`/home/v/x` → `~/x`). Until the server reported its home, any
 * `/home/<user>` or `/Users/<user>` counts as one. Used by the Kabina projects,
 * files, search and chat screens.
 */
export function tildePath(fullPath: string, homeDir: string | null = serverHomeDir): string {
  if (homeDir) {
    if (fullPath === homeDir) return '~';
    return fullPath.startsWith(`${homeDir}/`) ? `~${fullPath.slice(homeDir.length)}` : fullPath;
  }
  return fullPath.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
}

// ---------------------------

//----------------- MIRAGE VOICE HOTKEY ------------

/** Glyphs of the modifier keys and the named keys in voice hotkey hints. */
const VOICE_HOTKEY_CAPS: Record<string, string> = { Alt: '⌥', Control: '⌃', Meta: '⌘', Shift: '⇧', Space: 'Пробел' };

/** The modifier names a voice hotkey may hold besides its main key. */
const VOICE_HOTKEY_MODIFIERS: readonly string[] = ['Alt', 'Control', 'Meta', 'Shift'];

/**
 * Splits a voice hotkey (`Alt+Space`, `Control+Shift+V`) into the modifiers it needs and
 * the `KeyboardEvent.code` of its main key (`Space`, `KeyV`, `Digit1`, `F2`). Used by the
 * Kabina shell's hold-to-talk listener together with `matchesVoiceHotkey`.
 */
export function parseVoiceHotkey(hotkey: string): VoiceHotkeyChord {
  const parts = hotkey.split('+').map((part) => part.trim()).filter(Boolean);
  const modifiers = new Set(parts.filter((part) => VOICE_HOTKEY_MODIFIERS.includes(part)));
  const key = parts.find((part) => !VOICE_HOTKEY_MODIFIERS.includes(part)) ?? 'Space';
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
  return {
    alt: modifiers.has('Alt'),
    ctrl: modifiers.has('Control'),
    meta: modifiers.has('Meta'),
    shift: modifiers.has('Shift'),
    code,
  };
}

/**
 * Whether a key event is the voice hotkey: the main key's code with exactly the
 * modifiers the hotkey names (an extra modifier makes it another shortcut). Used by
 * the Kabina shell's global hotkeys.
 */
export function matchesVoiceHotkey(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>,
  chord: VoiceHotkeyChord,
): boolean {
  return event.code === chord.code
    && event.altKey === chord.alt
    && event.ctrlKey === chord.ctrl
    && event.metaKey === chord.meta
    && event.shiftKey === chord.shift;
}

/**
 * The hotkey as hints write it: `Alt+Space` → «⌥ Пробел», `Control+Shift+V` → «⌃ ⇧ V».
 * Used by the Kabina shell (voice button), the voice overlay, the chat composer and
 * the settings screen.
 */
export function voiceHotkeyLabel(hotkey: string): string {
  return hotkey.split('+').map((part) => part.trim()).filter(Boolean)
    .map((part) => VOICE_HOTKEY_CAPS[part] ?? part.toUpperCase())
    .join(' ');
}

// ---------------------------

//----------------- MIRAGE CHAT ECHO ------------

/** Open chats listening for messages sent into their session from elsewhere in this tab. */
const chatEchoListeners = new Set<(announcement: ChatEchoAnnouncement) => void>();

/**
 * Tells the open chat that a message went into a session straight over the websocket
 * (the voice overlay's «Выполнить»), so it shows the user's line at once — the server
 * sends no echo for a plain `chat.send`. Used by the kabina-voice module.
 */
export function announceChatEcho(announcement: ChatEchoAnnouncement): void {
  chatEchoListeners.forEach((listener) => listener(announcement));
}

/**
 * Subscribes to `announceChatEcho`; returns the unsubscribe. Used by the kabina-chat
 * module for the dialog on screen.
 */
export function subscribeChatEcho(listener: (announcement: ChatEchoAnnouncement) => void): () => void {
  chatEchoListeners.add(listener);
  return () => {
    chatEchoListeners.delete(listener);
  };
}
