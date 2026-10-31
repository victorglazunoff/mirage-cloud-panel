import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';

import { Button, kabinaChatPath, NO_AUTOFILL, StatusShape } from '@/modules/kabina';
import { ArchiveGlyph, ArrowGlyph, DotsGlyph, PencilGlyph, StarGlyph } from '@/modules/kabina-projects/ProjectsIcons';
import { sparkBars } from '@/modules/kabina-projects/utils/projectsBoardView';
import type { KabinaProjectView } from '@/shared/types';

type ProjectItemProps = {
  project: KabinaProjectView;
  layout: 'list' | 'grid';
  isMenuOpen: boolean;
  isRenaming: boolean;
  renameValue: string;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onToggleStar: () => void;
  onToggleArchive: () => void;
  onStartRename: () => void;
  onRenameChange: (value: string) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
};

/** Hover-revealed ⋯ menu: rename, star, archive — never delete (DarkProjects). */
function ProjectMenu({ project, onStartRename, onToggleStar, onToggleArchive, onClose }: {
  project: KabinaProjectView;
  onStartRename: () => void;
  onToggleStar: () => void;
  onToggleArchive: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // The parent passes a fresh `onClose` on every render (board poll, clock tick);
  // reading it through a ref keeps the effects below from re-running.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus the first item once, when the menu opens — not on every parent render,
  // or the arrow-key choice would jump back to «Переименовать» mid-navigation.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const handlePointer = (event: PointerEvent) => {
      // The ⋯ button toggles the menu itself; any other click outside closes it.
      const wrap = menuRef.current?.parentElement;
      if (wrap && !wrap.contains(event.target as Node)) onCloseRef.current();
    };
    document.addEventListener('pointerdown', handlePointer);
    return () => document.removeEventListener('pointerdown', handlePointer);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      (menuRef.current?.previousElementSibling as HTMLElement | null)?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };

  return (
    <div ref={menuRef} className="kp-menu kb-fadein" role="menu" aria-label={`Действия с проектом «${project.name}»`} onKeyDown={handleKeyDown}>
      <button className="kp-menu-item" role="menuitem" type="button" onClick={onStartRename}>
        <PencilGlyph />Переименовать
      </button>
      <button className="kp-menu-item" role="menuitem" type="button" onClick={onToggleStar}>
        <StarGlyph size={15} />{project.isStarred ? 'Убрать из избранного' : 'В избранное'}
      </button>
      <button className="kp-menu-item" role="menuitem" type="button" onClick={onToggleArchive}>
        <ArchiveGlyph />{project.isArchived ? 'Вернуть из архива' : 'В архив'}
      </button>
      <span className="kp-menu-sep" aria-hidden="true" />
      <span className="kp-menu-note">
        Удаления здесь нет: папка <span className="kb-m">{project.folder}</span> остаётся на сервере как есть.
      </span>
    </div>
  );
}

/** Inline rename: Enter saves, Esc cancels; the folder on disk is never renamed. */
function RenameField({ id, value, onChange, onSave, onCancel }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <span className="kp-rename kb-fadein">
      <label htmlFor={id} className="kb-sr">Новое имя проекта</label>
      <input
        {...NO_AUTOFILL}
        autoCapitalize="sentences"
        enterKeyHint="done"
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSave();
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <span style={{ display: 'flex', gap: 6 }}>
        <Button variant="pri" onClick={onSave} disabled={!value.trim()}>Сохранить</Button>
        <Button variant="ghost" onClick={onCancel} style={{ color: 'var(--kb-soft)' }}>Отмена</Button>
      </span>
    </span>
  );
}

/**
 * Used by the projects screen for both layouts: the list row (star, name and
 * folder, agents, sessions, 14 days, last activity, ⋯) and the tile.
 * The name link stretches over the whole item; controls sit above it.
 */
