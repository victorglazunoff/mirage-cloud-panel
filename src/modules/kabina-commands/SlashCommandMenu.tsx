import { useEffect, useMemo, useRef, useState } from 'react';

import { Skeleton } from '@/modules/kabina';
import '@/modules/kabina-commands/kabinaCommands.css';
import CommandPreview from '@/modules/kabina-commands/CommandPreview';
import { filterCatalog, menuTerm, needsArgument } from '@/modules/kabina-commands/utils/commandMenuModel';
import type { MenuGroup } from '@/modules/kabina-commands/utils/commandMenuModel';
import { useCommandCatalog } from '@/shared/hooks/useCommandCatalog';
import { pluralRu, splitMatch } from '@/shared/utils';
import type { CommandCatalogEntry, SlashCommandPick } from '@/shared/types';

type SlashCommandMenuProps = {
  /** What is typed in the composer, with or without the leading «/» («/co», «/compact оставь цены»). */
  query: string;
  /** Open project: adds its own commands and skills to the catalog. */
  projectId: string | null;
  /** «Выполнить» (Enter, button, a /model or /effort choice): the composer runs `insertText`. */
  onPick: (cmd: SlashCommandPick) => void;
  /** Esc: the composer hides the menu; the running turn is not touched. */
  onClose: () => void;
  /** Open session, for the live /context bar and /cost numbers and the current model. */
  sessionId?: string | null;
  /** «Дополнить» (Tab): put `insertText` («/compact ») into the input without running it; falls back to onPick. */
  onComplete?: (insertText: string) => void;
  /** The highlighted command changed (the composer shows «Tab → /команда» in the input). */
  onSelectedChange?: (name: string | null) => void;
};

function SkillIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M12 3l2.4 5.6 6 .6-4.6 4 1.4 5.9L12 16l-5.2 3.1 1.4-5.9-4.6-4 6-.6z" />
    </svg>
  );
}

function isSkill(entry: CommandCatalogEntry): boolean {
  return entry.group === 'mine' || entry.execution === 'skill';
}

/**
 * Used by the chat composer (DarkChat / DarkCommands) while the input starts with «/»:
 * the grouped slash-command catalog (`GET /api/commands/catalog`) filtered by what is typed,
 * with the match highlighted, the selected row marked by a triangle and a preview card.
 * While it is mounted it owns ↑ ↓ ↵ Tab Esc (captured before the composer sees them);
 * Esc closes only the menu — the running turn is never interrupted from here.
 */
