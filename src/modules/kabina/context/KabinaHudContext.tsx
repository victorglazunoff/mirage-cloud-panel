import { createContext, useContext, useLayoutEffect } from 'react';

import type { KabinaLiveSummary } from '@/shared/types';

/** What KabinaShell shares with the HUD and with screens that draw their own HUD (the chat). */
export type KabinaHudContextValue = {
  /** What runs across the panel now (the HUD's «работают N · ждёт N»). */
  live: KabinaLiveSummary;
  /** A place in the header row a screen may fill (the chat: dialog title and project tabs). */
  headerSlot: HTMLElement | null;
  /** A screen draws its own HUD while mounted: the shell hides its default one. */
  claimHud: () => () => void;
  /** A screen draws the crumbs after the logo itself (the chat — clickable project and dialog). */
  claimCrumbs: () => () => void;
};

/** Provided by KabinaShell. */
export const KabinaHudContext = createContext<KabinaHudContextValue | null>(null);

/** Used by KabinaHud: the live summary (zeros outside the shell, e.g. in tests). */
export function useKabinaLiveSummary(): KabinaLiveSummary {
  return useContext(KabinaHudContext)?.live ?? { runningCount: 0, working: 0, waiting: 0 };
}

/**
 * Used by kabina-chat: the header slot to portal the dialog title and project tabs into
 * (null outside the shell or before the header mounted).
 */
export function useKabinaHeaderSlot(): HTMLElement | null {
  return useContext(KabinaHudContext)?.headerSlot ?? null;
}

/**
 * Used by kabina-chat, which draws its own HUD (dialog, turn, context and artifacts): while
 * the screen is mounted the shell's default HUD steps aside, so there is never two of them.
 */
export function useClaimKabinaHud(): void {
  const claim = useContext(KabinaHudContext)?.claimHud;
  // Before the first paint: with a plain effect the shell's HUD stayed for a frame under the
  // chat's own (two HUDs for ~200 ms when the chat opens on a reload).
  useLayoutEffect(() => claim?.(), [claim]);
}

/**
 * Used by kabina-chat, whose header bar draws «// Проект // Диалог» as buttons that open the
 * navigator: while it is mounted the shell leaves out its own static crumb.
 */
export function useClaimKabinaCrumbs(): void {
  const claim = useContext(KabinaHudContext)?.claimCrumbs;
  // Before the first paint, like the HUD claim: no frame with both crumb rows.
  useLayoutEffect(() => claim?.(), [claim]);
}
