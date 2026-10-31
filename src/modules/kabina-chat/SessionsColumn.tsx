import { useCallback, useEffect, useRef, useState } from 'react';

import { NO_AUTOFILL } from '@/modules/kabina';
import { DotsIcon, PlusIcon } from '@/modules/kabina-chat/ChatIcons';
import { BIG_SESSION_BYTES, formatMegabytes, formatSessionTime } from '@/modules/kabina-chat/utils/chatFormat';
import { api } from '@/shared/api';
import type { ProjectSession, SessionActivityMap } from '@/shared/types';
import { useEscapeLayer } from '@/shared/hooks/useEscapeLayer';

/** An archived session of this project, as `GET /api/providers/sessions/archived` lists it. */
type ArchivedSession = { sessionId: string; projectId: string | null; sessionTitle: string; lastActivity: string | null };

type SessionsColumnProps = {
  projectId: string;
  sessions: ProjectSession[];
  hasMore: boolean;
  currentSessionId: string | null;
  /** Sessions whose turn waits for the user (permission or question). */
  attentionSessionIds: ReadonlySet<string>;
  processingSessions: SessionActivityMap;
  /** The open session has a pending decision right now. */
  currentWaits: boolean;
  onSelect: (session: ProjectSession) => void;
  onNew: () => void;
  onNewWithSummary: (session: ProjectSession) => void;
  onRename: (sessionId: string, title: string) => Promise<boolean>;
  /** Archives the session on the server and drops it from the list. */
  onArchived: (sessionId: string) => void;
  onLoadMore: () => void;
  onRestored: () => void;
};

export function sessionTitle(session: ProjectSession): string {
  return String(session.summary || session.title || session.name || 'Новый диалог');
}

/**
 * Rendered by the kabina-chat screen in the left column: «01 ДИАЛОГИ · N» —
 * new dialog, every session of the project with its status shape (circle
 * working, diamond waiting, dark idle), «большая · N МБ — начни новый», and the
 * «⋯» menu (rename, archive, new dialog with a summary). «Архив · N» unfolds
 * the project's archived sessions with «Вернуть».
 */
