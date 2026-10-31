import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeToolCall } from '@/modules/agents-live/services/agents-live-aggregator.service.js';
import type { AnyRecord, LiveAgentAction } from '@/shared/types.js';

/** What the «Агенты» screen can tell about a session a CLI outside the panel runs, from its transcript. */
export type ExternalTranscriptReading = {
  /** Model id of the last main-thread assistant message (`claude-opus-…`). */
  model: string | null;
  /** Context of the last main-thread assistant message: input + cache + output tokens. */
  tokens: number | null;
  /** Main-thread tool calls since the start of the transcript. */
  toolCalls: number;
  /** Newest first, at most `MAX_ACTIONS`. */
  recentActions: LiveAgentAction[];
};

type ScanState = ExternalTranscriptReading & {
  /** Bytes already folded in. */
  offset: number;
  /** An unfinished last line, kept for the next read. */
  rest: string;
};

const MAX_ACTIONS = 10;
/** A first read of a huge transcript starts this far from the end: older calls only add to the counter. */
const MAX_FIRST_READ_BYTES = 8 * 1024 * 1024;
const MAX_CACHED = 50;

const cache = new Map<string, ScanState>();
/** The read of each file still running; the next read of that file waits for it. */
const readsInFlight = new Map<string, Promise<ExternalTranscriptReading | null>>();

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Claude's transcript for a session row: the indexed path, else `~/.claude/projects/<encoded cwd>/<id>.jsonl`. */
export function resolveClaudeTranscriptFile(session: {
  jsonl_path?: string | null;
  project_path?: string | null;
  provider_session_id?: string | null;
  session_id: string;
}): string | null {
  if (session.jsonl_path) {
    return session.jsonl_path;
  }
  if (!session.project_path) {
    return null;
  }
  const encoded = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
  const projectDirectory = path.join(os.homedir(), '.claude', 'projects', encoded);
  const filePath = path.join(projectDirectory, `${session.provider_session_id || session.session_id}.jsonl`);
  const relative = path.relative(projectDirectory, filePath);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : filePath;
}

/** Folds one transcript row into the reading (main thread only). */
function foldRow(state: ScanState, row: AnyRecord, projectPath: string | null): void {
  if (row.isSidechain === true || row.type !== 'assistant') {
    return;
  }
  const message = row.message as AnyRecord | undefined;
  if (!message || message.model === '<synthetic>') {
    return;
  }
  if (typeof message.model === 'string' && message.model) {
    state.model = message.model;
  }
  const usage = message.usage as AnyRecord | undefined;
  if (usage) {
    const context = readNumber(usage.input_tokens) + readNumber(usage.cache_read_input_tokens)
      + readNumber(usage.cache_creation_input_tokens) + readNumber(usage.output_tokens);
    if (context > 0) {
      state.tokens = context;
    }
  }
  const content = Array.isArray(message.content) ? message.content as AnyRecord[] : [];
  const at = typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString();
  for (const block of content) {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string') {
      continue;
    }
    state.toolCalls += 1;
    const described = describeToolCall(block.name, block.input, projectPath);
    const text = described.startsWith(block.name) ? described.slice(block.name.length).trim() : described;
    state.recentActions.unshift({ at, tool: block.name, text, kind: 'tool' });
  }
  if (state.recentActions.length > MAX_ACTIONS) {
    state.recentActions.length = MAX_ACTIONS;
  }
}

/**
 * Used by the agents-live service for sessions a Claude CLI outside the panel
 * works on: their model, context tokens, call count and last tool calls,
 * read from the transcript. Reads incrementally — only the bytes appended
 * since the last call — so polling a growing transcript stays cheap.
 * Returns null when there is no readable transcript.
 */
export function readExternalTranscript(filePath: string, projectPath: string | null): Promise<ExternalTranscriptReading | null> {
  // One read per file at a time: two snapshots at once (two tabs subscribing)
  // would otherwise both fold the same appended bytes from the shared state.
  const previous = readsInFlight.get(filePath) ?? Promise.resolve(null);
  const next = previous.catch(() => null).then(() => readOnce(filePath, projectPath));
  const settled = next.catch(() => null);
  readsInFlight.set(filePath, settled);
  void settled.then(() => {
    if (readsInFlight.get(filePath) === settled) readsInFlight.delete(filePath);
  });
  return next;
}

async function readOnce(filePath: string, projectPath: string | null): Promise<ExternalTranscriptReading | null> {
  let size: number;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch {
    return null;
  }
  let state = cache.get(filePath);
  if (!state || size < state.offset) {
    state = {
      model: null,
      tokens: null,
      toolCalls: 0,
      recentActions: [],
      offset: Math.max(0, size - MAX_FIRST_READ_BYTES),
      rest: '',
    };
    // A read from the middle of the file starts on a partial line: drop it.
    if (state.offset > 0) {
      state.rest = '\u0000';
    }
  }
  if (size > state.offset) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const length = size - state.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, state.offset);
      state.offset = size;
      const text = buffer.toString('utf8');
      const skipFirst = state.rest === '\u0000';
      const lines = (skipFirst ? text : state.rest + text).split('\n');
      if (skipFirst) {
        lines.shift();
      }
      state.rest = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          foldRow(state, JSON.parse(line) as AnyRecord, projectPath);
        } catch {
          // A malformed row is skipped; the rest still counts.
        }
      }
    } finally {
      await handle.close();
    }
  }
  cache.delete(filePath);
  cache.set(filePath, state);
  if (cache.size > MAX_CACHED) {
    cache.delete(cache.keys().next().value as string);
  }
  return {
    model: state.model,
    tokens: state.tokens,
    toolCalls: state.toolCalls,
    recentActions: state.recentActions.map((action) => ({ ...action })),
  };
}
