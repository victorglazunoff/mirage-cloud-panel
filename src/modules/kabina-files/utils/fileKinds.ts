/**
 * Pure helpers of «Файлы» (DarkFiles): what kind of preview a file gets, the
 * small Markdown and code renderers in the mock-up's style, and the Russian
 * wording of sizes and dates. No React here, so all of it is unit-tested.
 */
import { toPanelWall } from '@/modules/kabina';
import { pluralRu } from '@/shared/utils';

export type PreviewKind = 'md' | 'code' | 'img' | 'sheet' | 'pdf' | 'secret' | 'folder' | 'none';
export type TreeIconKind = 'doc' | 'code' | 'img' | 'xls' | 'gen';

const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'php', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'yml', 'yaml',
  'toml', 'ini', 'sql', 'vue', 'svelte', 'lua', 'pl', 'r', 'dockerfile', 'makefile', 'conf', 'service', 'txt', 'log', 'csv',
]);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const SHEET_EXTENSIONS = new Set(['xlsx', 'xlsm']);
/** Files whose content is never shown: keys and credentials (.env, .env.local, *.pem, id_rsa…). */
const SECRET_PATTERN = /^\.env(\..*)?$|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519|ecdsa)$|^\.netrc$|^\.npmrc$/i;
/** Previews read the file as text only below this size; bigger files are offered for download. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name.toLowerCase() === 'dockerfile' || name.toLowerCase() === 'makefile' ? name.toLowerCase() : '';
  return name.slice(dot + 1).toLowerCase();
}

export function isSecretFile(name: string): boolean {
  return SECRET_PATTERN.test(name);
}

/** Which preview the file gets; `.svg` is a picture, not code. */
export function previewKindOf(name: string, isDirectory: boolean): PreviewKind {
  if (isDirectory) return 'folder';
  if (isSecretFile(name)) return 'secret';
  const extension = extensionOf(name);
  if (extension === 'md' || extension === 'markdown') return 'md';
  if (IMAGE_EXTENSIONS.has(extension)) return 'img';
  if (SHEET_EXTENSIONS.has(extension)) return 'sheet';
  if (extension === 'pdf') return 'pdf';
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  return 'none';
}

/** The tree's file icon: document (md, pdf), code, picture, spreadsheet or generic. */
export function treeIconOf(name: string): TreeIconKind {
  const kind = previewKindOf(name, false);
  if (kind === 'md' || kind === 'pdf') return 'doc';
  if (kind === 'img') return 'img';
  if (kind === 'sheet') return 'xls';
  if (kind === 'code') return 'code';
  return 'gen';
}

/** The square tag of the preview header: 'MD', 'PHP', 'DIR', 'ENV', 'ФАЙЛ'. */
export function extensionTag(name: string, isDirectory: boolean): string {
  if (isDirectory) return 'DIR';
  if (isSecretFile(name)) return 'ENV';
  const extension = extensionOf(name);
  return extension ? extension.toUpperCase() : 'ФАЙЛ';
}

