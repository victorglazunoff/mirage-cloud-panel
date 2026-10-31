/**
 * Mirage: recognising file paths in chat text, so the Kabina feed can open them
 * in its file manager.
 *
 * Only what reads as a file is taken: a name with an extension, as a bare
 * known file name (`package.json`), a relative path (`src/App.tsx:42`), an
 * absolute one (`/root/…/x.md`) or a home one (`~/notes/a.txt`). Web addresses,
 * domains, versions and abbreviations are left alone.
 */

/** Extensions a bare file name (no folder) must have to be taken as a file. */
const KNOWN_EXTENSIONS = new Set([
  'md', 'mdx', 'txt', 'rtf', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ppt', 'pptx', 'odt',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'json5', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'vue', 'svelte', 'astro', 'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'db', 'sqlite', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'heic', 'mp4', 'mov', 'webm', 'mp3', 'wav',
  'ogg', 'm4a', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'log', 'lock', 'map', 'wasm', 'ttf', 'otf', 'woff', 'woff2',
  'ipynb', 'tex', 'bib', 'dc',
]);

/** A trailing `:line` or `:line:col`. */
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;

export type FilePathRef = {
  /** The path as written, without the `:line` suffix. */
  path: string;
  /** The line it points at, or null. */
  line: number | null;
};

/** Splits `src/App.tsx:42:7` into the path and its line. */
export function splitLineSuffix(reference: string): FilePathRef {
  const match = reference.match(LINE_SUFFIX);
  if (!match) return { path: reference, line: null };
  return { path: reference.slice(0, match.index), line: Number(match[1]) };
}

function extensionOf(segment: string): string | null {
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot === segment.length - 1) return null;
  const extension = segment.slice(dot + 1);
  if (!/^[A-Za-z0-9]{1,8}$/.test(extension) || !/[A-Za-z]/.test(extension)) return null;
  return extension.toLowerCase();
}

/**
 * Whether `reference` (as a whole: a code span, a link text) reads as a file.
 * The `:line` suffix is allowed.
 */
export function isLikelyFilePath(reference: string): boolean {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.length > 1024 || /[\n\r\t]/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(www\.|mailto:|data:)/i.test(trimmed)) return false;
  const { path } = splitLineSuffix(trimmed);
  if (!path || /[<>"|*?]/.test(path) || path.endsWith('/')) return false;

  const segments = path.split('/');
  const name = segments[segments.length - 1];
  if (!name) return false;
  const extension = extensionOf(name);
  // `.env`, `.gitignore`: a dot file counts only inside a folder path.
  const isDotFile = /^\.[A-Za-z0-9][\w.-]*$/.test(name);

  if (segments.length === 1) {
    return extension !== null && KNOWN_EXTENSIONS.has(extension) && !/\s/.test(name);
  }

  const isAnchored = path.startsWith('/') || path.startsWith('~/') || path.startsWith('./') || path.startsWith('../');
  if (!isAnchored) {
    // `github.com/a/b.js`, `panel.example.com/p/x.html`: a host, not a folder.
    const first = segments[0];
    if (!first || (first.includes('.') && !first.startsWith('.'))) return false;
    if (/\s/.test(path)) return false;
  }
  return extension !== null || isDotFile;
}

/** Characters a path never ends with in running text: sentence punctuation and closing quotes. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}»"'’”]+$/;
/** Characters that end a path in running text. */
const PATH_STOP = /[\s`"'«»()<>[\]{},;|]/;

export type FilePathMatch = FilePathRef & {
  /** Where the reference (with its `:line`) starts and ends in the text. */
  start: number;
  end: number;
  /** The reference as written, `:line` included. */
  text: string;
};

function isStartBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s(«"'`[{:,;>]/.test(text[index - 1]);
}

/**
 * Extends an absolute or home path across single spaces while the words after
 * a space still lead to another folder (`/home/me/My Projects/site/x.md`).
 */
function extendAcrossSpaces(text: string, end: number): number {
  let cursor = end;
  while (text[cursor] === ' ' && cursor + 1 < text.length && !/\s/.test(text[cursor + 1])) {
    let next = cursor + 1;
    while (next < text.length && !PATH_STOP.test(text[next])) next += 1;
    const word = text.slice(cursor + 1, next);
    // Only a word that is followed by a folder separator belongs to the path.
    if (!word.includes('/')) break;
    cursor = next;
  }
  return cursor;
}

/** Every file path in a piece of running text, in order. */
export function findFilePathRefs(text: string): FilePathMatch[] {
  const matches: FilePathMatch[] = [];
  if (!text || (!text.includes('.') && !text.includes('/'))) return matches;

  let index = 0;
  while (index < text.length) {
    if (PATH_STOP.test(text[index]) || !isStartBoundary(text, index)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && !PATH_STOP.test(text[end])) end += 1;
    const head = text.slice(index, end);
    if (head.startsWith('/') || head.startsWith('~/')) {
      end = extendAcrossSpaces(text, end);
    }
    let candidate = text.slice(index, end);
    const trailing = candidate.match(TRAILING_PUNCTUATION);
    if (trailing) {
      // Keep a `:42` suffix; drop sentence punctuation after it.
      candidate = candidate.slice(0, candidate.length - trailing[0].length);
    }
    if (candidate.includes('://')) {
      index = end;
      continue;
    }
    if (isLikelyFilePath(candidate)) {
      const { path, line } = splitLineSuffix(candidate);
      matches.push({ path, line, start: index, end: index + candidate.length, text: candidate });
    }
    index = end > index ? end : index + 1;
  }
  return matches;
}