export default function ProjectItem(props: ProjectItemProps) {
  const { project, layout, isMenuOpen, isRenaming } = props;
  const isQuiet = project.isDim || project.isArchived;
  const favLabel = project.isStarred ? `Убрать «${project.name}» из избранного` : `Добавить «${project.name}» в избранное`;
  const bars = sparkBars(project.activityByDay, project.isLive, project.isDim, project.activityPeak);
  const dataProps = {
    'data-dim': isQuiet ? '' : undefined,
    'data-wait': project.kind === 'wait' ? '' : undefined,
    'data-raised': isMenuOpen || isRenaming ? '' : undefined,
  };

  // Archived projects are not loaded into the chat, so their name is plain text; «Вернуть» is in the menu.
  const nameNode = project.isArchived
    ? <span className="kp-name">{project.name}</span>
    : <Link className="kp-name kp-stretch" to={kabinaChatPath(project.id)}>{project.name}</Link>;

  const starButton = (
    <button
      className="kp-star kp-ib"
      type="button"
      onClick={props.onToggleStar}
      aria-pressed={project.isStarred}
      aria-label={favLabel}
      title={favLabel}
    >
      <StarGlyph size={layout === 'list' ? 16 : 15} filled={project.isStarred} />
    </button>
  );

  const menu = (
    <div className="kp-menu-wrap">
      <button
        className="kp-menu-btn kp-ib"
        type="button"
        onClick={props.onToggleMenu}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-label={`Действия с проектом «${project.name}»`}
      >
        <DotsGlyph size={layout === 'list' ? 16 : 15} />
      </button>
      {isMenuOpen && (
        <ProjectMenu
          project={project}
          onStartRename={props.onStartRename}
          onToggleStar={props.onToggleStar}
          onToggleArchive={props.onToggleArchive}
          onClose={props.onCloseMenu}
        />
      )}
    </div>
  );

  const rename = isRenaming && (
    <RenameField
      id={`rename-${layout}-${project.id}`}
      value={props.renameValue}
      onChange={props.onRenameChange}
      onSave={props.onSaveRename}
      onCancel={props.onCancelRename}
    />
  );

  const statusText = (
    <span className="kp-status" data-kind={project.kind} data-muted={isQuiet && project.kind === 'idle' ? '' : undefined}>
      {project.status}
    </span>
  );

  if (layout === 'grid') {
    return (
      <div role="listitem" className="kp-tile kb-bz" {...dataProps}>
        <div className="kp-tile-top">
          <div className="kp-tile-id">
            {isRenaming ? rename : nameNode}
            <span className="kb-m kp-path" title={project.fullPath}>{project.shortPath}</span>
          </div>
          <div className="kp-tile-tools">
            {project.kind === 'wait' && <span className="kb-m kp-badge-wait">ЖДЁТ ТЕБЯ</span>}
            {project.kind === 'new' && <span className="kb-m kp-badge-new" style={{ alignSelf: 'center', marginRight: 4 }}>НОВЫЙ</span>}
            {starButton}
            {menu}
          </div>
        </div>
        <div className="kp-tile-spark" aria-hidden="true">
          {bars.map((bar, index) => <span key={index} data-tone={bar.tone} style={{ height: bar.height }} />)}
        </div>
        <div className="kp-tile-foot">
          {project.kind === 'new' ? <span className="kb-led kp-led-new" aria-hidden="true" /> : <StatusShape kind={project.kind} />}
          {statusText}
          <span className="kb-m kp-tile-meta">{project.sessions} · {project.last}</span>
        </div>
      </div>
    );
  }

  return (
    <div role="listitem" className="kp-row" {...dataProps}>
      {starButton}
      <div className="kp-col-name kp-name-cell">
        {isRenaming ? rename : (
          <span className="kp-name-line">
            {nameNode}
            {project.kind === 'wait' && <span className="kb-m kp-badge-wait">ЖДЁТ ТЕБЯ</span>}
            {project.kind === 'new' && <span className="kb-m kp-badge-new">НОВЫЙ</span>}
            {!project.isArchived && <ArrowGlyph className="kp-go" color="var(--kb-signal)" />}
          </span>
        )}
        <span className="kb-m kp-path" title={project.fullPath}>{project.shortPath}</span>
      </div>
      <div className="kp-col-agents kp-agents">
        {project.kind === 'new' ? <span className="kb-led kp-led-new" aria-hidden="true" /> : <StatusShape kind={project.kind} />}
        <span className="kp-agents-text">
          {statusText}
          {project.sub && <span className="kb-m kp-sub">{project.sub}</span>}
        </span>
      </div>
      <span className="kb-m kp-col-sess kp-sess" data-muted={isQuiet ? '' : undefined}>{project.sessions}</span>
      <span className="kp-col-spark kp-spark" aria-hidden="true">
        {bars.map((bar, index) => <span key={index} data-tone={bar.tone} style={{ height: bar.height }} />)}
      </span>
      <span
        className="kb-m kp-col-last kp-last"
        data-live={project.isLive ? '' : undefined}
        data-muted={isQuiet && !project.isLive ? '' : undefined}
      >
        {project.last}
      </span>
      {menu}
    </div>
  );
}