/** '412 Б', '18,2 КБ', '3,9 МБ', '1,2 ГБ' — one decimal under 100, comma as in the mock-up. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return `${text} ${units[unit]}`;
}

/** 12480 → '12 480' (thin groups as in the mock-up). */
export function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** 'сегодня 13:58', 'вчера 18:21', '22 окт' (another year: '22 окт 2025'). */
export function formatModified(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const date = toPanelWall(ms);
  const now = toPanelWall(nowMs);
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (days <= 0) return `сегодня ${clock}`;
  if (days === 1) return `вчера ${clock}`;
  const day = `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

export function linesWord(count: number): string {
  return `${formatCount(count)} ${pluralRu(count, ['строка', 'строки', 'строк'])}`;
}

// ---------------------------------------------------------------- Markdown

export type MarkdownBlock = { kind: 'h1' | 'h2' | 'p' | 'li'; text: string };

/** Strips inline Markdown (links, emphasis, code ticks) to readable text. */
function plainInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * Turns Markdown into the preview's blocks: the first-level heading is the
 * big title, deeper headings the sand caps, list items with a dash and the
 * rest paragraphs. Code fences and tables are skipped — it is a glance, not a reader.
 */
export function markdownBlocks(source: string, limit = 40): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let inFence = false;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'p', text: plainInline(paragraph.join(' ')) });
    paragraph = [];
  };
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence || line.startsWith('|') || /^-{3,}$/.test(line) || line.startsWith('<')) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: heading[1].length === 1 ? 'h1' : 'h2', text: plainInline(heading[2]) });
    } else if (item) {
      flush();
      blocks.push({ kind: 'li', text: plainInline(item[1].replace(/^\[[ x]\]\s*/i, '')) });
    } else if (!line) {
      flush();
    } else {
      paragraph.push(line.replace(/^>\s?/, ''));
    }
    if (blocks.length >= limit) break;
  }
  flush();
  return blocks.slice(0, limit).map((block) => (block.kind === 'h2' ? { ...block, text: block.text.toUpperCase() } : block));
}

// ---------------------------------------------------------------- code

/** Token colours of the mock-up: keyword, string, comment, function, number, plain. */
export type CodeTokenKind = 'k' | 's' | 'c' | 'f' | 'n' | 'v';
export type CodeToken = { text: string; kind: CodeTokenKind };

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'new', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'import', 'export', 'from', 'as',
  'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'public', 'private', 'protected', 'static', 'readonly',
  'require', 'include', 'use', 'namespace', 'def', 'elif', 'lambda', 'pass', 'yield', 'with', 'in', 'of', 'not', 'and',
  'or', 'is', 'None', 'True', 'False', 'true', 'false', 'null', 'undefined', 'this', 'self', 'echo', 'set', 'fi', 'then',
  'done', 'esac', 'local', 'export', 'typeof', 'instanceof', 'void', 'fn', 'pub', 'impl', 'struct', 'match', 'mut',
]);
const HASH_COMMENT_EXTENSIONS = new Set(['sh', 'bash', 'zsh', 'py', 'rb', 'yml', 'yaml', 'toml', 'ini', 'conf', 'pl', 'r', 'dockerfile', 'makefile', 'service']);

/** A small one-line tokenizer: enough to colour code like the mock-up, never a parser. */
export function tokenizeLine(line: string, extension: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const hashComments = HASH_COMMENT_EXTENSIONS.has(extension) || (extension === 'php' && /^\s*#(?!\[)/.test(line));
  const pattern = /(\/\/.*$|\/\*.*?\*\/|<!--.*?-->|#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d+(?:\.\d+)?\b|#[0-9a-fA-F]{3,8}\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$-]*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) tokens.push({ text: line.slice(last, match.index), kind: 'v' });
    const [text, comment, string, number, call, word] = match;
    if (comment !== undefined) {
      const isHash = comment.startsWith('#');
      if (isHash && !hashComments) {
        // `#fff` in CSS is a number; any other `#` outside hash-comment languages is plain text.
        const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(comment);
        if (hex) {
          tokens.push({ text: hex[0], kind: 'n' });
          pattern.lastIndex = match.index + hex[0].length;
          last = pattern.lastIndex;
          continue;
        }
        tokens.push({ text: '#', kind: 'v' });
        pattern.lastIndex = match.index + 1;
        last = pattern.lastIndex;
        continue;
      }
      tokens.push({ text, kind: 'c' });
    } else if (string !== undefined) {
      tokens.push({ text, kind: 's' });
    } else if (number !== undefined) {
      tokens.push({ text, kind: 'n' });
    } else if (call !== undefined) {
      tokens.push({ text, kind: KEYWORDS.has(call) ? 'k' : 'f' });
    } else if (word !== undefined) {
      tokens.push({ text, kind: KEYWORDS.has(word) ? 'k' : 'v' });
    }
    last = pattern.lastIndex;
  }
  if (last < line.length) tokens.push({ text: line.slice(last), kind: 'v' });
  // Adjacent plain pieces merge so the DOM stays small.
  return tokens.reduce<CodeToken[]>((merged, token) => {
    const previous = merged[merged.length - 1];
    if (previous && previous.kind === token.kind && token.kind === 'v') previous.text += token.text;
    else merged.push({ ...token });
    return merged;
  }, []);
}

// ---------------------------------------------------------------- paths

/** The folder a selection lives in: the folder itself, or a file's parent. */
export function folderOfSelection(selectedPath: string | null, isDirectory: boolean, fallback: string): string {
  if (!selectedPath) return fallback;
  if (isDirectory) return selectedPath;
  const slash = selectedPath.lastIndexOf('/');
  return slash > 0 ? selectedPath.slice(0, slash) : fallback;
}

/** `child` is `parent` or below it. */
export function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Folders to open to show `filePath` in a tree rooted at `root`: the root first, then each folder down to
 * the file's parent. Empty when the file is not strictly below the root.
 */
export function foldersToReveal(root: string, filePath: string): string[] {
  const base = root.replace(/\/+$/, '');
  if (!base || filePath === base || !filePath.startsWith(`${base}/`)) return [];
  const segments = filePath.slice(base.length + 1).split('/').filter(Boolean);
  const folders = [base];
  for (let index = 0; index < segments.length - 1; index += 1) {
    folders.push(`${folders[folders.length - 1]}/${segments[index]}`);
  }
  return folders;
}

/** The absolute path of `?file=`: already absolute, or relative to the project; null for a relative path without a project. */
export function resolveRevealPath(file: string, projectPath: string | null): string | null {
  const trimmed = file.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;
  if (!projectPath) return null;
  return `${projectPath.replace(/\/+$/, '')}/${trimmed.replace(/^\.\//, '')}`;
}

/** The folder most project paths share as a parent (the «Проекты» place); null under two projects. */
export function commonProjectsFolder(projectPaths: string[]): string | null {
  const counts = new Map<string, number>();
  for (const projectPath of projectPaths) {
    const slash = projectPath.replace(/\/+$/, '').lastIndexOf('/');
    if (slash <= 0) continue;
    const parent = projectPath.slice(0, slash);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 1;
  for (const [parent, count] of counts) {
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
  }
  return best;
}
