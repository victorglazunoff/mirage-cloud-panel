import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

import { rgPath } from '@vscode/ripgrep';

import type { SearchDialogHit } from '@/shared/types.js';

const IGNORED_FILE_GLOBS = [
  '!**/node_modules/**',
  '!**/.git/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/.next/**',
  '!**/__pycache__/**',
  '!**/.venv/**',
  '!**/vendor/**',
];

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Plain text of a transcript message: a string, or the `text` blocks of a block array. */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Converts one JSONL transcript line into a dialog hit, or null for non-chat lines. */
function parseTranscriptLine(line: string, filePath: string): SearchDialogHit | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(entry) || (entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta === true) {
    return null;
  }
  const message = isRecord(entry.message) ? entry.message : null;
  const text = message ? extractMessageText(message.content) : '';
  if (!text) return null;

  return {
    providerSessionId: typeof entry.sessionId === 'string' ? entry.sessionId : path.basename(filePath, '.jsonl'),
    filePath,
    role: entry.type,
    text,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
  };
}

/**
 * Full-text search over Claude transcripts (`<rootDir>/**\/*.jsonl`) with ripgrep.
 * Streams `rg --json` output, keeps at most `maxHits` chat-message hits and stops the
 * process at `deadlineMs`; `truncated` is then true. Used by the Search service as its
 * dialog source. Subagent transcripts are ignored.
 */
export function searchDialogsWithRipgrep(
  query: string,
  options: { rootDir: string; maxHits: number; deadlineMs: number },
): Promise<{ hits: SearchDialogHit[]; truncated: boolean }> {
  // The transcript is JSON: a `"` or `\` the user typed is stored as `\"` / `\\`,
  // so the raw line holds the escaped form; search for both spellings.
  const escaped = JSON.stringify(query).slice(1, -1);
  const patterns = escaped === query ? ['-e', query] : ['-e', query, '-e', escaped];
  return new Promise((resolve) => {
    const child = spawn(rgPath, [
      '--json', '-i', '-F', '--no-messages',
      '--max-count', '3',
      '--max-filesize', '60M',
      '--max-columns', '4000000',
      '-g', '*.jsonl',
      '-g', '!**/subagents/**',
      ...patterns,
      '--', options.rootDir,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    const hits: SearchDialogHit[] = [];
    let truncated = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ hits, truncated });
    };
    const stop = () => {
      truncated = true;
      child.kill('SIGKILL');
      finish();
    };
    const timer = setTimeout(stop, options.deadlineMs);

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (rawLine) => {
      if (settled) return;
      let event: unknown;
      try {
        event = JSON.parse(rawLine);
      } catch {
        return;
      }
      if (!isRecord(event) || event.type !== 'match' || !isRecord(event.data)) return;
      const data = event.data;
      const filePath = isRecord(data.path) && typeof data.path.text === 'string' ? data.path.text : '';
      const lineText = isRecord(data.lines) && typeof data.lines.text === 'string' ? data.lines.text : '';
      const hit = filePath && lineText ? parseTranscriptLine(lineText, filePath) : null;
      if (!hit) return;
      hits.push(hit);
      if (hits.length >= options.maxHits) stop();
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

/**
 * Lists files under a project directory with `rg --files` (relative paths, ignoring
 * dependency/build folders and everything git-ignored). Gives up after `timeoutMs` and
 * returns null; stops after `maxFiles` entries. Used by the Search service to build the
 * per-project file-name index.
 */
export function listProjectFilesWithRipgrep(
  directory: string,
  options: { maxFiles: number; timeoutMs: number },
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const args = ['--files', '--no-messages', '--max-filesize', '2M'];
    for (const glob of IGNORED_FILE_GLOBS) args.push('-g', glob);
    const child = spawn(rgPath, args, { cwd: directory, stdio: ['ignore', 'pipe', 'ignore'] });

    const files: string[] = [];
    let settled = false;
    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, options.timeoutMs);

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (settled) return;
      files.push(line);
      if (files.length >= options.maxFiles) {
        child.kill('SIGKILL');
        finish(files);
      }
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(files));
  });
}
