import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';

import { useKabinaToasts } from '@/modules/kabina/context/KabinaToastContext';
import type { KabinaNotification } from '@/modules/kabina/context/KabinaToastContext';
import { Button, IconButton } from '@/modules/kabina/ui/Button';
import { BellIcon, CheckIcon, CloseIcon, LayersIcon, QueueIcon, WarnTriangleIcon, WifiOffIcon } from '@/modules/kabina/ui/KabinaIcons';
import { StatusShape } from '@/modules/kabina/ui/StatusShape';
import { toPanelWall } from '@/modules/kabina/ui/panelTime';
import { useEscapeLayer } from '@/shared/hooks/useEscapeLayer';
import type { KabinaToastAction, KabinaToastKind } from '@/shared/types';

function NotificationIcon({ kind }: { kind: KabinaToastKind }) {
  switch (kind) {
    case 'ok':
      return <CheckIcon />;
    case 'bg':
      return <LayersIcon />;
    case 'wait':
      return <StatusShape kind="wait" />;
    case 'queue':
      return <QueueIcon />;
    case 'warn':
      return <WarnTriangleIcon />;
    default:
      return <WifiOffIcon />;
  }
}

/** «только что», «12 мин», «3 ч», then the panel-zone date. */
export function formatNotificationAge(createdAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  const wall = toPanelWall(createdAt);
  return `${String(wall.getUTCDate()).padStart(2, '0')}.${String(wall.getUTCMonth() + 1).padStart(2, '0')}`;
}

type NotificationListProps = {
  items: KabinaNotification[];
  now: number;
  /** An action was chosen: the entry is read, the panel may close. */
  onAction: (item: KabinaNotification, action: KabinaToastAction) => void;
  onRemove: (id: string) => void;
};

/**
 * The entries of the notification centre: icon, project, title, detail, age and the
 * entry's actions; unread ones carry the signal mark. Used by the bell's panel and by
 * the /states showcase (DarkStates 01).
 */
export function NotificationList({ items, now, onAction, onRemove }: NotificationListProps) {
  if (items.length === 0) {
    return (
      <p className="kb-note-empty">
        Пока тихо. Сюда придут законченные ходы, фоновые агенты, решения, лимиты и связь.
      </p>
    );
  }
  return (
    <ul className="kb-note-list">
      {items.map((item) => (
        <li key={item.id} className="kb-note" data-kind={item.kind} data-unread={item.read ? undefined : ''}>
          <span className="kb-note-icon" aria-hidden="true"><NotificationIcon kind={item.kind} /></span>
          <div className="kb-note-text">
            <div className="kb-note-top">
              {item.project && <span className="kb-m kb-note-proj">{item.project}</span>}
              <span className="kb-m kb-note-age">{formatNotificationAge(item.createdAt, now)}</span>
            </div>
            <span className="kb-note-title">
              {!item.read && <span className="kb-sr">Новое: </span>}
              {item.title}
            </span>
            {item.sub && <span className="kb-m kb-note-sub">{item.sub}</span>}
            {item.actions.length > 0 && (
              <div className="kb-note-actions">
                {item.actions.map((action) => (action.href ? (
                  <Link
                    key={action.label}
                    to={action.href}
                    className={`kb-btn kb-${action.variant ?? 'ghost'}`}
                    data-size="sm"
                    onClick={() => onAction(item, action)}
                  >
                    {action.label}
                  </Link>
                ) : (
                  <Button key={action.label} size="sm" variant={action.variant ?? 'ghost'} onClick={() => onAction(item, action)}>
                    {action.label}
                  </Button>
                )))}
              </div>
            )}
          </div>
          <IconButton aria-label={`Убрать: ${item.title}`} size="sm" quiet className="kb-note-x" onClick={() => onRemove(item.id)}>
            <CloseIcon />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

function plural(count: number, one: string, few: string, many: string) {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

/**
 * Used by the computer HUD (KabinaHud, the bell's place since ChatLayoutB — the list opens
 * up from the bottom strip), the phone header (KabinaHeader) and the phone chat header
 * (kabina-chat draws its own): the bell of the notification centre. The badge counts unread entries; an
 * unread «Нужно твоё решение» makes the bell pulse — nothing else ever covers the screen.
 * A press opens the list: a drop-down under the bell on a computer, a sheet from the top
 * on the phone (inside the visible area).
 */
export function NotificationBell({ isPhone, placement = 'header' }: { isPhone: boolean; placement?: 'header' | 'hud' }) {
  const { items, unreadCount, needsAttention, markRead, markAllRead, dismiss } = useKabinaToasts();
  // The list is open (drop-down on a computer, top sheet on the phone).
  const [isOpen, setIsOpen] = useState(false);
  // «Now» for the ages, refreshed while the list is open.
  const [now, setNow] = useState(() => Date.now());
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const location = useLocation();

  const close = useCallback((returnFocus = false) => {
    setIsOpen(false);
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  // Navigating anywhere closes the list.
  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname]);

  // Esc closes only the newest open layer (the list, unless something opened over it).
  const isTopLayer = useEscapeLayer(isOpen);

  useEffect(() => {
    if (!isOpen) return undefined;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTopLayer()) {
        event.stopPropagation();
        event.preventDefault();
        close(true);
      }
    };
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (wrapRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('pointerdown', handlePointer, true);
    const focusTimer = window.setTimeout(() => panelRef.current?.focus({ preventScroll: true }), 0);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('pointerdown', handlePointer, true);
    };
  }, [close, isOpen, isTopLayer]);

  const handleAction = (item: KabinaNotification, action: KabinaToastAction) => {
    markRead(item.id);
    action.onClick?.();
    close();
  };

  const label = unreadCount > 0
    ? `Уведомления: ${unreadCount} ${plural(unreadCount, 'новое', 'новых', 'новых')}${needsAttention ? ', нужно твоё решение' : ''}`
    : 'Уведомления';

  const panel = isOpen && (
    <section
      ref={panelRef}
      className={isPhone ? 'kb-notes' : 'kb-notes kb-bz'}
      data-phone={isPhone ? '' : undefined}
      data-placement={placement}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="kb-notes-head">
        <h2 id={titleId} className="kb-m kb-notes-title">УВЕДОМЛЕНИЯ</h2>
        {unreadCount > 0 && <span className="kb-m kb-notes-count">{unreadCount} {plural(unreadCount, 'новое', 'новых', 'новых')}</span>}
        <span className="kb-spacer" />
        <Button size="sm" variant="ghost" className="kb-notes-readall" disabled={unreadCount === 0} onClick={markAllRead}>
          Прочитать все
        </Button>
        {isPhone && (
          <IconButton aria-label="Закрыть уведомления" quiet onClick={() => close(true)}>
            <CloseIcon size={16} />
          </IconButton>
        )}
      </header>
      <div className="kb-notes-scroll">
        <NotificationList items={items} now={now} onAction={handleAction} onRemove={dismiss} />
      </div>
    </section>
  );

  return (
    <div ref={wrapRef} className="kb-bell-wrap" data-placement={placement}>
      <button
        ref={buttonRef}
        type="button"
        className="kb-ib kb-bell"
        aria-label={label}
        title="Уведомления"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-attention={needsAttention ? '' : undefined}
        onClick={() => setIsOpen((open) => !open)}
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="kb-m kb-bell-badge" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>
      {panel && (isPhone && typeof document !== 'undefined'
        ? createPortal(
          <div className="kb-portal">
            <div className="kb-scrim kb-notes-scrim" aria-hidden="true" />
            {panel}
          </div>,
          document.body,
        )
        : panel)}
    </div>
  );
}
