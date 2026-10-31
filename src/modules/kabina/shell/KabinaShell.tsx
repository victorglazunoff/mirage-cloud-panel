import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useKabinaToasts } from '@/modules/kabina/context/KabinaToastContext';
import { KabinaHudContext } from '@/modules/kabina/context/KabinaHudContext';
import type { KabinaHudContextValue } from '@/modules/kabina/context/KabinaHudContext';
import { KabinaVoiceContext } from '@/modules/kabina/context/KabinaVoiceContext';
import type { KabinaVoiceControl } from '@/modules/kabina/context/KabinaVoiceContext';
import { useActivityToasts } from '@/modules/kabina/hooks/useActivityToasts';
import { useConnectionWatch } from '@/modules/kabina/hooks/useConnectionWatch';
import { useKabinaHotkeys } from '@/modules/kabina/hooks/useKabinaHotkeys';
import { useKabinaOverlays } from '@/modules/kabina/hooks/useKabinaOverlays';
import { useKabinaReturn, useRecordKabinaReturnPoint } from '@/modules/kabina/hooks/useKabinaReturnPoint';
import { useVisualViewportFrame } from '@/modules/kabina/hooks/useVisualViewportFrame';
import ConnectionBanner from '@/modules/kabina/shell/ConnectionBanner';
import KabinaHeader from '@/modules/kabina/shell/KabinaHeader';
import { KabinaHud } from '@/modules/kabina/shell/KabinaHud';
import PhoneNav from '@/modules/kabina/shell/PhoneNav';
import { VoiceButton } from '@/modules/kabina/ui/VoiceButton';
import { useVoiceHotkey } from '@/shared/hooks/useMirageSettingsView';
import type { KabinaCrumb, KabinaProjectRef, KabinaVoiceSlot } from '@/shared/types';
import { hasOpenEscapeLayer } from '@/shared/hooks/useEscapeLayer';

type KabinaShellProps = {
  isPhone: boolean;
  /** `page` — scrolling 1360px column (DarkMain); `app` — full-height 1680px frame for chat-like screens (DarkChat). */
  layout: 'page' | 'app';
  crumbs?: KabinaCrumb[];
  /** How «Вернуться в …» names this screen when Files / Settings are opened from it. */
  returnLabel?: string;
  searchPlaceholder?: string;
  /** Project the Files button opens, when the screen belongs to one. */
  filesProjectId?: string | null;
  headerCurrent?: 'files' | 'settings' | 'home' | null;
  /** Section highlighted in the phone navigation (null: none, e.g. files or settings). */
  phoneSection: 'home' | 'projects' | 'agents' | 'calendar' | null;
  /** Session shown on screen: its own events raise no toasts. */
  activeSessionId: string | null;
  /** The ⌘K overlay (`?search`), supplied by the workspace so the shell does not import screens. */
  renderSearch: (onClose: () => void) => ReactNode;
  /** Phone chat (DarkPhoneChat) draws its own header edge to edge: no shell header, no padding. */
  bare?: boolean;
  /** Project of the chat on screen — the voice overlay's default addressee. */
  activeProjectId?: string | null;
  /** Computer: the header keeps a slot the screen fills (the chat — dialog title and project tabs). */
  headerSlot?: boolean;
  /** Projects for the voice overlay's «new dialog in project» choice. */
  projects: KabinaProjectRef[];
  /** Voice overlay for `?voice`; without it the voice button only opens the address. */
  renderVoice?: (slot: KabinaVoiceSlot) => ReactNode;
  children: ReactNode;
};

/**
 * Used by KabinaApp for every «Кабина» screen: the grid background, header (with the
 * notification bell — nothing pops up over the screen), phone navigation, voice button,
 * the thin «нет связи» strip and the
 * ⌘K / voice-hotkey overlays (the hotkey comes from settings, ⌥ Space by default).
 */
