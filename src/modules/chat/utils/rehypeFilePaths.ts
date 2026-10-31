import { findFilePathRefs, isLikelyFilePath } from '@/modules/chat/utils/filePathRefs';

/** The hast attribute that marks an element made from a file path. */
export const FILE_PATH_PROPERTY = 'dataFilePath';

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function pathLink(reference: string, children: HastNode[]): HastNode {
  return { type: 'element', tagName: 'a', properties: { [FILE_PATH_PROPERTY]: reference }, children };
}

/** Splits a text node around the file paths in it. */
function splitText(node: HastNode): HastNode[] | null {
  const value = node.value ?? '';
  const matches = findFilePathRefs(value);
  if (matches.length === 0) return null;
  const parts: HastNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) parts.push({ type: 'text', value: value.slice(cursor, match.start) });
    parts.push(pathLink(match.text, [{ type: 'text', value: match.text }]));
    cursor = match.end;
  }
  if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) });
  return parts;
}

function walk(node: HastNode): void {
  if (!node.children) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'element') {
      const tag = child.tagName;
      // Links stay as they are; code blocks are code, not prose.
      const className = child.properties?.className;
      const isMath = Array.isArray(className) && className.some((name) => String(name).startsWith('katex'));
      if (tag === 'a' || tag === 'pre' || tag === 'script' || tag === 'style' || isMath) {
        next.push(child);
        continue;
      }
      if (tag === 'code') {
        // An inline code span that is a path as a whole becomes a link around it.
        const text = textOf(child).trim();
        next.push(isLikelyFilePath(text) ? pathLink(text, [child]) : child);
        continue;
      }
      walk(child);
      next.push(child);
      continue;
    }
    if (child.type === 'text') {
      const parts = splitText(child);
      if (parts) {
        next.push(...parts);
        continue;
      }
    }
    next.push(child);
  }
  node.children = next;
}

/**
 * Mirage: a rehype plugin that marks file paths in model-written markdown —
 * inline code spans that are a path, and paths in running text — as `<a>`
 * elements carrying `data-file-path`. The markdown's link renderer then hands
 * them to the screen (see FileLinkContext). Fenced code is left alone.
 */
export default function rehypeFilePaths() {
  return (tree: HastNode) => {
    walk(tree);
  };
}
