import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { lockPageScroll, NO_AUTOFILL, Skeleton } from '@/modules/kabina';
import '@/modules/kabina-search/kabinaSearch.css';
import SearchHighlight from '@/modules/kabina-search/SearchHighlight';
import SearchPreview from '@/modules/kabina-search/SearchPreview';
import { useProjectLiveStates } from '@/modules/kabina-search/hooks/useProjectLiveStates';
import { useNarrowSearch } from '@/modules/kabina-search/hooks/useNarrowSearch';
import { useSearchPreview } from '@/modules/kabina-search/hooks/useSearchPreview';
import { useSearchResults } from '@/modules/kabina-search/hooks/useSearchResults';
import { useSearchRunner } from '@/modules/kabina-search/hooks/useSearchRunner';
import {
  SEARCH_GROUPS,
  SEARCH_SCOPES,
  buildGroups,
  countLabel,
  fileDisplayPath,
  scopeCount,
} from '@/modules/kabina-search/utils/searchModel';
import { readSearchMemory, writeSearchMemory } from '@/modules/kabina-search/utils/searchMemory';
import type { SearchRow, SearchRowKind, SearchScope } from '@/modules/kabina-search/utils/searchModel';
import { useCommandCatalog } from '@/shared/hooks/useCommandCatalog';
import { useEscapeLayer } from '@/shared/hooks/useEscapeLayer';
import { pluralRu } from '@/shared/utils';
import type { CommandCatalogEntry, KabinaProjectRef } from '@/shared/types';

type KabinaSearchProps = {
  onClose: () => void;
  projects: KabinaProjectRef[];
};

const SCOPE_TABS: Array<{ id: SearchScope; label: string }> = [
  { id: 'all', label: 'Всё' },
  ...SEARCH_GROUPS.map((group) => ({ id: group.type, label: group.tab })),
];

/** Placeholder of the field; a phone gets a short one that never breaks mid-word. */
const PLACEHOLDER_WIDE = 'Проект, диалог, файл, команда — или спроси Claude';
const PLACEHOLDER_NARROW = 'Проект, диалог, файл…';

/** Plain text of a row title for the phone preview handle. */
function rowTitleText(row: SearchRow | null): string {
  if (!row) return 'Ничего не выбрано';
  return `${row.title.before}${row.title.match}${row.title.after}`;
}