export default function SlashCommandMenu({ query, projectId, onPick, onClose, sessionId = null, onComplete, onSelectedChange }: SlashCommandMenuProps) {
  const { catalog, failed } = useCommandCatalog(projectId);
  // Highlighted command and the filter it was picked under; a new filter starts from its best match.
  const [selection, setSelection] = useState<{ term: string; name: string } | null>(null);
  // «Показать все» under a filter that hid every one of the user's own skills.
  const [isMineExpanded, setIsMineExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const term = menuTerm(query);
  const typedArgs = query.replace(/^\s*\/?\S*\s*/, '').trim();

  const groups = useMemo<MenuGroup[]>(() => {
    const filtered = filterCatalog(catalog, term);
    if (!isMineExpanded || !catalog || filtered.some((group) => group.id === 'mine')) return filtered;
    const mine = catalog.commands.filter((entry) => entry.group === 'mine');
    return mine.length ? [...filtered, { id: 'mine', label: 'МОИ · НАВЫКИ', commands: mine }] : filtered;
  }, [catalog, isMineExpanded, term]);
  const flat = useMemo(() => groups.flatMap((group) => group.commands), [groups]);
  const selectedName = selection?.term === term ? selection.name : null;
  const selected = flat.find((entry) => entry.name === selectedName) ?? flat[0] ?? null;
  const setSelectedName = (name: string) => setSelection({ term, name });
  const total = catalog?.count ?? catalog?.commands.length ?? 0;
  const mineAll = catalog?.commands.filter((entry) => entry.group === 'mine') ?? [];
  const isMineHidden = Boolean(term) && !isMineExpanded && mineAll.length > 0 && !groups.some((group) => group.id === 'mine');

  useEffect(() => {
    if (!selected) return;
    document.getElementById(`kbm-r-${selected.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const selectedCommandName = selected?.name ?? null;
  useEffect(() => {
    onSelectedChange?.(selectedCommandName);
  }, [onSelectedChange, selectedCommandName]);
  useEffect(() => () => onSelectedChange?.(null), [onSelectedChange]);

  const run = (entry: CommandCatalogEntry | null) => {
    if (!entry) return;
    if (needsArgument(entry) && !typedArgs) {
      complete(entry);
      return;
    }
    onPick({
      name: entry.name,
      insertText: typedArgs ? `${entry.name} ${typedArgs}` : entry.name,
      execution: entry.execution,
      panelAction: entry.panelAction ?? undefined,
    });
  };

  function complete(entry: CommandCatalogEntry | null) {
    if (!entry) return;
    const text = `${entry.name} `;
    if (onComplete) onComplete(text);
    else onPick({ name: entry.name, insertText: text, execution: entry.execution, panelAction: entry.panelAction ?? undefined });
  }

  // Latest handlers for the window listener, which is attached once per mount.
  const keyStateRef = useRef({ flat, selected, run, complete, onClose, setSelectedName });
  keyStateRef.current = { flat, selected, run, complete, onClose, setSelectedName };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const state = keyStateRef.current;
      const target = event.target instanceof Element ? event.target : null;
      // A modal opened over the composer (⌘K search, voice, a dialog) owns the keyboard:
      // its arrows, Enter and Esc must not drive this menu behind it.
      const modal = target?.closest('[aria-modal="true"]');
      if (modal && rootRef.current && !modal.contains(rootRef.current)) return;
      // Buttons inside the menu (options, «Выполнить») keep their own Enter and Space.
      const onOwnButton = Boolean(target && rootRef.current?.contains(target) && target.closest('button'));
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        state.onClose();
        return;
      }
      // With nothing to choose, Enter sends the line as plain text — the composer handles it.
      if (state.flat.length === 0 || event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        const index = state.selected ? state.flat.indexOf(state.selected) : -1;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        state.setSelectedName(state.flat[(Math.max(0, index) + step + state.flat.length) % state.flat.length].name);
      } else if (event.key === 'Enter' && !event.shiftKey && !onOwnButton) {
        event.preventDefault();
        event.stopImmediatePropagation();
        state.run(state.selected);
      } else if (event.key === 'Tab' && !event.shiftKey && !onOwnButton) {
        event.preventDefault();
        event.stopImmediatePropagation();
        state.complete(state.selected);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const shownCount = flat.length;

  return (
    <div ref={rootRef} className="kbm-wrap">
      <div className="kbm-menu-col">
        <div id="kbm-menu" className="kbm-menu kb-bz" role="dialog" aria-label="Меню команд">
          <div className="kbm-head">
            <span className="kb-m kbm-slash" aria-hidden="true">/</span>
            <span className="kb-m kbm-title">КОМАНДЫ</span>
            <span className="kbm-scale" aria-hidden="true" />
            <span className="kb-m kbm-count" aria-live="polite">
              {catalog ? `${shownCount} из ${total}${term ? ` · «${term}»` : ''}` : failed ? 'каталог не пришёл' : 'гружу…'}
            </span>
            <span className="kbm-by kbm-hide-narrow">по названию и описанию</span>
          </div>

          <div className="kbm-list" role="listbox" aria-label="Подходящие команды" aria-activedescendant={selected ? `kbm-r-${selected.id}` : undefined}>
            {!catalog && !failed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '16px 14px 10px 44px' }} aria-hidden="true">
                <Skeleton width="62%" />
                <Skeleton width="78%" />
                <Skeleton width="54%" />
              </div>
            )}
            {failed && !catalog && (
              <div className="kbm-empty">
                <span style={{ fontSize: 15 }}>Каталог команд не загрузился</span>
                <span style={{ fontSize: 13, color: 'var(--kb-soft)' }}>Строка уйдёт Claude обычным текстом<span className="kb-keys"> — по ↵</span>.</span>
              </div>
            )}
            {catalog && shownCount === 0 && (
              <div className="kbm-empty">
                <span style={{ fontSize: 15 }}>Ничего не нашлось по «{term}»</span>
                <span style={{ fontSize: 13, color: 'var(--kb-soft)' }}>Строка уйдёт Claude обычным текстом<span className="kb-keys"> — по ↵</span>.</span>
              </div>
            )}
            {groups.map((group) => (
              <div key={group.id} className="kbm-group" role="group" aria-label={group.label} data-mine={group.id === 'mine' ? '' : undefined}>
                <div className="kbm-group-head">
                  <span className="kb-m kbm-group-label">{group.label}</span>
                  <span className="kbm-group-scale" aria-hidden="true" />
                  <span className="kb-m kbm-group-n">{group.commands.length}</span>
                </div>
                {group.commands.map((entry) => {
                  const isSelected = entry === selected;
                  const parts = splitMatch(entry.name.slice(1), term);
                  return (
                    <button
                      key={entry.id}
                      id={`kbm-r-${entry.id}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      className="kbm-row"
                      aria-selected={isSelected}
                      data-skill={isSkill(entry) ? '' : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (isSelected) run(entry);
                        else setSelectedName(entry.name);
                      }}
                    >
                      <svg className="kbm-ptr" width="7" height="10" viewBox="0 0 7 10" aria-hidden="true"><path d="M0 0l7 5-7 5z" fill="#FF6A2B" /></svg>
                      <span className="kbm-icon" aria-hidden="true">
                        {isSkill(entry) ? <SkillIcon /> : <span className="kb-m" style={{ fontSize: 12, lineHeight: 1 }}>/</span>}
                      </span>
                      <span className="kbm-name-cell">
                        <span className="kb-m kbm-name">
                          /{parts.before}{parts.match && <span className="kbm-hit">{parts.match}</span>}{parts.after}
                        </span>
                        {entry.args && <span className="kb-m kbm-args">{entry.args}</span>}
                      </span>
                      <span className="kbm-desc">{entry.description}</span>
                      {isSkill(entry) && <span className="kb-m kbm-tag kbm-hide-narrow">НАВЫК</span>}
                      {entry.shortcut && <span className="kb-m kbm-key kbm-hide-narrow">{entry.shortcut}</span>}
                      <span className="kb-m kbm-enter kb-keys" aria-hidden="true">↵</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {isMineHidden && (
              <div className="kbm-mine-hidden">
                <span className="kb-m kbm-group-label" style={{ color: 'var(--kb-sand)' }}>МОИ · НАВЫКИ</span>
                <span style={{ flex: '1 1 160px', fontSize: 12, color: 'var(--kb-soft)' }}>
                  {mineAll.length} {pluralRu(mineAll.length, ['навык скрыт', 'навыка скрыто', 'навыков скрыто'])} фильтром: {mineAll.slice(0, 3).map((entry) => entry.name.slice(1)).join(', ')}{mineAll.length > 3 ? '…' : ''}
                </span>
                <button type="button" className="kbm-ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => setIsMineExpanded(true)}>Показать все</button>
              </div>
            )}
          </div>

          <div className="kbm-foot kb-keys">
            <span className="kbm-k"><kbd className="kb-m">↑↓</kbd>выбрать</span>
            <span className="kbm-k"><kbd className="kb-m">↵</kbd>выполнить</span>
            <span className="kbm-k"><kbd className="kb-m">Tab</kbd>дополнить</span>
            <span style={{ flex: 1 }} />
            <span className="kbm-k"><kbd className="kb-m">Esc</kbd>закрывает меню — <span style={{ color: 'var(--kb-sage)' }}>ход не обрывает</span></span>
          </div>
        </div>
      </div>

      {selected && (
        <CommandPreview
          entry={selected}
          sessionId={sessionId}
          onRun={() => run(selected)}
          onComplete={() => complete(selected)}
          onChoose={(value) => onPick({
            name: selected.name,
            insertText: `${selected.name} ${value}`,
            execution: selected.execution,
            panelAction: selected.panelAction ?? undefined,
          })}
        />
      )}
    </div>
  );
}
