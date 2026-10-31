import { useMemo } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { findFilePathRefs } from '@/modules/chat';
import type { FileLinkRenderer, FilePathRef } from '@/modules/chat';

/**
 * Where a file path from the chat opens: the Kabina file manager at that file
 * (`/files?project=…&file=…&line=…`). A relative path is the project's; `~/` is
 * the home folder, so it needs one; null when it cannot be placed.
 */
export function buildFileHref(reference: FilePathRef, projectId: string | null, homeDir: string | null): string | null {
  let path = reference.path.trim();
  if (!path) return null;
  if (path === '~' || path.startsWith('~/')) {
    if (!homeDir) return null;
    path = `${homeDir.replace(/\/+$/, '')}${path.slice(1)}`;
  }
  const params = new URLSearchParams();
  if (projectId) params.set('project', projectId);
  params.set('file', path);
  if (reference.line) params.set('line', String(reference.line));
  return `/files?${params.toString()}`;
}

type FilePathLinkProps = {
  href: string;
  children: ReactNode;
};

/**
 * A file path in the feed: underlined on hover, «Открыть в файлах»; a click
 * opens the file manager here (its toggle brings you back), ⌘/Ctrl-click opens
 * it in a new tab.
 */
export function FilePathLink({ href, children }: FilePathLinkProps) {
  const navigate = useNavigate();
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    // A modified or middle click keeps the browser's new-tab behaviour.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} className="kbc-path" title="Открыть в файлах" onClick={open}>
      {children}
    </a>
  );
}

/** The feed's renderer for paths in Claude's markdown, for `FileLinkContext`. */
export function useFeedFileLinks(projectId: string | null, homeDir: string | null): FileLinkRenderer {
  return useMemo(() => ({
    renderFileLink: (reference: FilePathRef, children: ReactNode, key?: string) => {
      const href = buildFileHref(reference, projectId, homeDir);
      return href ? <FilePathLink key={key} href={href}>{children}</FilePathLink> : <span key={key}>{children}</span>;
    },
  }), [homeDir, projectId]);
}

/** Plain text (a step's input or output) with its file paths as links. */
export function PathText({ text, links }: { text: string; links: FileLinkRenderer | null }) {
  if (!links) return <>{text}</>;
  const matches = findFilePathRefs(text);
  if (matches.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) parts.push(text.slice(cursor, match.start));
    parts.push(links.renderFileLink(match, match.text, `path-${index}`));
    cursor = match.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
