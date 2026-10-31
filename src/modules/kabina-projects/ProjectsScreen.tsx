import { useCallback, useEffect, useMemo, useState } from 'react';

import '@/modules/kabina-projects/kabinaProjects.css';
import '@/modules/kabina-projects/kabinaProjectsWizard.css';
import { Button, NO_AUTOFILL, Skeleton, StatusShape, useDelayedFlag } from '@/modules/kabina';
import NewProjectWizard from '@/modules/kabina-projects/NewProjectWizard';
import ProjectItem from '@/modules/kabina-projects/ProjectItem';
import {
  CheckGlyph,
  CrossGlyph,
  GridGlyph,
  ListGlyph,
  PlusGlyph,
  SearchGlyph,
  SortGlyph,
} from '@/modules/kabina-projects/ProjectsIcons';
import { useProjectsBoard } from '@/modules/kabina-projects/hooks/useProjectsBoard';
import { buildGroups, buildProjectViews, buildSummary, countProjects } from '@/modules/kabina-projects/utils/projectsBoardView';
import { api, readApiJson } from '@/shared/api';
import type { KabinaProjectsFilter, KabinaProjectsSort, KabinaProjectView } from '@/shared/types';
import { pluralRu } from '@/shared/utils';

/** Per-browser memory of the list/tiles switch and the sort, so the screen opens the way it was left. */
const VIEW_STORAGE_KEY = 'mirage.kabina.projects.view';
/** A toast without «Вернуть» fades by itself; one with it waits longer so the undo is reachable. */
const TOAST_MS = 6_000;
const UNDO_TOAST_MS = 12_000;

const FILTERS: Array<{ id: KabinaProjectsFilter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'fav', label: 'Избранные' },
  { id: 'active', label: 'Активные' },
  { id: 'archive', label: 'Архив' },
];

type ToastState = { text: string; undoId?: string } | null;

function readStoredView(): { layout: 'list' | 'grid'; sort: KabinaProjectsSort } {
  try {
    const stored = JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) ?? '{}') as { layout?: string; sort?: string };
    return { layout: stored.layout === 'grid' ? 'grid' : 'list', sort: stored.sort === 'name' ? 'name' : 'act' };
  } catch {
    return { layout: 'list', sort: 'act' };
  }
}

function pad2(count: number): string {
  return String(Math.max(0, count)).padStart(2, '0');
}

type ProjectsScreenProps = {
  /** Refreshes the workspace project list (search, chat) after a star, rename, archive or a new project. */
  onProjectsChanged: () => void;
};

/**
 * Used by the project-workspace module for `/projects`: DarkProjects on the
 * real projects API — summary filters, search, sort, list and tiles, the
 * ⋯ menu (rename in place, star, archive with «Вернуть») and the
 * «Новый проект» wizard.
 */
