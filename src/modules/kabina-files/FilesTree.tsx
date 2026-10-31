import { ChevronGlyph, FileTypeGlyph, FolderGlyph, LockGlyph } from '@/modules/kabina-files/FilesIcons';
import { formatBytes, formatCount, formatModified, isSecretFile, isWithin, treeIconOf } from '@/modules/kabina-files/utils/fileKinds';
import { KABINA_FOLDER_PAGE_SIZE } from '@/shared/constants';
import type { KabinaFileEntry, KabinaLoadedFolder } from '@/shared/types';

/** Folders that are dependencies or build output: drawn muted, like the mock-up's node_modules. */
const MUTED_FOLDERS = new Set(['node_modules', 'vendor', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv', 'coverage']);

type TreeRow =
  | { kind: 'entry'; entry: KabinaFileEntry; depth: number; isOpen: boolean }
  | { kind: 'more'; folderPath: string; depth: number; shown: number; total: number; isLoading: boolean }
  | { kind: 'loading'; folderPath: string; depth: number }
  | { kind: 'error'; folderPath: string; depth: number; message: string };

type FilesTreeProps = {
  rootPath: string;
  rootLabel: string;
  folders: Record<string, KabinaLoadedFolder>;
  expanded: Set<string>;
  selectedPath: string | null;
  filter: string;
  showHidden: boolean;
  /** Absolute paths git reports as changed (modified, added, untracked). */
  changedPaths: Set<string>;
  nowMs: number;
  onToggleFolder: (entry: KabinaFileEntry) => void;
  onSelectFile: (entry: KabinaFileEntry) => void;
  onLoadMore: (folderPath: string) => void;
  onRetry: (folderPath: string) => void;
};

/** Rows of the tree: open folders' loaded entries, a «показано N из M» row per partly loaded folder. */
function buildRows(props: FilesTreeProps): { rows: TreeRow[]; objectCount: number } {
  const needle = props.filter.trim().toLowerCase();
  const rows: TreeRow[] = [];
  let objectCount = 0;

  // With a filter, a folder stays when it or anything loaded below it matches.
  const matchCache = new Map<string, boolean>();
  const subtreeMatches = (entry: KabinaFileEntry): boolean => {
    if (!needle) return true;
    const cached = matchCache.get(entry.path);
    if (cached !== undefined) return cached;
    let matches = entry.name.toLowerCase().includes(needle);
    if (!matches && entry.type === 'directory') {
      matches = (props.folders[entry.path]?.entries ?? []).some(subtreeMatches);
    }
    matchCache.set(entry.path, matches);
    return matches;
  };

  const walk = (folderPath: string, depth: number) => {
    const folder = props.folders[folderPath];
    if (!folder) return;
    if (folder.error && folder.entries.length === 0) {
      rows.push({ kind: 'error', folderPath, depth, message: folder.error });
      return;
    }
    if (folder.isLoading && folder.entries.length === 0) {
      rows.push({ kind: 'loading', folderPath, depth });
      return;
    }
    for (const entry of folder.entries) {
      if (!subtreeMatches(entry)) continue;
      const isOpen = entry.type === 'directory' && (needle ? Boolean(props.folders[entry.path]?.entries.length) : props.expanded.has(entry.path));
      rows.push({ kind: 'entry', entry, depth, isOpen });
      objectCount += 1;
      if (isOpen) walk(entry.path, depth + 1);
    }
    // Б13: a folder never ends silently — the rest is counted and one click away.
    if (!needle && folder.total > KABINA_FOLDER_PAGE_SIZE) {
      rows.push({ kind: 'more', folderPath, depth, shown: folder.entries.length, total: folder.total, isLoading: folder.isLoading });
    }
  };

  walk(props.rootPath, 0);
  return { rows, objectCount };
}

function padFor(depth: number): number {
  return 12 + depth * 22;
}

/**
 * Used by the files screen: the lazy tree of DarkFiles — chevrons open
 * folders one page (200) at a time, «показано 200 из N · показать ещё»,
 * git marks, hidden files muted, secrets with a lock.
 */
export default function FilesTree(props: FilesTreeProps) {
  const { rows, objectCount } = buildRows(props);
  const rootFolder = props.folders[props.rootPath];
  const filterText = props.filter.trim();

  const folderHasChanges = (folderPath: string) => {
    for (const changed of props.changedPaths) {
      if (isWithin(folderPath, changed) && changed !== folderPath) return true;
    }
    return false;
  };

  return (
    <div className="kf-tree-box kb-bz">
      <div className="kb-m kf-tree-cols" aria-hidden="true">
        <span className="kf-col-name">ИМЯ</span>
        <span className="kf-col-size">РАЗМЕР</span>
        <span className="kf-col-mod">ИЗМЕНЁН</span>
      </div>

      <div className="kf-tree" role="tree" aria-label={`Файлы: ${props.rootLabel}`}>
        {rows.map((row) => {
          if (row.kind === 'loading') {
            return <div key={`loading-${row.folderPath}`} className="kb-m kf-more" style={{ paddingLeft: padFor(row.depth) }}>гружу папку…</div>;
          }
          if (row.kind === 'error') {
            return (
              <div key={`error-${row.folderPath}`} className="kb-m kf-more" style={{ paddingLeft: padFor(row.depth) }}>
                <span style={{ color: 'var(--kb-signal-text)' }}>{row.message}</span>
                <span aria-hidden="true">·</span>
                <button type="button" className="kb-m kf-more-btn" onClick={() => props.onRetry(row.folderPath)}>повторить</button>
              </div>
            );
          }
          if (row.kind === 'more') {
            const rest = row.total - row.shown;
            const fill = `${Math.max(2, Math.round((row.shown / row.total) * 100))}%`;
            return (
              <div key={`more-${row.folderPath}`} className="kb-m kf-more" style={{ paddingLeft: padFor(row.depth) }}>
                <span aria-hidden="true" style={{ width: 12, textAlign: 'center' }}>⋯</span>
                <span className="kf-more-bar" aria-hidden="true"><span style={{ width: fill }} /></span>
                <span style={{ color: 'var(--kb-soft)' }}>
                  {rest > 0 ? `показано ${formatCount(row.shown)} из ${formatCount(row.total)}` : `показаны все ${formatCount(row.total)}`}
                </span>
                {rest > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <button type="button" className="kb-m kf-more-btn" disabled={row.isLoading} onClick={() => props.onLoadMore(row.folderPath)}>
                      {row.isLoading ? 'гружу…' : `показать ещё ${formatCount(Math.min(KABINA_FOLDER_PAGE_SIZE, rest))}`}
                    </button>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span>или сузь фильтром</span>
              </div>
            );
          }

          const { entry, depth, isOpen } = row;
          const isSelected = entry.path === props.selectedPath;
          const isMuted = entry.isHidden || (entry.type === 'directory' && MUTED_FOLDERS.has(entry.name));
          const iconColor = isSelected ? 'var(--kb-signal-text)' : isMuted ? 'var(--kb-dim)' : entry.type === 'directory' ? 'var(--kb-sand)' : 'var(--kb-soft)';
          const modified = formatModified(entry.modified, props.nowMs);
          const isFresh = modified.startsWith('сегодня');

          if (entry.type === 'directory') {
            const hasChanges = folderHasChanges(entry.path);
            return (
              <button
                key={entry.path}
                type="button"
                role="treeitem"
                className="kf-row"
                aria-expanded={isOpen}
                aria-selected={isSelected}
                data-path={entry.path}
                data-muted={isMuted ? '' : undefined}
                style={{ paddingLeft: padFor(depth) }}
                onClick={() => props.onToggleFolder(entry)}
              >
                <ChevronGlyph />
                <FolderGlyph color={iconColor} />
                <span className="kf-row-name">
                  <span className="kf-row-label">{entry.name}</span>
                  {entry.childCount !== null && <span className="kb-m kf-row-count">{formatCount(entry.childCount)}</span>}
                  {hasChanges && (
                    <>
                      <span className="kf-git-dot" aria-hidden="true" />
                      <span className="kb-sr">внутри есть изменения</span>
                    </>
                  )}
                </span>
                <span className="kb-m kf-col-size kf-row-meta">—</span>
                <span className="kb-m kf-col-mod kf-row-meta" data-fresh={isFresh ? '' : undefined}>{modified}</span>
              </button>
            );
          }

          const isChanged = props.changedPaths.has(entry.path);
          return (
            <button
              key={entry.path}
              type="button"
              role="treeitem"
              className="kf-row"
              aria-selected={isSelected}
              data-path={entry.path}
              data-muted={isMuted ? '' : undefined}
              style={{ paddingLeft: padFor(depth) }}
              onClick={() => props.onSelectFile(entry)}
            >
              <span aria-hidden="true" style={{ width: 12, flex: 'none' }} />
              <FileTypeGlyph kind={treeIconOf(entry.name)} color={iconColor} />
              <span className="kf-row-name">
                <span className="kf-row-label">{entry.name}</span>
                {isChanged && (
                  <>
                    <span className="kb-m kf-m-badge" aria-hidden="true">M</span>
                    <span className="kb-sr">изменён, не закоммичен</span>
                  </>
                )}
                {isSecretFile(entry.name) && <span role="img" aria-label="секреты" style={{ display: 'inline-flex' }}><LockGlyph /></span>}
              </span>
              <span className="kb-m kf-col-size kf-row-meta">{formatBytes(entry.size)}</span>
              <span className="kb-m kf-col-mod kf-row-meta" data-fresh={isFresh ? '' : undefined}>{modified}</span>
            </button>
          );
        })}

        {filterText && objectCount === 0 && (
          <div className="kf-empty">
            <span className="kf-empty-title">{`Ничего не нашлось по «${filterText}» в ${props.rootLabel}`}</span>
            <span className="kf-empty-text">Фильтр смотрит в уже открытые папки. Глубже — через ⌘K по всему серверу.</span>
          </div>
        )}
        {!filterText && rootFolder && !rootFolder.isLoading && !rootFolder.error && rootFolder.total === 0 && (
          <div className="kf-empty">
            <span className="kf-empty-title">Папка пуста</span>
            <span className="kf-empty-text">Перетащи сюда файлы или создай папку кнопкой «Новая папка».</span>
          </div>
        )}
      </div>

      <div className="kb-m kf-tree-foot">
        <span>{filterText ? `найдено ${objectCount} по «${filterText}»` : `${formatCount(objectCount)} на экране`}</span>
        <span>
          {rootFolder && rootFolder.hiddenCount > 0 && props.showHidden
            ? `скрытые показаны: ${rootFolder.hiddenNames.join(', ')}${rootFolder.hiddenCount > rootFolder.hiddenNames.length ? '…' : ''}`
            : rootFolder && rootFolder.hiddenCount > 0
            ? `скрыто ${rootFolder.hiddenCount}: ${rootFolder.hiddenNames.join(', ')}${rootFolder.hiddenCount > rootFolder.hiddenNames.length ? '…' : ''}`
            : 'скрытых нет'}
        </span>
      </div>
    </div>
  );
}
