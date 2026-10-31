import type { PermissionDiffInput, PermissionDiffLine } from '@/shared/types';

/** Above this many cells the LCS table is skipped: old lines out, new lines in. */
const LCS_CELL_LIMIT = 250_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline is the end of the last line, not an extra empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Used by PermissionRequestCard: a line diff (longest common subsequence) of
 * `oldText` → `newText`, numbered from `startLine`.
 */
export function computeLineDiff({ oldText, newText, startLine = 1 }: PermissionDiffInput): PermissionDiffLine[] {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  const rows: PermissionDiffLine[] = [];
  let oldNumber = startLine;
  let newNumber = startLine;

  if (before.length * after.length > LCS_CELL_LIMIT) {
    for (const text of before) rows.push({ kind: 'del', number: oldNumber++, text });
    for (const text of after) rows.push({ kind: 'add', number: newNumber++, text });
    return rows;
  }

  // lcs[i][j] — common lines of before[i..] and after[j..].
  const lcs: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push({ kind: 'context', number: newNumber, text: after[j] });
      i += 1;
      j += 1;
      oldNumber += 1;
      newNumber += 1;
    } else if (i < before.length && (j >= after.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      rows.push({ kind: 'del', number: oldNumber, text: before[i] });
      i += 1;
      oldNumber += 1;
    } else {
      rows.push({ kind: 'add', number: newNumber, text: after[j] });
      j += 1;
      newNumber += 1;
    }
  }
  return rows;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Used by the chat (when it shows a pending Write / Edit / MultiEdit permission)
 * through the Kabina barrel: turns the tool's input into the card's diff input.
 * Returns null for other tools or an input without a file path.
 */
export function permissionDiffFromToolInput(toolName: string, input: unknown): PermissionDiffInput | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const filePath = readString(record, 'file_path') ?? readString(record, 'path');
  if (!filePath) return null;

  if (toolName === 'Write') {
    return { filePath, oldText: '', newText: readString(record, 'content') ?? '' };
  }
  if (toolName === 'Edit') {
    return { filePath, oldText: readString(record, 'old_string') ?? '', newText: readString(record, 'new_string') ?? '' };
  }
  if (toolName === 'MultiEdit' && Array.isArray(record.edits)) {
    const edits = record.edits.filter((edit): edit is Record<string, unknown> => Boolean(edit) && typeof edit === 'object');
    return {
      filePath,
      oldText: edits.map((edit) => readString(edit, 'old_string') ?? '').join('\n'),
      newText: edits.map((edit) => readString(edit, 'new_string') ?? '').join('\n'),
    };
  }
  return null;
}