export function ProjectsScreen({ onProjectsChanged }: ProjectsScreenProps) {
  const { board, error, refresh, patchProject } = useProjectsBoard();
  // Read once on mount; afterwards layout and sort live in their own state.
  const [initialView] = useState(readStoredView);
  // Which section of projects is listed (the summary cells and the segmented filter drive it).
  const [filter, setFilter] = useState<KabinaProjectsFilter>('all');
  // Search text over names and folders.
  const [query, setQuery] = useState('');
  // «по активности» / «по имени»; remembered per browser.
  const [sort, setSort] = useState<KabinaProjectsSort>(initialView.sort);
  // List rows or tiles; remembered per browser.
  const [layout, setLayout] = useState<'list' | 'grid'>(initialView.layout);
  // The project whose ⋯ menu is open (one at a time).
  const [menuId, setMenuId] = useState<string | null>(null);
  // The project being renamed in place, and the text typed so far.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // The bottom-left confirmation; `undoId` adds «Вернуть» for an archive.
  const [toast, setToast] = useState<ToastState>(null);
  // Whether the «Новый проект» wizard is open.
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  // Clock of the «12 мин» captions between board refreshes (each board carries its own generatedAt).
  const [clockMs, setClockMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ layout, sort }));
    } catch {
      // Private mode: the view simply resets next time.
    }
  }, [layout, sort]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), toast.undoId ? UNDO_TOAST_MS : TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const views = useMemo(
    () => (board ? buildProjectViews(board, Math.max(clockMs, Date.parse(board.generatedAt) || 0)) : []),
    [board, clockMs],
  );
  const counts = useMemo(() => countProjects(views), [views]);
  const groups = useMemo(() => buildGroups(views, filter, query, sort), [filter, query, sort, views]);
  const summary = useMemo(() => (board ? buildSummary(views, board) : null), [board, views]);
  const shown = groups.reduce((total, group) => total + group.items.length, 0);
  const showSkeleton = useDelayedFlag(!board && !error);

  const afterChange = useCallback(async () => {
    await refresh();
    onProjectsChanged();
  }, [onProjectsChanged, refresh]);

  const pickFilter = (next: KabinaProjectsFilter) => {
    setFilter(next);
    setMenuId(null);
    setRenamingId(null);
  };

  const toggleStar = async (project: KabinaProjectView) => {
    setMenuId(null);
    patchProject(project.id, { isStarred: !project.isStarred });
    try {
      await readApiJson(await api.toggleProjectStar(project.id));
      setToast({ text: project.isStarred ? `«${project.name}» убран с главного экрана` : `«${project.name}» — в избранном и на главном экране` });
    } catch (starError) {
      setToast({ text: `Не получилось: ${starError instanceof Error ? starError.message : 'сервер не ответил'}` });
    }
    void afterChange();
  };

  const setArchived = async (project: KabinaProjectView, archived: boolean, withUndo: boolean) => {
    setMenuId(null);
    patchProject(project.id, { isArchived: archived });
    try {
      if (archived) await readApiJson(await api.deleteProject(project.id, false));
      else await readApiJson(await api.restoreProject(project.id));
      setToast(archived
        ? { text: `«${project.name}» в архиве. Папка и чаты на сервере не тронуты.`, undoId: withUndo ? project.id : undefined }
        : { text: `«${project.name}» вернулся из архива` });
    } catch (archiveError) {
      setToast({ text: `Не получилось: ${archiveError instanceof Error ? archiveError.message : 'сервер не ответил'}` });
    }
    void afterChange();
  };

  const undoArchive = () => {
    const project = views.find((view) => view.id === toast?.undoId);
    setToast(null);
    if (project) void setArchived({ ...project, isArchived: true }, false, false);
  };

  const saveRename = async (project: KabinaProjectView) => {
    const value = renameValue.trim();
    if (!value) return;
    setRenamingId(null);
    patchProject(project.id, { displayName: value });
    try {
      await readApiJson(await api.renameProject(project.id, value));
      setToast({ text: `Переименовано: «${value}». Папка осталась ${project.folder}` });
    } catch (renameError) {
      setToast({ text: `Не получилось переименовать: ${renameError instanceof Error ? renameError.message : 'сервер не ответил'}` });
    }
    void afterChange();
  };

  const restoreFromWizard = async (projectId: string, name: string) => {
    setIsWizardOpen(false);
    const project = views.find((view) => view.id === projectId);
    if (project) await setArchived(project, false, false);
    else setToast({ text: `«${name}» вернулся из архива` });
  };

  const sortLabel = sort === 'name' ? 'по имени' : 'по активности';
  const unadded = board?.projectsFolder?.unadded.length ?? 0;
  const projectsFolderName = board?.projectsFolder?.path.split('/').filter(Boolean).pop() ?? '';

  return (
    <div className="kp-screen">
      <section className="kp-summary kb-rise" aria-label="Сводка по проектам">
        <div className="kp-intro">
          <span className="kb-m kp-eyebrow">{`ПРОЕКТЫ · СЕРВЕР ${window.location.hostname.toUpperCase()}`}</span>
          <h1 className="kb-t kp-h1">Все проекты</h1>
          <p className="kp-lead">
            Звёздочка выносит проект на главный экран. Архив ничего не удаляет — папка и чаты остаются на сервере,
            вернуть можно в один клик.
          </p>
        </div>
        <div className="kp-stats" role="group" aria-label="Быстрые фильтры">
          <button
            type="button"
            className="kp-stat"
            aria-pressed={filter === 'all'}
            aria-label={`Показать все проекты: ${summary?.total ?? 0}`}
            onClick={() => pickFilter('all')}
          >
            <span className="kp-stat-head"><StatusShape kind="idle" /><span className="kb-m kp-stat-code">В ПАНЕЛИ</span></span>
            <span className="kb-t kp-stat-n">{summary ? pad2(summary.total) : '··'}</span>
            <span className="kp-stat-label">{summary?.totalLabel ?? 'загружаю…'}</span>
          </button>
          <button
            type="button"
            className="kp-stat"
            aria-pressed={filter === 'active'}
            aria-label={`Показать активные: работают ${summary?.running ?? 0}`}
            onClick={() => pickFilter('active')}
          >
            <span className="kp-stat-head"><StatusShape kind={summary?.running ? 'run' : 'idle'} /><span className="kb-m kp-stat-code">РАБОТАЮТ</span></span>
            <span className="kb-t kp-stat-n">{summary ? pad2(summary.running) : '··'}</span>
            <span className="kp-stat-label">{summary?.runningLabel ?? ''}</span>
          </button>
          <button
            type="button"
            className="kp-stat"
            data-wait={summary?.waiting ? '' : undefined}
            aria-pressed={false}
            aria-label={`Ждёт тебя: ${summary?.waiting ?? 0}`}
            onClick={() => pickFilter('active')}
          >
            <span className="kp-stat-head"><StatusShape kind={summary?.waiting ? 'wait' : 'idle'} /><span className="kb-m kp-stat-code">ЖДЁТ ТЕБЯ</span></span>
            <span className="kb-t kp-stat-n">{summary ? pad2(summary.waiting) : '··'}</span>
            <span className="kp-stat-label">{summary?.waitingLabel ?? ''}</span>
          </button>
        </div>
      </section>

      <div className="kp-toolbar kb-rise kb-d1" role="toolbar" aria-label="Поиск, фильтры и вид">
        <div className="kp-search">
          <SearchGlyph />
          <label htmlFor="proj-q" className="kb-sr">Найти проект по имени или папке</label>
          <input
            {...NO_AUTOFILL}
            autoCorrect="off"
            autoCapitalize="off"
            enterKeyHint="search"
            id="proj-q"
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMenuId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="Имя или папка проекта"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="kp-clear kp-ib" aria-label="Очистить поиск" onClick={() => setQuery('')}>
              <CrossGlyph />
            </button>
          )}
        </div>
        <div className="kp-segs kp-filters" role="group" aria-label="Какие проекты показать">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="kp-seg"
              aria-pressed={filter === option.id}
              onClick={() => pickFilter(option.id)}
            >
              {option.label}
              <span className="kb-m kp-seg-n">{counts[option.id]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="kp-sort kp-ghost"
          onClick={() => setSort(sort === 'name' ? 'act' : 'name')}
          aria-label={sort === 'name'
            ? 'Сортировка: по имени. Переключить на «по активности»'
            : 'Сортировка: по активности. Переключить на «по имени»'}
        >
          <SortGlyph />
          {sortLabel}
        </button>
        <div className="kp-segs" role="group" aria-label="Вид списка">
          <button type="button" className="kp-seg" data-icon="" aria-pressed={layout === 'list'} aria-label="Списком" title="Списком" onClick={() => { setLayout('list'); setMenuId(null); }}>
            <ListGlyph />
          </button>
          <button type="button" className="kp-seg" data-icon="" aria-pressed={layout === 'grid'} aria-label="Плиткой" title="Плиткой" onClick={() => { setLayout('grid'); setMenuId(null); }}>
            <GridGlyph />
          </button>
        </div>
        <div className="kb-spacer kp-spacer" />
        <Button variant="pri" className="kp-new" aria-haspopup="dialog" onClick={() => { setIsWizardOpen(true); setMenuId(null); setRenamingId(null); }}>
          <PlusGlyph />
          <span className="kp-new-text">Новый проект</span>
        </Button>
      </div>

      {!board && error && (
        <div className="kp-empty kb-bz kb-fadein" role="alert">
          <div className="kp-empty-text">
            <span className="kb-m kp-empty-code">НЕ ЗАГРУЗИЛОСЬ</span>
            <span className="kp-empty-line">{error}</span>
          </div>
          <button type="button" className="kp-btn kp-ghost" onClick={() => void refresh()}>Повторить</button>
        </div>
      )}

      {showSkeleton && (
        <div className="kp-list" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="kp-row">
              <span className="kp-col-star" />
              <span className="kp-col-name" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Skeleton width="42%" height={13} />
                <Skeleton width="28%" height={9} />
              </span>
              <span className="kp-col-agents"><Skeleton width="60%" height={11} /></span>
            </div>
          ))}
        </div>
      )}

      {board && shown === 0 && (
        <div className="kp-empty kb-bz kb-fadein">
          <div className="kp-empty-text">
            <span className="kb-m kp-empty-code">НИЧЕГО НЕ НАШЛОСЬ</span>
            <span className="kp-empty-line">
              {query.trim()
                ? `По «${query.trim()}» проектов нет. Может, эта папка ещё не добавлена в панель?`
                : 'В этом разделе пока пусто.'}
            </span>
          </div>
          <button type="button" className="kp-btn kp-ghost" onClick={() => setQuery('')}>Сбросить поиск</button>
          <button type="button" className="kp-btn" data-tone="out" onClick={() => setIsWizardOpen(true)}>Добавить папку как проект</button>
        </div>
      )}

      {groups.map((group) => (
        <section key={`${filter}-${group.title}`} className="kp-group kb-rise kb-d2" aria-label={group.title}>
          <div className="kp-group-head">
            <span className="kb-m kp-group-n" aria-hidden="true">{group.n}</span>
            <h2 className="kb-m kp-group-title">{group.title}</h2>
            <span className="kp-group-scale" aria-hidden="true" />
            <span className="kb-m kp-group-meta">{group.meta}</span>
          </div>
          <div className={layout === 'list' ? 'kp-list' : 'kp-grid'} role="list">
            {layout === 'list' && (
              <div className="kb-m kp-cols" aria-hidden="true">
                <span className="kp-col-star" />
                <span className="kp-col-name">ПРОЕКТ · ПАПКА</span>
                <span className="kp-col-agents">АГЕНТЫ</span>
                <span className="kp-col-sess">СЕССИЙ</span>
                <span className="kp-col-spark">14 ДНЕЙ</span>
                <span className="kp-col-last">ПОСЛЕДНЯЯ</span>
                <span className="kp-col-menu" />
              </div>
            )}
            {group.items.map((project) => (
              <ProjectItem
                key={project.id}
                project={project}
                layout={layout}
                isMenuOpen={menuId === project.id}
                isRenaming={renamingId === project.id}
                renameValue={renameValue}
                onToggleMenu={() => {
                  setMenuId(menuId === project.id ? null : project.id);
                  setRenamingId(null);
                }}
                onCloseMenu={() => setMenuId(null)}
                onToggleStar={() => void toggleStar(project)}
                onToggleArchive={() => void setArchived(project, !project.isArchived, true)}
                onStartRename={() => {
                  setRenamingId(project.id);
                  setRenameValue(project.name);
                  setMenuId(null);
                }}
                onRenameChange={setRenameValue}
                onSaveRename={() => void saveRename(project)}
                onCancelRename={() => setRenamingId(null)}
              />
            ))}
          </div>
        </section>
      ))}

      {unadded > 0 && (
        <p className="kb-m kp-foot-note">
          {`В папке ${projectsFolderName} ещё ${unadded} ${pluralRu(unadded, ['папка', 'папки', 'папок'])} без проекта — их можно добавить через «Новый проект».`}
        </p>
      )}

      {toast && (
        <div className="kp-toast kb-bz kb-fadein" role="status">
          <CheckGlyph />
          <span className="kp-toast-text">{toast.text}</span>
          {toast.undoId && <button type="button" className="kp-btn" data-tone="out" onClick={undoArchive}>Вернуть</button>}
          <button type="button" className="kp-clear kp-ib" aria-label="Скрыть уведомление" style={{ color: 'var(--kb-mute)' }} onClick={() => setToast(null)}>
            <CrossGlyph />
          </button>
        </div>
      )}

      {isWizardOpen && (
        <NewProjectWizard
          board={board}
          onClose={() => setIsWizardOpen(false)}
          onCreated={afterChange}
          onFinish={(name, starred) => {
            setIsWizardOpen(false);
            setFilter('all');
            setQuery('');
            setToast({ text: `«${name}» добавлен в панель${starred ? ' и на главный экран' : ''}` });
          }}
          onRestoreArchived={(projectId, name) => void restoreFromWizard(projectId, name)}
        />
      )}
    </div>
  );
}