function RowIcon({ kind }: { kind: SearchRowKind }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const;
  switch (kind) {
    case 'project':
      return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
    case 'session':
      return <svg {...common}><path d="M4 5h16v11H8l-4 4z" /></svg>;
    case 'file':
      return <svg {...common}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 13h6M9 17h4" /></svg>;
    case 'command':
      return <span className="kb-m" style={{ fontSize: 13, lineHeight: 1 }}>/</span>;
    case 'action':
      return <svg {...common}><path d="M13 3L5 14h6l-1 7 8-11h-6z" /></svg>;
    default:
      return (
        <svg width="16" height="16" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="13" cy="13" r="10.5" /><path d="M2.5 15.2h21" /><path d="M8 11.2l5-3.8 5 3.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

/** The list while the answer to the typed query is on its way: row-shaped placeholders. */
function ResultsSkeleton() {
  return (
    <div className="kbs-skel" aria-hidden="true">
      <span className="kbs-skel-head"><Skeleton width={72} height={8} /></span>
      {[0.62, 0.48, 0.7, 0.55, 0.4].map((width, index) => (
        <span key={index} className="kbs-skel-row">
          <span className="kbs-skel-icon" />
          <span className="kbs-skel-text">
            <Skeleton width={`${Math.round(width * 100)}%`} height={10} />
            <Skeleton width={`${Math.round(width * 70)}%`} height={8} />
          </span>
        </span>
      ))}
      <span className="kb-sr">Ищу…</span>
    </div>
  );
}

/** The preview while the list is loading: nothing selected yet, a quiet placeholder. */
function PreviewPending() {
  return (
    <div className="kbs-pv-main" aria-hidden="true">
      <Skeleton width={64} height={8} />
      <Skeleton width="70%" height={22} />
      <Skeleton width="45%" height={9} />
    </div>
  );
}

function Key({ k, children }: { k: string; children: ReactNode }) {
  return <span className="kbs-key kb-keys"><kbd className="kb-m">{k}</kbd>{children}</span>;
}

/**
 * Used by the project-workspace module as the Kabina shell's `?search` overlay (⌘K):
 * DarkSearch — one field over projects, dialogs of every project, files, slash commands
 * and panel actions (`GET /api/search`), section tabs with counters, grouped rows with
 * highlighted matches, a preview of the selected row and «Спросить Claude» as the last row.
 */
export default function KabinaSearch({ onClose, projects }: KabinaSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // What is typed, the section and the row survive closing, a layout swap (1440 ↔ 390) and a reload.
  const [query, setQuery] = useState(() => readSearchMemory().query);
  // Section tab: «Всё» or one result type (Tab / Shift+Tab cycle it).
  const [scope, setScope] = useState<SearchScope>(() => readSearchMemory().scope);
  // Key of the highlighted row; falls back to the first row when it disappears.
  const [selectedKey, setSelectedKey] = useState<string | null>(() => readSearchMemory().selectedKey);
  const isNarrow = useNarrowSearch();
  // Phone: the preview is a bottom sheet, folded to its handle until asked for.
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  const runner = useSearchRunner(projects, onClose);
  const { response, isLoading, failed } = useSearchResults(query, runner.origin.projectId);
  const live = useProjectLiveStates();
  const { catalog } = useCommandCatalog(runner.origin.projectId);

  useEffect(() => {
    writeSearchMemory({ query, scope, selectedKey });
  }, [query, scope, selectedKey]);

  const projectPaths = useMemo(() => new Map(projects.map((project) => [project.projectId, project.path])), [projects]);
  const catalogById = useMemo(
    () => new Map<string, CommandCatalogEntry>((catalog?.commands ?? []).map((entry) => [entry.id, entry])),
    [catalog],
  );

  // Only an answer to what is typed now is shown: while the next one loads, the list is a
  // skeleton and the counters wait, instead of old rows under a new query.
  const typed = query.trim().slice(0, 200);
  const current = response !== null && response.query === typed ? response : null;
  const isPending = !failed && current === null;
  // Rows are built against the query the answer belongs to, so highlights match what is shown.
  const shownQuery = current?.query ?? typed;
  const groups = useMemo(
    () => (current ? buildGroups(current, scope, { query: shownQuery, projectPaths, liveByProject: live.states, catalogById }) : []),
    [catalogById, current, live.states, projectPaths, scope, shownQuery],
  );
  const flatRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const selected: SearchRow | null = flatRows.find((row) => row.key === selectedKey) ?? flatRows[0] ?? null;
  const selectedIndex = selected ? flatRows.indexOf(selected) : -1;

  const { preview, isLoading: isPreviewLoading } = useSearchPreview(selected?.item ?? null, shownQuery);

  // Esc reads the latest runner through a ref, so the listener is attached once per opening.
  const dismissRef = useRef(runner.dismiss);
  dismissRef.current = runner.dismiss;
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = isNarrow && isSheetOpen;

  // ⌘K is an Esc layer: a menu or sheet opened over it takes Esc first.
  const isTopLayer = useEscapeLayer(true);

  // Esc closes from anywhere inside; the page behind neither scrolls nor jumps; focus returns to the opener.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const releaseScroll = lockPageScroll();
    // The remembered query comes back selected: typing starts a new search, ← → keep the old one.
    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isTopLayer()) return;
      if (event.key === 'Escape' && sheetOpenRef.current) {
        // Phone: Esc folds the preview sheet first, the second Esc closes search.
        event.stopPropagation();
        event.preventDefault();
        setIsSheetOpen(false);
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        dismissRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown, true);
      releaseScroll();
      opener?.focus?.({ preventScroll: true });
    };
  }, [isTopLayer]);

  // Keep the highlighted row visible while walking the list with the arrows.
  useEffect(() => {
    if (!selected) return;
    const element = document.getElementById(`kbs-r-${selected.key}`);
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const pickScope = (next: SearchScope) => {
    setScope(next);
    setSelectedKey(null);
    resultsRef.current?.scrollTo?.({ top: 0 });
  };

  const openRow = (row: SearchRow | null) => {
    if (!row) return;
    if (row.kind === 'ask') runner.ask(query);
    else runner.open(row.item, query);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (flatRows.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (Math.max(0, selectedIndex) + step + flatRows.length) % flatRows.length;
      setSelectedKey(flatRows[next].key);
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      runner.ask(query);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openRow(selected);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const index = SEARCH_SCOPES.indexOf(scope);
      const step = event.shiftKey ? SEARCH_SCOPES.length - 1 : 1;
      pickScope(SEARCH_SCOPES[(index + step) % SEARCH_SCOPES.length]);
    }
  };

  const trimmed = query.trim();
  const total = current?.total ?? 0;
  const resultCount = groups.reduce((sum, group) => sum + (group.id === 'ask' ? 0 : group.rows.length), 0);
  const isEmpty = Boolean(trimmed) && !isLoading && current !== null && resultCount === 0;
  const projectCount = live.projectCount ?? projects.length;

  let note = `${projectCount} ${pluralRu(projectCount, ['проект', 'проекта', 'проектов'])} · диалоги всех проектов`;
  let noteTone: 'ok' | 'warn' | undefined;
  if (failed) {
    note = 'поиск не ответил — проверь связь';
    noteTone = 'warn';
  } else if (isPending && trimmed) {
    note = 'ищу…';
  } else if (current?.truncated) {
    note = `не всё успел за ${current.tookMs} мс — уточни запрос`;
    noteTone = 'warn';
  } else if (current && trimmed) {
    note = `${note} · ${current.tookMs} мс`;
  }

  const originProject = runner.origin.projectId ? projects.find((project) => project.projectId === runner.origin.projectId) : null;
  const selectedItem = selected?.item ?? null;
  const selectedProjectPath = selectedItem?.projectId ? projectPaths.get(selectedItem.projectId) ?? null : null;

  return createPortal(
    <div className="kb-portal">
      <div className="kb-scrim" aria-hidden="true" onClick={onClose} />
      <div className="kb-modal-frame kbs-frame">
        <section className="kb-modal kb-bz kb-pop kbs-panel" role="dialog" aria-modal="true" aria-label="Поиск по всей панели">
          <div className="kbs-head">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FF6A2B" strokeWidth="1.7" aria-hidden="true" style={{ flex: 'none' }}>
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <label htmlFor="kbs-q" className="kb-sr">Искать проекты, диалоги, файлы, команды и действия</label>
            <input
              {...NO_AUTOFILL}
              autoCorrect="off"
              autoCapitalize="off"
              enterKeyHint="search"
              id="kbs-q"
              ref={inputRef}
              className="kbs-input"
              type="text"
              value={query}
              spellCheck={false}
              role="combobox"
              aria-expanded="true"
              aria-controls="kbs-results"
              aria-activedescendant={selected ? `kbs-r-${selected.key}` : undefined}
              placeholder={isNarrow ? PLACEHOLDER_NARROW : PLACEHOLDER_WIDE}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedKey(null);
              }}
              onKeyDown={handleKeyDown}
            />
            <span className="kb-m kbs-count kbs-hide-narrow" aria-live="polite">{isPending ? (trimmed ? 'ищу…' : '') : countLabel(trimmed, total)}</span>
            <button type="button" className="kbs-esc kb-m" onClick={onClose} aria-label="Закрыть поиск (Esc)">
              <span className="kb-keys">Esc</span>
              <svg className="kb-touch-only" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>

          <div className="kbs-scopes-row">
            <div className="kbs-scopes" role="tablist" aria-label="Где искать">
              {SCOPE_TABS.map((tab) => {
                const count = scopeCount(current, tab.id);
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    className="kbs-scope"
                    aria-selected={scope === tab.id}
                    aria-controls="kbs-results"
                    data-empty={count === 0 && !isPending ? '' : undefined}
                    tabIndex={-1}
                    onClick={() => {
                      pickScope(tab.id);
                      inputRef.current?.focus();
                    }}
                  >
                    {tab.label}
                    <span className="kb-m kbs-scope-n">{isPending ? '·' : count}</span>
                  </button>
                );
              })}
            </div>
            <span className="kbs-scale" aria-hidden="true" />
            <span className="kb-m kbs-tabhint kbs-hide-narrow kb-keys">Tab — следующий раздел</span>
          </div>

          <div className="kbs-body">
            <div id="kbs-results" ref={resultsRef} className="kbs-results" role="listbox" aria-label="Результаты поиска" aria-busy={isPending}>
              {isPending && <ResultsSkeleton />}
              {isEmpty && (
                <div className="kbs-empty">
                  <span className="kb-t kbs-empty-title">По «{trimmed}» ничего</span>
                  <span className="kbs-empty-text">Ни в проектах, ни в диалогах, ни в файлах. Спроси Claude — он поищет по смыслу, а не по словам.</span>
                </div>
              )}
              {groups.map((group) => (
                <div key={group.id} className="kbs-group" role="group" aria-label={group.label} data-ask={group.id === 'ask' ? '' : undefined}>
                  <div className="kbs-group-head">
                    <span className="kb-m kbs-group-label">{group.label}</span>
                    <span className="kbs-group-scale" aria-hidden="true" />
                    {group.more > 0 && scope === 'all' ? (
                      <button type="button" className="kbs-more" tabIndex={-1} onClick={() => pickScope(group.id as SearchScope)}>
                        ещё {group.more} →
                      </button>
                    ) : (
                      <span className="kb-m kbs-group-n">{group.more > 0 ? `${group.rows.length} из ${group.count}` : group.rows.length}</span>
                    )}
                  </div>
                  {group.rows.map((row) => {
                    const isSelected = row.key === selected?.key;
                    return (
                      <button
                        key={row.key}
                        id={`kbs-r-${row.key}`}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        className="kbs-row"
                        data-kind={row.kind}
                        aria-selected={isSelected}
                        onClick={() => {
                          if (isSelected) openRow(row);
                          else setSelectedKey(row.key);
                          inputRef.current?.focus();
                        }}
                        onDoubleClick={() => openRow(row)}
                      >
                        <svg className="kbs-ptr" width="7" height="10" viewBox="0 0 7 10" aria-hidden="true"><path d="M0 0l7 5-7 5z" fill="#FF6A2B" /></svg>
                        <span className="kbs-icon" aria-hidden="true"><RowIcon kind={row.kind} /></span>
                        <span className="kbs-row-text">
                          <span className="kbs-row-line">
                            <span className={`kbs-row-title${row.kind === 'file' || row.kind === 'command' ? ' kb-m' : ''}`}>
                              <SearchHighlight parts={row.title} />
                            </span>
                            {row.projectChip && <span className="kb-m kbs-chip">{row.projectChip}</span>}
                          </span>
                          {(row.sub.before || row.sub.match) && (
                            <span className={`kbs-row-sub${row.kind === 'project' ? ' kb-m' : ''}`}>
                              <SearchHighlight parts={row.sub} />
                            </span>
                          )}
                        </span>
                        <span className="kbs-row-end">
                          {row.led && <span className={`kb-led kb-led-${row.led}`} aria-hidden="true" />}
                          {row.projectChip && <span className="kb-m kbs-chip kbs-chip-end" aria-hidden="true">{row.projectChip}</span>}
                          {row.meta && <span className={`kb-m kbs-meta${row.kind === 'ask' ? ' kb-keys' : ''}`}>{row.meta}</span>}
                          <span className="kb-m kbs-enter kb-keys" aria-hidden="true">↵</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {isNarrow && isSheetOpen && (
              <div className="kbs-sheet-scrim" aria-hidden="true" onClick={() => setIsSheetOpen(false)} />
            )}
            <aside
              id="kbs-preview"
              className="kbs-preview"
              aria-label="Превью выбранного"
              aria-live="polite"
              data-sheet={isNarrow ? (isSheetOpen ? 'open' : 'folded') : undefined}
            >
              {isNarrow && (
                <button
                  type="button"
                  className="kbs-sheet-handle"
                  aria-expanded={isSheetOpen}
                  aria-controls="kbs-preview-body"
                  onClick={() => setIsSheetOpen((open) => !open)}
                >
                  <span className="kbs-sheet-grip" aria-hidden="true" />
                  <span className="kb-m kbs-kicker">ПРЕВЬЮ</span>
                  <span className="kbs-sheet-title">{rowTitleText(selected)}</span>
                  <svg className="kbs-sheet-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
                  <span className="kb-sr">{isSheetOpen ? 'Свернуть превью' : 'Развернуть превью'}</span>
                </button>
              )}
              <div id="kbs-preview-body" className="kbs-preview-body" hidden={isNarrow && !isSheetOpen}>
                {isPending ? <PreviewPending /> : (
                <SearchPreview
                  row={selected}
                  query={shownQuery}
                  preview={preview}
                  isLoading={isPreviewLoading}
                  live={live}
                  catalogEntry={selectedItem?.type === 'command' ? catalogById.get(selectedItem.id) ?? null : null}
                  origin={runner.origin}
                  originProjectName={originProject?.displayName ?? null}
                  projectPath={selectedProjectPath}
                  onOpen={() => openRow(selected)}
                  onAsk={() => runner.ask(query)}
                  onAskExample={(question) => {
                    setQuery(question);
                    setSelectedKey('ask');
                    setScope('all');
                    inputRef.current?.focus();
                  }}
                  onShowCommands={() => {
                    pickScope('command');
                    inputRef.current?.focus();
                  }}
                  onFiles={(projectId) => runner.go(`/files?project=${encodeURIComponent(projectId)}`)}
                  onNewInProject={(projectId) => runner.go(`/p/${encodeURIComponent(projectId)}`)}
                  onMention={(relativePath) => {
                    if (selectedItem) runner.mentionFile(selectedItem, relativePath || fileDisplayPath(selectedItem, selectedProjectPath));
                  }}
                />
                )}
              </div>
            </aside>
          </div>

          <div className="kbs-foot">
            <Key k="↑↓">выбрать</Key>
            <Key k="↵">открыть</Key>
            <Key k="Tab">раздел</Key>
            <Key k="⌘↵">спросить Claude</Key>
            <Key k="Esc">закрыть</Key>
            <span style={{ flex: 1 }} />
            <span className="kb-m kbs-note" role="status" data-tone={noteTone}>{note}</span>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
