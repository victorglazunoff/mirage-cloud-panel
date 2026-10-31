import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { IconButton } from '@/modules/kabina/ui/Button';
import { CloseIcon } from '@/modules/kabina/ui/KabinaIcons';
import { lockPageScroll } from '@/modules/kabina/utils/pageScrollLock';
import { useEscapeLayer } from '@/shared/hooks/useEscapeLayer';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
 * Whether the latest input was a key press. A dialog opened by a tap, a click or a link
 * (`/files?file=…` after a reload) moves focus in without the orange ring on «×»; one opened
 * from the keyboard keeps the ring, so the user sees where Tab stands.
 */
let lastInputWasKeyboard = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => { lastInputWasKeyboard = true; }, true);
  window.addEventListener('pointerdown', () => { lastInputWasKeyboard = false; }, true);
}

/**
 * Shared behaviour of the modal and the sheet: Esc closes, Tab stays inside,
 * focus moves in on open and returns to the opener on close, the page behind
 * neither scrolls nor jumps (lockPageScroll).
 */
function useDialogBehaviour(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement>,
  initialFocusRef?: RefObject<HTMLElement>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Esc and Tab belong to the newest open layer only (a menu or a sheet over this dialog).
  const isTopLayer = useEscapeLayer(open);

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const releaseScroll = lockPageScroll();

    const focusTimer = window.setTimeout(() => {
      const target = initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current;
      // `focusVisible` (Chrome, Firefox) keeps :focus-visible off for a dialog not opened by a key.
      target?.focus(lastInputWasKeyboard ? undefined : ({ focusVisible: false } as FocusOptions));
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== 'Escape' && event.key !== 'Tab') || !isTopLayer()) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const panel = panelRef.current;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // A click on plain text leaves focus on the panel itself (or on the page): the browser's
      // own Tab would step out of the dialog from there, so the trap picks the edge itself.
      const isOffControls = active === panel || !(active instanceof Node) || !panel.contains(active);
      if (event.shiftKey && (active === first || isOffControls)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || isOffControls)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown, true);
      releaseScroll();
      // The page must not scroll to bring the opener into view.
      opener?.focus?.({ preventScroll: true });
    };
  }, [initialFocusRef, isTopLayer, open, panelRef]);
}

/** How a modal sits on a phone (≤ 640px). */
export type ModalPhoneLayout = 'full' | 'fit';

type ModalProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible name; also the mono heading unless `header` replaces it. */
  title: string;
  /** Custom header row (the search overlay puts its input there). Pinned on a phone. */
  header?: ReactNode;
  children: ReactNode;
  /** The action buttons: pinned under the scrolling body on a phone, always in view. */
  footer?: ReactNode;
  maxWidth?: number;
  /** Vertically centred instead of hanging from the top (voice). */
  centered?: boolean;
  /**
   * Phone layout: `full` (default) — a sheet over the whole visible area, pinned to its top;
   * `fit` — a short confirmation, a bottom sheet as tall as its content.
   */
  phone?: ModalPhoneLayout;
  initialFocusRef?: RefObject<HTMLElement>;
  className?: string;
  style?: CSSProperties;
};

/**
 * Used by the shell overlays (search, voice) and later screens: the dark plate over a blurred scrim.
 * On a phone it fills the visible area (`--kb-vv-*` from useVisualViewportFrame, so an iOS keyboard
 * shrinks it instead of covering it): the header is pinned on top, the body scrolls inside, the
 * footer with the actions is pinned at the bottom.
 */
export function Modal({
  open,
  onClose,
  title,
  header,
  children,
  footer,
  maxWidth = 720,
  centered = false,
  phone = 'full',
  initialFocusRef,
  className,
  style,
}: ModalProps) {
  const panelRef = useRef<HTMLElement>(null);
  useDialogBehaviour(open, onClose, panelRef, initialFocusRef);
  if (!open) return null;

  return createPortal(
    <div className="kb-portal">
      <div className="kb-scrim" aria-hidden="true" onClick={onClose} />
      <div className="kb-modal-frame" data-center={centered ? '' : undefined} data-phone={phone}>
        <section
          ref={panelRef}
          className={`kb-modal kb-bz kb-pop${className ? ` ${className}` : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          style={{ '--kb-modal-max': `${maxWidth}px`, ...style } as CSSProperties}
        >
          <div className="kb-modal-top">
            {header ?? (
              <div className="kb-modal-head">
                <h2 className="kb-m kb-modal-title">{title}</h2>
                <div className="kb-spacer" />
                <IconButton aria-label="Закрыть (Esc)" quiet onClick={onClose}>
                  <CloseIcon size={18} />
                </IconButton>
              </div>
            )}
          </div>
          <div className="kb-modal-body">{children}</div>
          {footer && <div className="kb-modal-foot">{footer}</div>}
        </section>
      </div>
    </div>,
    document.body,
  );
}

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Mono caption next to the title («165k / 1M»). */
  meta?: string;
  children: ReactNode;
  /** Pinned under the scrolling body (DarkPhoneChat: «Сжать сессию после хода»). */
  footer?: ReactNode;
  /** Phone: the sheet and its scrim stop under the HUD row, which stays in view (ChatLayoutB). */
  belowHud?: boolean;
};

/** Used on the phone by the Kabina layer: the bottom sheet with a grip, scrim and slide-up (DarkPhoneChat). */
export function Sheet({ open, onClose, title, meta, children, footer, belowHud = false }: SheetProps) {
  const panelRef = useRef<HTMLElement>(null);
  useDialogBehaviour(open, onClose, panelRef);
  if (!open) return null;

  return createPortal(
    <div className="kb-portal" data-below-hud={belowHud ? '' : undefined}>
      <div className="kb-scrim" aria-hidden="true" onClick={onClose} />
      <div className="kb-sheet-frame">
        <section ref={panelRef} className="kb-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
          <div className="kb-sheet-grip" aria-hidden="true"><span /></div>
          <div className="kb-sheet-head">
            <h2 className="kb-m kb-modal-title">{title}</h2>
            {meta && <span className="kb-m" style={{ fontSize: 10.5, color: 'var(--kb-mute)' }}>{meta}</span>}
            <div className="kb-spacer" />
            <IconButton aria-label="Закрыть" quiet onClick={onClose}>
              <CloseIcon size={18} />
            </IconButton>
          </div>
          <div className="kb-sheet-body">{children}</div>
          {footer && <div className="kb-sheet-foot">{footer}</div>}
        </section>
      </div>
    </div>,
    document.body,
  );
}
