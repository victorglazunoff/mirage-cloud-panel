import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Kbd, NO_AUTOFILL, SearchIcon, kabinaChatPath } from '@/modules/kabina';
import { ChevronRight, CloseIcon, DotsIcon, PlusIcon } from '@/modules/kabina-chat/ChatIcons';
import { sessionTitle } from '@/modules/kabina-chat/SessionsColumn';
import { useNavigatorData } from '@/modules/kabina-chat/hooks/useNavigatorData';
import { BIG_SESSION_BYTES, formatMegabytes, formatSessionTime } from '@/modules/kabina-chat/utils/chatFormat';
import {
  buildNavProjects,
  buildNavSections,
  dialogsWord,
  focusableItems,
  liveStatesBySession,
  normalizeQuery,
  parentProjectKey,
} from '@/modules/kabina-chat/utils/navigatorModel';
import { api } from '@/shared/api';
import type { NavItem, NavLiveState, NavProject, NavSession, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/** Which list the navigator opens on: the open project's dialogs or every project. */
export type ChatNavigatorTab = 'here' | 'all';

/** An archived dialog, as `GET /api/providers/sessions/archived` lists it. */
type ArchivedSession = { sessionId: string; projectId: string | null; sessionTitle: string; lastActivity: string | null };

type ChatNavigatorProps = {
  isPhone: boolean;
  project: Project;
  sessions: ProjectSession[];
  hasMore: boolean;
  currentSessionId: string | null;
  attentionSessionIds: ReadonlySet<string>;
  processingSessions: SessionActivityMap;
  /** The open dialog has a pending decision right now. */
  currentWaits: boolean;
  initialTab: ChatNavigatorTab;
  /** A project unfolded and selected on open (the project crumb opens on the open project). */
  focusProjectId?: string | null;
  onSelectCurrent: (session: ProjectSession) => void;
  /** A new empty dialog in the given project (this one or another), opened at once. */
  onNew: (projectId: string) => void;
  onNewWithSummary: (session: ProjectSession) => void;
  onRename: (sessionId: string, title: string) => Promise<boolean>;
  onArchived: (sessionId: string) => void;
  onLoadMore: () => void;
  onRestored: () => void;
  /** Closes the popover / sheet (after a jump, or Esc). */
  onClose: () => void;
};

const LED: Record<NavLiveState, string> = { run: 'kb-led-run', wait: 'kb-led-wait', idle: 'kb-led-idle' };

/**
 * Rendered by the kabina-chat screen in the dialogs popover (header crumbs, HUD) and the phone
 * sheet: a two-level jump list. Search on top (projects and dialog titles of every project),
 * «Этот проект» — the open project's dialogs with rename / archive, «Все проекты» —
 * favourites first with status, dialogs and last activity; a project unfolds its dialogs in
 * place, a dialog opens straight away. Keyboard: ↑↓ walk, ↵ open, → unfold, ← fold / back.
 */
export default function ChatNavigator(props: ChatNavigatorProps) {
  const {
    isPhone, project, sessions, hasMore, currentSessionId, attentionSessionIds, processingSessions, currentWaits,
    initialTab, focusProjectId = null, onSelectCurrent, onNew, onNewWithSummary, onRename, onArchived,
    onLoadMore, onRestored, onClose,
  } = props;
  const navigate = useNavigate();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (key: string) => `${baseId}-o-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const inputRef = useRef<HTMLInputElement>(null);
  // ↑↓ moved into the list since the last keystroke: ←→ then fold / unfold instead of moving the caret.
  const isWalkingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  // What is typed into the search: non-empty switches the tabs off for one list of matches.
  const [query, setQuery] = useState('');
  // The tab shown while not searching.
  const [tab, setTab] = useState<ChatNavigatorTab>(focusProjectId ? 'all' : initialTab);
  // Projects unfolded in place («Все проекты» and search).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(focusProjectId ? [focusProjectId] : []));
  // The row the keyboard is on (also follows the pointer); null until the list is drawn.
  const [activeKey, setActiveKey] = useState<string | null>(focusProjectId ? `p:${focusProjectId}` : null);
  // Archived dialogs of the open project (null until loaded) and whether they are unfolded.
  const [archived, setArchived] = useState<ArchivedSession[] | null>(null);
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  // The dialog whose «⋯» menu is open, and the one being renamed in place.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);

  const data = useNavigatorData(true, query);
  useEscapeFirst(Boolean(renaming), () => {
    setRenaming(null);
    inputRef.current?.focus({ preventScroll: true });
  });
  const { ensureSessions, loadMoreSessions } = data;

  const loadArchived = useCallback(async () => {
    try {
      const response = await api.getArchivedSessions();
      if (!response.ok) return;
      const body = await response.json() as { data?: { sessions?: ArchivedSession[] } };
      setArchived((body.data?.sessions ?? []).filter((session) => session.projectId === project.projectId));
    } catch {
      setArchived([]);
    }
  }, [project.projectId]);

  useEffect(() => {
    void loadArchived();
  }, [loadArchived]);

  // Desktop: typing goes to the search at once. Phone: no autofocus — the keyboard would
  // cover half of the sheet before the list is even seen.
  useEffect(() => {
    if (!isPhone) inputRef.current?.focus({ preventScroll: true });
  }, [isPhone]);

  useEffect(() => {
    if (focusProjectId && focusProjectId !== project.projectId) ensureSessions(focusProjectId);
  }, [ensureSessions, focusProjectId, project.projectId]);

  const now = new Date();
  const projects = useMemo<NavProject[]>(() => {
    if (data.board) return buildNavProjects(data.board, now);
    // Before the board arrives the open project still shows (its dialogs are known).
    return [];
    // `now` changes every render; the list follows the board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.board]);
  const liveStates = useMemo(() => liveStatesBySession(data.board?.activity ?? []), [data.board]);
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const currentSessions = useMemo<NavSession[]>(() => sessions.map((session) => ({
    id: session.id,
    projectId: project.projectId,
    title: sessionTitle(session),
    lastActivity: String(session.lastActivity ?? session.updated_at ?? '') || null,
  })), [project.projectId, sessions]);
  const archivedSessions = useMemo<NavSession[] | null>(() => archived?.map((session) => ({
    id: session.sessionId,
    projectId: project.projectId,
    title: session.sessionTitle,
    lastActivity: session.lastActivity,
  })) ?? null, [archived, project.projectId]);

  const sections = useMemo(() => buildNavSections({
    tab,
    query,
    currentProjectId: project.projectId,
    currentSessions,
    currentHasMore: hasMore,
    projects,
    expanded,
    pages: data.pages,
    archived: archivedSessions,
    isArchiveOpen,
    titleHits: data.titleHits,
  }), [archivedSessions, currentSessions, data.pages, data.titleHits, expanded, hasMore, isArchiveOpen, project.projectId, projects, query, tab]);
  const items = useMemo(() => focusableItems(sections), [sections]);

  // The active row stays valid as the list changes: the open dialog, else the first row.
  const activeIndex = items.findIndex((item) => item.key === activeKey);
  useEffect(() => {
    if (activeIndex !== -1 || items.length === 0) return;
    const current = items.find((item) => item.kind === 'session' && item.session.id === currentSessionId && !query);
    setActiveKey((current ?? items[0]).key);
  }, [activeIndex, currentSessionId, items, query]);

  // A new query starts from its first match.
  useEffect(() => {
    if (query) setActiveKey(null);
  }, [query]);

  // The keyboard's row is kept in view.
  useEffect(() => {
    if (!activeKey) return;
    const node = document.getElementById(optionId(activeKey));
    node?.scrollIntoView?.({ block: 'nearest' });
    // optionId is stable for a key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const liveOf = (session: NavSession): NavLiveState => {
    if (session.projectId === project.projectId) {
      if (attentionSessionIds.has(session.id) || (session.id === currentSessionId && currentWaits)) return 'wait';
      const activity = processingSessions.get(session.id);
      if (activity && !activity.background) return 'run';
      return liveStates.get(session.id) ?? 'idle';
    }
    return liveStates.get(session.id) ?? 'idle';
  };

  const toggleProject = (projectId: string, open?: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      const shouldOpen = open ?? !next.has(projectId);
      if (shouldOpen) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
    if ((open ?? !expanded.has(projectId)) && projectId !== project.projectId) ensureSessions(projectId);
  };

  const openSession = (projectId: string, sessionId: string) => {
    const local = projectId === project.projectId ? sessionsById.get(sessionId) : undefined;
    onClose();
    if (local) onSelectCurrent(local);
    else navigate(kabinaChatPath(projectId, sessionId));
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

  const saveRename = async () => {
    if (!renaming) return;
    const { id, title } = renaming;
    setRenaming(null);
    if (title.trim()) await onRename(id, title.trim());
    inputRef.current?.focus({ preventScroll: true });
  };

  const activate = (item: NavItem) => {
    switch (item.kind) {
      case 'new':
        onClose();
        onNew(item.projectId);
        return;
      case 'session':
        openSession(item.projectId, item.session.id);
        return;
      case 'project':
        toggleProject(item.project.id);
        return;
      case 'more':
        if (item.projectId === project.projectId) onLoadMore();
        else loadMoreSessions(item.projectId);
        return;
      case 'archive':
        setIsArchiveOpen((open) => !open);
        return;
      case 'archived':
        void restore(item.session.id);
        return;
      default:
    }
  };

  const switchTab = (next: ChatNavigatorTab) => {
    setTab(next);
    setActiveKey(next === 'all' ? `p:${project.projectId}` : null);
    if (next === 'all') setExpanded((current) => (current.size ? current : new Set([project.projectId])));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // The rename field and the «⋯» menu keep their own keys.
    if (target.dataset.navRename !== undefined || menuFor) return;
    const isSearch = target === inputRef.current;
    const active = activeIndex >= 0 ? items[activeIndex] : null;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (items.length === 0) return;
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const from = activeIndex === -1 ? (step === 1 ? -1 : items.length) : activeIndex;
        const next = Math.min(items.length - 1, Math.max(0, from + step));
        setActiveKey(items[next].key);
        isWalkingRef.current = true;
        if (!isSearch) inputRef.current?.focus({ preventScroll: true });
        return;
      }
      case 'Enter':
        if (!active || (!isSearch && target.closest('button, a') && !target.closest('[role="option"]'))) return;
        event.preventDefault();
        activate(active);
        return;
      case 'ArrowRight': {
        // Inside typed text the arrows move the caret until ↑↓ moved into the list.
        if (isSearch && query && !isWalkingRef.current) return;
        if (active?.kind === 'project') {
          event.preventDefault();
          if (!active.expanded) toggleProject(active.project.id, true);
          else {
            const child = items[activeIndex + 1];
            if (child && parentProjectKey(child) === active.key) setActiveKey(child.key);
          }
          return;
        }
        if (!query && tab === 'here') {
          event.preventDefault();
          switchTab('all');
        }
        return;
      }
      case 'ArrowLeft': {
        // Inside typed text the arrows move the caret until ↑↓ moved into the list.
        if (isSearch && query && !isWalkingRef.current) return;
        const parent = active ? parentProjectKey(active) : null;
        if (parent) {
          event.preventDefault();
          setActiveKey(parent);
          return;
        }
        if (active?.kind === 'project' && active.expanded) {
          event.preventDefault();
          toggleProject(active.project.id, false);
          return;
        }
        if (!query && tab === 'all') {
          event.preventDefault();
          switchTab('here');
        }
        return;
      }
      default:
    }
  };

  const renderSessionRow = (item: Extract<NavItem, { kind: 'session' }>, isActive: boolean) => {
    const { session } = item;
    const isCurrent = session.id === currentSessionId;
    const live = liveOf(session);
    const local = session.projectId === project.projectId ? sessionsById.get(session.id) : undefined;
    const bytes = typeof local?.transcriptBytes === 'number' ? local.transcriptBytes : 0;
    const isBig = bytes >= BIG_SESSION_BYTES;
    const time = live === 'wait' ? 'ждёт тебя' : live === 'run' ? 'работает' : formatSessionTime(session.lastActivity ?? undefined);
    const isMenuOpen = menuFor === session.id;
    const canManage = Boolean(local) && item.depth === 0 && !query;

    if (renaming?.id === session.id) {
      return (
        <div key={item.key} className="kbn-row-wrap" role="none">
          <div className="kbn-rename">
            <label htmlFor={`${baseId}-rename`} className="kb-sr">Новое имя диалога</label>
            <input
              {...NO_AUTOFILL}
              id={`${baseId}-rename`}
              data-nav-rename=""
              type="text"
              autoCapitalize="sentences"
              enterKeyHint="done"
              className="kbc-rename"
              autoFocus
              value={renaming.title}
              onChange={(event) => setRenaming({ id: session.id, title: event.target.value })}
              onBlur={() => void saveRename()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveRename();
                // Esc is taken earlier (useEscapeFirst) so the popover stays open.
              }}
            />
          </div>
        </div>
      );
    }

    return (
      <div key={item.key} className="kbn-row-wrap" role="none" data-depth={item.depth} data-manage={canManage ? '' : undefined}>
        <div
          id={optionId(item.key)}
          role="option"
          aria-selected={isActive}
          aria-current={isCurrent ? 'page' : undefined}
          className="kbn-row kbn-srow"
          data-active={isActive ? '' : undefined}
          data-current={isCurrent ? '' : undefined}
          onMouseMove={() => !isActive && setActiveKey(item.key)}
          onClick={() => activate(item)}
        >
          <span className={`kb-led ${LED[live]}`} aria-hidden="true" />
          <span className="kbn-srow-text">
            <span className="kbn-title"><Highlight text={session.title} query={query} /></span>
            {(session.projectName && item.projectId !== project.projectId) || isBig ? (
              <span className="kbn-sub kb-m">
                {session.projectName && item.projectId !== project.projectId ? session.projectName : null}
                {isBig ? <span className="kbn-big">большая · {formatMegabytes(bytes)}</span> : null}
              </span>
            ) : null}
          </span>
          <span className="kbn-time kb-m" data-tone={live}>{isCurrent && live === 'idle' ? 'открыт' : time}</span>
        </div>
        {canManage && local && (
          <>
            <button
              type="button"
              className="kbn-dots"
              aria-label={`Действия с диалогом «${session.title}»`}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              tabIndex={-1}
              onClick={() => setMenuFor(isMenuOpen ? null : session.id)}
            >
              <DotsIcon />
            </button>
            {isMenuOpen && (
              <NavRowMenu onClose={() => setMenuFor(null)}>
                {isBig && (
                  <button type="button" role="menuitem" className="kbc-menu-item" data-tone="sand" onClick={() => {
                    setMenuFor(null);
                    onClose();
                    onNewWithSummary(local);
                  }}
                  >
                    Новый диалог с выжимкой
                  </button>
                )}
                <button type="button" role="menuitem" className="kbc-menu-item" onClick={() => {
                  setMenuFor(null);
                  setRenaming({ id: session.id, title: session.title });
                }}
                >
                  Переименовать
                </button>
                <button type="button" role="menuitem" className="kbc-menu-item" onClick={() => void archive(session.id)}>
                  В архив
                </button>
              </NavRowMenu>
            )}
          </>
        )}
      </div>
    );
  };

  const renderItem = (item: NavItem) => {
    const isActive = item.key === activeKey;
    const common = {
      id: optionId(item.key),
      role: 'option' as const,
      'aria-selected': isActive,
      'data-active': isActive ? '' : undefined,
      onMouseMove: () => {
        if (!isActive) setActiveKey(item.key);
      },
      onClick: () => activate(item),
    };
    switch (item.kind) {
      case 'session':
        return renderSessionRow(item, isActive);
      case 'new': {
        const name = item.projectId === project.projectId ? null : projects.find((entry) => entry.id === item.projectId)?.name;
        return (
          <div key={item.key} className="kbn-row-wrap" role="none" data-depth={item.depth}>
            <div {...common} className="kbn-row kbn-new">
              <PlusIcon size={14} />
              <span className="kbn-title">{item.depth === 1 && name ? `Новый диалог в ${name}` : 'Новый диалог'}</span>
              {item.depth === 0 && !isPhone && <span className="kbn-time kb-m">⌘N</span>}
            </div>
          </div>
        );
      }
      case 'project': {
        const entry = item.project;
        const isHere = entry.id === project.projectId;
        const meta = [entry.statusWord, dialogsWord(entry.sessionCount), entry.lastLabel].filter(Boolean).join(' · ');
        return (
          <div key={item.key} className="kbn-row-wrap" role="none">
            <div {...common} aria-expanded={item.expanded} className="kbn-row kbn-prow" data-expanded={item.expanded ? '' : undefined}>
              <span className="kbn-mark kb-t" aria-hidden="true" data-status={entry.status}>{entry.name.slice(0, 1).toUpperCase()}</span>
              <span className="kbn-srow-text">
                <span className="kbn-title">
                  <span className="kbn-name"><Highlight text={entry.name} query={query} /></span>
                  {isHere && <span className="kbn-here kb-m">здесь</span>}
                </span>
                <span className="kbn-sub kb-m">
                  <span className={`kb-led ${LED[entry.status]}`} aria-hidden="true" />
                  <span data-tone={entry.status}>{meta}</span>
                </span>
              </span>
              <ChevronRight size={14} className="kbn-chev" />
            </div>
          </div>
        );
      }
      case 'more':
        return (
          <div key={item.key} className="kbn-row-wrap" role="none" data-depth={item.depth}>
            <div {...common} className="kbn-row kbn-more kb-m">
              {item.remaining ? `ещё ${item.remaining}` : 'ещё диалоги'}
            </div>
          </div>
        );
      case 'loading':
        return (
          <div key={item.key} className="kbn-row-wrap" role="none" data-depth={1}>
            <div className="kbn-row kbn-loading kb-m" role="status">загружаю диалоги…</div>
          </div>
        );
      case 'archive':
        return (
          <div key={item.key} className="kbn-row-wrap" role="none">
            <div {...common} aria-expanded={item.open} className="kbn-row kbn-more kb-m">
              {item.open ? 'Скрыть архив' : `Архив этого проекта · ${item.count ?? '…'}`}
            </div>
          </div>
        );
      case 'archived':
        return (
          <div key={item.key} className="kbn-row-wrap" role="none">
            <div {...common} className="kbn-row kbn-srow" data-archived="">
              <span className="kb-led kb-led-idle" aria-hidden="true" />
              <span className="kbn-srow-text">
                <span className="kbn-title">{item.session.title}</span>
              </span>
              <span className="kbn-restore kb-m">вернуть</span>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  const projectsCount = projects.length;
  const isEmptySearch = Boolean(query.trim()) && sections.length === 0;

  return (
    // The keys of the whole navigator are read here (search field and rows alike).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className="kbn" data-phone={isPhone ? '' : undefined} onKeyDown={onKeyDown}>
      <div className="kbn-search">
        <SearchIcon stroke="#948C7E" />
        <label htmlFor={`${baseId}-q`} className="kb-sr">Найти проект или диалог</label>
        <input
          {...NO_AUTOFILL}
          ref={inputRef}
          id={`${baseId}-q`}
          type="search"
          enterKeyHint="go"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
          placeholder="Проект или диалог…"
          value={query}
          onChange={(event) => {
            isWalkingRef.current = false;
            setQuery(event.target.value);
          }}
        />
        {query ? (
          <button type="button" className="kbn-clear" aria-label="Очистить поиск" onClick={() => {
            setQuery('');
            inputRef.current?.focus({ preventScroll: true });
          }}
          >
            <CloseIcon size={14} />
          </button>
        ) : (!isPhone && <Kbd>Esc</Kbd>)}
      </div>

      {!query && (
        <div className="kbn-tabs" role="tablist" aria-label="Что показать">
          <button type="button" role="tab" aria-selected={tab === 'here'} className="kbn-tab" onClick={() => switchTab('here')}>
            <span className="kbn-tab-label">Этот проект</span>
            <span className="kbn-tab-meta kb-m">{sessions.length}{hasMore ? '+' : ''}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'all'} className="kbn-tab" onClick={() => switchTab('all')}>
            <span className="kbn-tab-label">Все проекты</span>
            <span className="kbn-tab-meta kb-m">{data.board ? projectsCount : '…'}</span>
          </button>
        </div>
      )}

      <div ref={listRef} id={listId} className="kbn-list" role="listbox" aria-label={query ? 'Найдено' : tab === 'here' ? `Диалоги проекта ${project.displayName}` : 'Все проекты'}>
        {sections.map((section) => (
          <div key={section.id} role="group" aria-labelledby={`${baseId}-g-${section.id}`} className="kbn-group">
            <div id={`${baseId}-g-${section.id}`} className="kbn-ruler kb-m" role="presentation">
              <span>{section.id === 'here' && !query ? project.displayName.toUpperCase() : section.title}</span>
              {typeof section.count === 'number' && <span className="kbn-ruler-n">{section.count}</span>}
            </div>
            {section.items.map(renderItem)}
          </div>
        ))}
        {!query && tab === 'all' && !data.board && (
          <p className="kbn-note kb-m" role="status">{data.boardError ? 'не удалось загрузить проекты' : 'загружаю проекты…'}</p>
        )}
        {query && data.isSearching && <p className="kbn-note kb-m" role="status">ищу в названиях диалогов всех проектов…</p>}
        {isEmptySearch && !data.isSearching && (
          <p className="kbn-note" role="status">Ничего с «{query.trim()}» — ни проекта, ни диалога. Полнотекстовый поиск по переписке — ⌘K.</p>
        )}
      </div>

      {!isPhone && (
        <div className="kbn-foot">
          <span className="kbn-keys kb-m" aria-hidden="true">
            <Kbd>↑↓</Kbd> выбор <Kbd>↵</Kbd> открыть <Kbd>←→</Kbd> {tab === 'all' || query ? 'раскрыть' : 'проекты'}
          </span>
          <Link className="kbn-all kb-lnk" to="/projects" onClick={onClose}>
            <span>Страница проектов</span>
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      )}
    </div>
  );
}

/** The matched part of a title, marked (search); the rest as is. */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = normalizeQuery(query);
  if (!needle) return <>{text}</>;
  const at = text.toLocaleLowerCase('ru').replace(/ё/g, 'е').indexOf(needle);
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="kbn-hl">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

/**
 * Esc for an inner layer (row menu, rename field) before the popover / sheet sees it: their
 * listeners sit on `document` in the capture phase, so this one listens on `window`.
 */
function useEscapeFirst(active: boolean, onEscape: () => void) {
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      handlerRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
}

/** The «⋯» menu of a dialog row; closes on a click outside or Esc. */
function NavRowMenu({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener('pointerdown', onPointer);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', onPointer);
  }, []);
  // The menu closes, the navigator stays.
  useEscapeFirst(true, onClose);
  return <div ref={menuRef} role="menu" className="kbc-menu kbn-menu kb-fadein">{children}</div>;
}
