import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { KabinaToastAction, KabinaToastInput, KabinaToastKind } from '@/shared/types';

/** Oldest entries fall off past this many. */
const MAX_ITEMS = 40;
/** localStorage key of the list and its read marks (survives reloads). */
export const NOTIFICATIONS_STORAGE_KEY = 'kabina.notifications.v1';

/** One entry of the notification centre (the bell in the header). */
export type KabinaNotification = {
  id: string;
  kind: KabinaToastKind;
  project?: string;
  title: string;
  sub?: string;
  actions: KabinaToastAction[];
  /** When it was raised (or last replaced), ms. */
  createdAt: number;
  read: boolean;
};

type KabinaToastContextValue = {
  /** Newest first. */
  items: KabinaNotification[];
  unreadCount: number;
  /** An unread «Нужно твоё решение»: the bell pulses. */
  needsAttention: boolean;
  /** Adds (or replaces by id) an entry; returns its id. Nothing pops up over the screen. */
  show: (input: KabinaToastInput) => string;
  /** Removes an entry — its reason is gone (a decision was answered, the link came back). */
  dismiss: (id: string) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
};

const KabinaToastContext = createContext<KabinaToastContextValue | null>(null);

function isKind(value: unknown): value is KabinaToastKind {
  return value === 'ok' || value === 'bg' || value === 'wait' || value === 'queue' || value === 'lost' || value === 'warn';
}

/**
 * Echoes of the user's own clicks that older builds filed into the centre (⌘K closed, a question
 * or a command put into a composer, /compact queued). They are not events: dropped on load so
 * they stop inflating «N новых».
 */
function isLegacyServiceEcho(item: Partial<KabinaNotification>): boolean {
  if (item.id === 'search-closed') return true;
  const title = typeof item.title === 'string' ? item.title : '';
  return title === 'Поиск закрыт'
    || title === 'Вопрос в поле ввода главного ассистента'
    || title === 'Сжатие в очереди'
    || title.endsWith(' — в поле ввода');
}

/** Reads the stored list; actions without an address cannot outlive the page and are dropped. */
function loadStored(): KabinaNotification[] {
  try {
    const raw = window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): KabinaNotification[] => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Partial<KabinaNotification>;
      if (typeof item.id !== 'string' || typeof item.title !== 'string' || !isKind(item.kind) || typeof item.createdAt !== 'number') return [];
      if (isLegacyServiceEcho(item)) return [];
      const actions = Array.isArray(item.actions)
        ? item.actions.filter((action): action is KabinaToastAction => Boolean(action && typeof action.label === 'string' && typeof action.href === 'string'))
          .map(({ label, variant, href }) => ({ label, variant, href }))
        : [];
      return [{
        id: item.id,
        kind: item.kind,
        project: typeof item.project === 'string' ? item.project : undefined,
        title: item.title,
        sub: typeof item.sub === 'string' ? item.sub : undefined,
        actions,
        createdAt: item.createdAt,
        read: item.read === true,
      }];
    }).slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function saveStored(items: KabinaNotification[]) {
  try {
    const plain = items.map((item) => ({ ...item, actions: item.actions.map(({ label, variant, href }) => ({ label, variant, href })) }));
    window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(plain));
  } catch {
    // Private mode or a full disk: the list still works for this page.
  }
}

/**
 * Used by KabinaApp (owner) to hold the notification centre for every Kabina screen.
 * Producers keep the toast API (`show` / `dismiss`) — the shell's watchers, limits,
 * search — but nothing pops up over the screen any more: entries land in the bell's
 * list (KabinaHeader), unread until opened or «Прочитать все». The list and the read
 * marks live in localStorage.
 */
export function KabinaToastProvider({ children }: { children: ReactNode }) {
  // The centre's entries, newest first; persisted so a reload keeps what was not read yet.
  const [items, setItems] = useState<KabinaNotification[]>(loadStored);
  const counterRef = useRef(0);

  useEffect(() => {
    saveStored(items);
  }, [items]);

  const dismiss = useCallback((id: string) => {
    setItems((previous) => (previous.some((item) => item.id === id) ? previous.filter((item) => item.id !== id) : previous));
  }, []);

  const show = useCallback((input: KabinaToastInput) => {
    counterRef.current += 1;
    const id = input.id ?? `kb-note-${Date.now().toString(36)}-${counterRef.current}`;
    const entry: KabinaNotification = {
      id,
      kind: input.kind,
      project: input.project,
      title: input.title,
      sub: input.sub,
      actions: input.actions ?? [],
      createdAt: Date.now(),
      read: false,
    };
    setItems((previous) => [entry, ...previous.filter((item) => item.id !== id)].slice(0, MAX_ITEMS));
    return id;
  }, []);

  const markRead = useCallback((id: string) => {
    setItems((previous) => previous.map((item) => (item.id === id && !item.read ? { ...item, read: true } : item)));
  }, []);

  const markAllRead = useCallback(() => {
    setItems((previous) => (previous.some((item) => !item.read) ? previous.map((item) => (item.read ? item : { ...item, read: true })) : previous));
  }, []);

  const value = useMemo(() => {
    const unread = items.filter((item) => !item.read);
    return {
      items,
      unreadCount: unread.length,
      needsAttention: unread.some((item) => item.kind === 'wait'),
      show,
      dismiss,
      markRead,
      markAllRead,
    };
  }, [dismiss, items, markAllRead, markRead, show]);
  return <KabinaToastContext.Provider value={value}>{children}</KabinaToastContext.Provider>;
}

/** Used by the Kabina shell, its watchers, screens and the bell to raise, read or clear notifications. */
export function useKabinaToasts(): KabinaToastContextValue {
  const context = useContext(KabinaToastContext);
  if (!context) {
    throw new Error('useKabinaToasts must be used within KabinaToastProvider');
  }
  return context;
}