export default function SessionsColumn({
  projectId,
  sessions,
  hasMore,
  currentSessionId,
  attentionSessionIds,
  processingSessions,
  currentWaits,
  onSelect,
  onNew,
  onNewWithSummary,
  onRename,
  onArchived,
  onLoadMore,
  onRestored,
}: SessionsColumnProps) {
  // Session whose «⋯» menu is open.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Session being renamed in place, with the draft title.
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // Archived sessions of this project (null until loaded) and whether the archive list is unfolded.
  const [archived, setArchived] = useState<ArchivedSession[] | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const loadArchived = useCallback(async () => {
    try {
      const response = await api.getArchivedSessions();
      if (!response.ok) return;
      const body = await response.json() as { data?: { sessions?: ArchivedSession[] } };
      setArchived((body.data?.sessions ?? []).filter((session) => session.projectId === projectId));
    } catch {
      setArchived([]);
    }
  }, [projectId]);

  useEffect(() => {
    void loadArchived();
  }, [loadArchived]);

  // The row menu is an Esc layer.
  const isMenuTopLayer = useEscapeLayer(Boolean(menuFor));
  useEffect(() => {
    if (!menuFor) return undefined;
    const close = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuFor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isMenuTopLayer()) return;
      event.preventDefault();
      setMenuFor(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [isMenuTopLayer, menuFor]);

  const archive = async (sessionId: string) => {
    setMenuFor(null);
    try {
      const response = await api.deleteSession(sessionId);
      if (response.ok) {
        onArchived(sessionId);
        void loadArchived();
      }
    } catch (error) {
      console.error('Archive session failed:', error);
    }
  };

  const restore = async (sessionId: string) => {
    try {
      const response = await api.restoreSession(sessionId);
      if (response.ok) {
        setArchived((current) => current?.filter((session) => session.sessionId !== sessionId) ?? current);
        onRestored();
      }
    } catch (error) {
      console.error('Restore session failed:', error);
    }
  };

  const saveRename = async () => {
    if (!renaming) return;
    const { id, title } = renaming;
    setRenaming(null);
    if (title.trim()) await onRename(id, title.trim());
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 auto', minHeight: 0 }}>
      <div className="kbc-head-row">
        <span className="kbc-ruler-n kb-m" aria-hidden="true">01</span>
        <h2 className="kbc-ruler-title kb-m">{showArchive ? 'АРХИВ' : 'ДИАЛОГИ'} · {showArchive ? archived?.length ?? 0 : sessions.length}{!showArchive && hasMore ? '+' : ''}</h2>
        <div style={{ flex: '1 1 0' }} />
        <button
          type="button"
          className="kb-lnk"
          style={{ minHeight: 32, display: 'inline-flex', alignItems: 'center', fontSize: 12, color: 'var(--kb-soft)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          aria-expanded={showArchive}
          onClick={() => setShowArchive((value) => !value)}
        >
          {showArchive ? '← Диалоги' : `Архив · ${archived?.length ?? '…'}`}
        </button>
      </div>

      {!showArchive && (
        <button type="button" className="kbc-new" onClick={onNew}>
          <PlusIcon size={14} />
          <span style={{ flex: 1 }}>Новый диалог</span>
          <span className="kb-m kb-keys" style={{ fontSize: 10.5, color: 'var(--kb-mute)' }}>⌘N</span>
        </button>
      )}

      <div className="kbc-sessions">
        {showArchive && archived?.length === 0 && <p className="kbc-empty" style={{ padding: '8px 4px' }}>В архиве этого проекта пусто.</p>}
        {showArchive && archived?.map((session) => (
          <div key={session.sessionId} className="kbc-srow">
            <span className="kbc-srow-link" style={{ cursor: 'default' }}>
              <span className="kb-led kb-led-idle" style={{ marginTop: 6 }} />
              <span className="kbc-srow-text">
                <span className="kbc-srow-title">{session.sessionTitle}</span>
                <span className="kbc-srow-time kb-m">{formatSessionTime(session.lastActivity ?? undefined)}</span>
              </span>
            </span>
            <button type="button" className="kbc-btn-sm" style={{ marginTop: 6, minHeight: 30 }} onClick={() => void restore(session.sessionId)}>
              Вернуть
            </button>
          </div>
        ))}

        {!showArchive && sessions.map((session) => {
          const isCurrent = session.id === currentSessionId;
          const activity = processingSessions.get(session.id);
          const waits = attentionSessionIds.has(session.id) || (isCurrent && currentWaits);
          const runs = Boolean(activity && !activity.background);
          const dot = waits ? 'kb-led-wait' : runs ? 'kb-led-run' : 'kb-led-idle';
          const bytes = typeof session.transcriptBytes === 'number' ? session.transcriptBytes : 0;
          const isBig = bytes >= BIG_SESSION_BYTES;
          const time = waits ? 'сейчас · ждёт тебя' : runs ? 'сейчас · работает' : formatSessionTime(String(session.lastActivity ?? session.updated_at ?? ''));
          const isMenuOpen = menuFor === session.id;
          const title = sessionTitle(session);
          return (
            <div key={session.id} className="kbc-srow" data-current={isCurrent ? '' : undefined}>
              {renaming?.id === session.id ? (
                <div style={{ flex: 1, padding: '6px 4px 6px 12px' }}>
                  <label htmlFor={`kbc-rename-${session.id}`} className="kb-sr">Новое имя диалога</label>
                  <input
                    {...NO_AUTOFILL}
                    type="text"
                    autoCapitalize="sentences"
                    enterKeyHint="done"
                    id={`kbc-rename-${session.id}`}
                    className="kbc-rename"
                    autoFocus
                    value={renaming.title}
                    onChange={(event) => setRenaming({ id: session.id, title: event.target.value })}
                    onBlur={() => void saveRename()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveRename();
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="kbc-srow-link"
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={() => onSelect(session)}
                >
                  <span className={`kb-led ${dot}`} style={{ marginTop: 6 }} />
                  <span className="kbc-srow-text">
                    <span className="kbc-srow-title">{title}</span>
                    <span className="kbc-srow-time kb-m">{time}</span>
                    {isBig && <span className="kbc-srow-big kb-m">большая · {formatMegabytes(bytes)} — начни новый</span>}
                  </span>
                </button>
              )}
              <button
                type="button"
                className="kbc-dots"
                aria-label="Действия с диалогом"
                aria-haspopup="menu"
                aria-expanded={isMenuOpen}
                onClick={() => setMenuFor(isMenuOpen ? null : session.id)}
              >
                <DotsIcon />
              </button>
              {isMenuOpen && (
                <div ref={menuRef} role="menu" className="kbc-menu kb-fadein">
                  {isBig && (
                    <button type="button" role="menuitem" className="kbc-menu-item" data-tone="sand" onClick={() => {
                      setMenuFor(null);
                      onNewWithSummary(session);
                    }}
                    >
                      Новый диалог с выжимкой
                    </button>
                  )}
                  <button type="button" role="menuitem" className="kbc-menu-item" onClick={() => {
                    setMenuFor(null);
                    setRenaming({ id: session.id, title });
                  }}
                  >
                    Переименовать
                  </button>
                  <button type="button" role="menuitem" className="kbc-menu-item" onClick={() => void archive(session.id)}>
                    В архив
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {!showArchive && hasMore && (
          <button type="button" className="kbc-more kb-m" onClick={onLoadMore}>ещё диалоги</button>
        )}
      </div>
    </div>
  );
}
