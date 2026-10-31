import { useCallback, useEffect, useRef, useState } from 'react';

import { filesErrorSentence } from '@/modules/kabina-files/utils/filesErrors';
import { api, readApiJson } from '@/shared/api';
import { KABINA_FOLDER_PAGE_SIZE as FOLDER_PAGE_SIZE } from '@/shared/constants';
import type { KabinaFolderPage, KabinaLoadedFolder as LoadedFolder } from '@/shared/types';

type FolderPagesState = {
  folders: Record<string, LoadedFolder>;
  /** Disk and places of the last page that arrived. */
  meta: Pick<KabinaFolderPage, 'disk' | 'places'> | null;
  /** Loads the first page of a folder unless it is already there (or `force`). */
  loadFolder: (folderPath: string, force?: boolean) => Promise<void>;
  /** «показать ещё 200». */
  loadMore: (folderPath: string) => Promise<void>;
};

/**
 * Lazily loaded folder pages of the «Файлы» tree. Switching hidden files on
 * or off forgets every page, since counts and order change.
 */
export function useFolderPages(showHidden: boolean): FolderPagesState {
  // Loaded pages by folder path.
  const [folders, setFolders] = useState<Record<string, LoadedFolder>>({});
  // Disk usage and the place roots, from whichever page came last.
  const [meta, setMeta] = useState<FolderPagesState['meta']>(null);
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  // Bumped when hidden files toggle, so answers to the old setting are dropped.
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    // The ref is cleared at once: the screen's reload effects run in this same commit and would
    // otherwise see the old pages as loaded, skip the fetch and leave the tree empty.
    foldersRef.current = {};
    setFolders({});
  }, [showHidden]);

  const fetchPage = useCallback(async (folderPath: string, offset: number) => {
    const generation = generationRef.current;
    setFolders((current) => ({
      ...current,
      [folderPath]: { ...(current[folderPath] ?? { entries: [], total: 0, hiddenCount: 0, hiddenNames: [] }), isLoading: true, error: null },
    }));
    try {
      const body = await readApiJson<{ data: KabinaFolderPage }>(
        await api.kabinaFiles.folder(folderPath, { offset, limit: FOLDER_PAGE_SIZE, hidden: showHidden }),
      );
      if (generation !== generationRef.current) return;
      const page = body.data;
      setMeta({ disk: page.disk, places: page.places });
      setFolders((current) => {
        const previous = offset > 0 ? current[folderPath]?.entries ?? [] : [];
        return {
          ...current,
          [folderPath]: {
            entries: [...previous, ...page.entries],
            total: page.total,
            hiddenCount: page.hiddenCount,
            hiddenNames: page.hiddenNames,
            isLoading: false,
            error: null,
          },
        };
      });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setFolders((current) => ({
        ...current,
        [folderPath]: {
          ...(current[folderPath] ?? { entries: [], total: 0, hiddenCount: 0, hiddenNames: [] }),
          isLoading: false,
          error: filesErrorSentence(error, 'Не удалось открыть папку'),
        },
      }));
    }
  }, [showHidden]);

  const loadFolder = useCallback(async (folderPath: string, force = false) => {
    const known = foldersRef.current[folderPath];
    if (!force && known && (known.isLoading || known.entries.length > 0 || (known.total === 0 && !known.error))) return;
    await fetchPage(folderPath, 0);
  }, [fetchPage]);

  const loadMore = useCallback(async (folderPath: string) => {
    const known = foldersRef.current[folderPath];
    if (!known || known.isLoading || known.entries.length >= known.total) return;
    await fetchPage(folderPath, known.entries.length);
  }, [fetchPage]);

  return { folders, meta, loadFolder, loadMore };
}