export default function KabinaShell({
  isPhone,
  layout,
  crumbs,
  returnLabel = 'главный',
  searchPlaceholder = 'Найти диалог, файл или спросить Claude',
  filesProjectId,
  headerCurrent = null,
  phoneSection,
  activeSessionId,
  renderSearch,
  bare = false,
  activeProjectId = null,
  headerSlot = false,
  projects,
  renderVoice,
  children,
}: KabinaShellProps) {
  const overlays = useKabinaOverlays();
  const { show, dismiss, items: notifications } = useKabinaToasts();
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;
  const connection = useConnectionWatch();
  const live = useActivityToasts(activeSessionId);
  // The header slot element once mounted (a screen portals into it).
  const [headerSlotNode, setHeaderSlotNode] = useState<HTMLDivElement | null>(null);
  // Screens that draw their own HUD right now (the chat): the default one steps aside.
  const [hudClaims, setHudClaims] = useState(0);
  const claimHud = useCallback(() => {
    setHudClaims((count) => count + 1);
    return () => setHudClaims((count) => count - 1);
  }, []);
  // Screens that draw the crumbs themselves right now (the chat header bar).
  const [crumbClaims, setCrumbClaims] = useState(0);
  const claimCrumbs = useCallback(() => {
    setCrumbClaims((count) => count + 1);
    return () => setCrumbClaims((count) => count - 1);
  }, []);
  const hudContext = useMemo<KabinaHudContextValue>(
    () => ({ live, headerSlot: headerSlotNode, claimHud, claimCrumbs }),
    [claimCrumbs, claimHud, headerSlotNode, live],
  );
  const voiceHotkey = useVoiceHotkey();
  // Every Kabina layer is pinned to the visible area (iOS keyboard), see useVisualViewportFrame.
  useVisualViewportFrame();
  // True while the voice hotkey or the voice button is physically held: releasing sends the phrase.
  const [isVoiceHeld, setIsVoiceHeld] = useState(false);
  // Voice-button presses while the overlay is open (stop and send / record again).
  const [voicePresses, setVoicePresses] = useState(0);
  // The overlay's microphone is live: the floating button glows and says «отпусти — отправить».
  const [isVoiceLive, setIsVoiceLive] = useState(false);

  const { open: openOverlay, close: closeOverlay, current: overlay } = overlays;
  const openSearch = useCallback(() => openOverlay('search'), [openOverlay]);
  const openVoice = useCallback(() => openOverlay('voice'), [openOverlay]);
  const pressVoice = useCallback(() => {
    if (overlay === 'voice') setVoicePresses((count) => count + 1);
    else openVoice();
  }, [openVoice, overlay]);

  const holdVoiceStart = useCallback(() => {
    setIsVoiceHeld(true);
    if (overlay !== 'voice') openVoice();
  }, [openVoice, overlay]);
  const holdVoiceEnd = useCallback(() => setIsVoiceHeld(false), []);
  const voiceControl = useMemo<KabinaVoiceControl>(
    () => ({ press: pressVoice, holdStart: holdVoiceStart, holdEnd: holdVoiceEnd }),
    [holdVoiceEnd, holdVoiceStart, pressVoice],
  );

  useKabinaHotkeys({
    onSearch: openSearch,
    onVoiceStart: holdVoiceStart,
    onVoiceEnd: holdVoiceEnd,
    voiceHotkey: voiceHotkey.hotkey,
  });

  // The link state is a thin strip under the header on every screen (C1); the centre
  // keeps one entry per outage — lost, then replaced by «восстановлена».
  const { state: connectionState } = connection;
  const downFor = connection.state === 'back' ? connection.downForSeconds : 0;

  useEffect(() => {
    if (connectionState === 'lost') {
      show({ id: 'net', kind: 'lost', project: 'ПАНЕЛЬ', title: 'Связь потеряна', sub: 'панель переподключается; ход на сервере идёт дальше' });
    } else if (connectionState === 'back') {
      show({ id: 'net', kind: 'ok', project: 'ПАНЕЛЬ', title: 'Связь восстановлена', sub: `не было ${downFor}\u00a0с · догрузил пропущенное` });
    } else if (notificationsRef.current.some((entry) => entry.id === 'net' && entry.kind === 'lost')) {
      // A «Связь потеряна» kept from before a reload: the link is fine now (a real loss raises it again).
      dismiss('net');
    }
    // One entry per change of state; the seconds of the outage are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState, show]);

  // Files and Settings are toggles: from them the same button, the phone «‹» and Esc return to
  // the last other screen (the chat with its dialog, a page…).
  const isToolScreen = headerCurrent === 'files' || headerCurrent === 'settings';
  useRecordKabinaReturnPoint(isToolScreen, returnLabel, overlay !== null);
  const { point: returnPoint, goBack } = useKabinaReturn();
  const toolReturn = useMemo(
    () => (isToolScreen ? { label: returnPoint.label, href: returnPoint.path, onBack: goBack } : null),
    [goBack, isToolScreen, returnPoint.label, returnPoint.path],
  );

  useEffect(() => {
    if (!isToolScreen || overlay) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      // Esc in a field clears or leaves the field; an open dialog, menu or popover closes first.
      if (target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
      if (document.querySelector('[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      // A popover or menu that closes on Esc takes this press, even when it carries no role.
      if (hasOpenEscapeLayer()) return;
      goBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [goBack, isToolScreen, overlay]);

  const filesHref = filesProjectId ? `/files?project=${encodeURIComponent(filesProjectId)}` : '/files';
  // Every phone page keeps the bottom bar (sections without a tab simply highlight none); chat hides it.
  const showPhoneNav = isPhone && layout === 'page';
  const showShellHud = hudClaims === 0;

  return (
    <KabinaHudContext.Provider value={hudContext}>
    <div
      className="kb-root kb-shell"
      data-layout={layout}
      data-phone={isPhone ? '' : undefined}
      data-bare={bare ? '' : undefined}
      data-hud=""
    >
      <div className="kb-shell-inner">
        {!bare && (
          <KabinaHeader
            isPhone={isPhone}
            crumbs={crumbClaims > 0 ? undefined : crumbs}
            searchPlaceholder={searchPlaceholder}
            filesHref={filesHref}
            current={headerCurrent}
            onOpenSearch={openSearch}
            slotRef={headerSlot ? setHeaderSlotNode : undefined}
            toolReturn={toolReturn}
          />
        )}
        {/* Limits are seen on every screen (ChatLayoutB): phone — a row under the header that
            sticks while the page scrolls; computer — the strip along the bottom edge. */}
        {showShellHud && <KabinaHud isPhone={isPhone} sticky={isPhone && layout === 'page'} />}
        {connection.state === 'lost' && (
          <ConnectionBanner
            state="lost"
            attempt={connection.attempt}
            secondsToRetry={connection.secondsToRetry}
            retryShare={connection.retryShare}
            onRetry={connection.retryNow}
          />
        )}
        {connection.state === 'back' && <ConnectionBanner state="back" downForSeconds={connection.downForSeconds} />}
        <div className="kb-shell-content">
          <KabinaVoiceContext.Provider value={voiceControl}>{children}</KabinaVoiceContext.Provider>
        </div>
      </div>

      {/* Phone chat: the floating button would sit on the composer's send button;
          DarkPhoneChat moves voice into the composer (its mic talks to the shell through
          KabinaVoiceContext). The hotkey still works. */}
      {/* Phone voice is a full screen with its own buttons; on desktop the button stays above the overlay (DarkVoice). */}
      {!(isPhone && (layout === 'app' || overlay === 'voice')) && (
        <VoiceButton
          onActivate={pressVoice}
          onHoldStart={holdVoiceStart}
          onHoldEnd={holdVoiceEnd}
          isPhone={isPhone}
          stacked={layout === 'app' && overlay !== 'voice'}
          active={overlay === 'voice'}
          live={overlay === 'voice' && isVoiceLive}
          raised={overlay === 'voice'}
          hotkey={voiceHotkey.hotkey}
          hotkeyLabel={voiceHotkey.label}
        />
      )}
      {showPhoneNav && <PhoneNav current={phoneSection} agentsBadge={live.runningCount} />}

      {overlay === 'search' && renderSearch(closeOverlay)}
      {overlay === 'voice' && renderVoice?.({
        onClose: closeOverlay,
        holding: isVoiceHeld,
        buttonPresses: voicePresses,
        isPhone,
        activeSessionId,
        activeProjectId,
        projects,
        onLiveChange: setIsVoiceLive,
      })}
    </div>
    </KabinaHudContext.Provider>
  );
}
