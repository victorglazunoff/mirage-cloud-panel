import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { FilePathRef } from '@/modules/chat/utils/filePathRefs';

/**
 * Mirage: how a screen turns a file path in model-written markdown into a
 * link. Provided by the Kabina feed (opens the path in its file manager);
 * without a provider the markdown keeps the authors' behaviour.
 */
export type FileLinkRenderer = {
  /** Draws `children` as a link to `reference`. */
  renderFileLink: (reference: FilePathRef, children: ReactNode, key?: string) => ReactNode;
};

export const FileLinkContext = createContext<FileLinkRenderer | null>(null);

/** The screen's file-link renderer, or null where paths stay plain text. */
export function useFileLinks(): FileLinkRenderer | null {
  return useContext(FileLinkContext);
}
