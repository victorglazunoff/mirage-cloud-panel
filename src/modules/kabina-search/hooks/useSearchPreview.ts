import { useEffect, useRef, useState } from 'react';

import { toPanelWall } from '@/modules/kabina';
import { api } from '@/shared/api';
import type { ProjectSession, SearchResultItem } from '@/shared/types';

/** Dialog lines around the match (DarkSearch «реплики вокруг совпадения»). */
export type DialogPreview = {
  kind: 'session';
  lines: Array<{ who: 'ТЫ' | 'CLAUDE'; time: string | null; text: string; isHit: boolean }>;
  hitCount: number;
  messageCount: number;
};

/** First lines of a file, or the lines around the first line that mentions the query. */
export type FilePreview = { kind: 'file'; firstLine: number; lines: string[]; bytes: number } | { kind: 'file-binary' };

/** Project facts for the preview: recent dialogs, a 14-day activity strip, git branch. */
export type ProjectPreview = {
  kind: 'project';
  recent: Array<{ title: string; when: string | null }>;
  sessionTotal: number | null;
  lastActivity: string | null;
  activityByDay: number[];
  branch: string | null;
};

/** What the preview hook loaded for the selected row. */
export type LoadedPreview = DialogPreview | FilePreview | ProjectPreview;

/** Wait this long on a row before loading, so holding ↓ does not fire a request per row. */
const SETTLE_MS = 140;
const FILE_LINES = 14;
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|tgz|mp4|mov|webm|mp3|wav|ogg|woff2?|ttf|otf|sqlite|db|bin|exe|so|dylib|xlsx|docx|pptx)$/i;

type HistoryMessage = { kind?: string; role?: string; content?: string; timestamp?: string };

function fold(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е');
}

/** Cuts long text to `limit` characters, keeping the match in view (with «…» where cut). Exported for tests. */
export function clipAround(text: string, foldedNeedle: string, limit: number): string {
  if (text.length <= limit) return text;
  const index = foldedNeedle ? fold(text).indexOf(foldedNeedle) : -1;
  const start = index > limit / 3 ? Math.min(index - Math.floor(limit / 3), text.length - limit) : 0;
  const body = text.slice(start, start + limit).trim();
  return `${start > 0 ? '…' : ''}${body}${start + limit < text.length ? '…' : ''}`;
}

/** Picks the matching message and one line on each side from a transcript. Exported for tests. */
export function dialogAroundMatch(messages: HistoryMessage[], query: string, hitTimestamp: string | null): DialogPreview {
  const texts = messages.filter(
    (message) => message.kind === 'text' && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string' && message.content.trim() !== '',
  );
  const needle = fold(query.trim());
  const hits = needle ? texts.map((message, index) => (fold(message.content ?? '').includes(needle) ? index : -1)).filter((index) => index >= 0) : [];
  let center = hits.length ? hits[hits.length - 1] : texts.length - 1;
  if (hitTimestamp) {
    const exact = hits.find((index) => texts[index].timestamp === hitTimestamp);
    if (exact !== undefined) center = exact;
  }
  const from = Math.max(0, center - 1);
  const to = Math.min(texts.length, center + 2);
  return {
    kind: 'session',
    lines: texts.slice(from, to).map((message, offset) => {
      const isHit = from + offset === center && hits.includes(center);
      return {
        who: message.role === 'user' ? 'ТЫ' : 'CLAUDE',
        time: message.timestamp ?? null,
        text: clipAround((message.content ?? '').replace(/\s+/g, ' ').trim(), isHit ? needle : '', isHit ? 240 : 160),
        isHit,
      };
    }),
    hitCount: hits.length,
    messageCount: texts.length,
  };
}

/** Cuts a file to the lines around the first mention of the query. Exported for tests. */
export function fileAroundMatch(content: string, query: string): FilePreview {
  const lines = content.split(/\r?\n/);
  const needle = fold(query.trim());
  const hit = needle ? lines.findIndex((line) => fold(line).includes(needle)) : -1;
  const start = hit > 3 ? hit - 3 : 0;
  return { kind: 'file', firstLine: start + 1, lines: lines.slice(start, start + FILE_LINES), bytes: new Blob([content]).size };
}

function daysAgo(iso: string | undefined, now: number): number {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return -1;
  // Both sides on the panel's wall clock, so «today» is the panel's day.
  const today = toPanelWall(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const wallTime = toPanelWall(time).getTime();
  return wallTime >= midnight ? 0 : Math.floor((midnight - wallTime) / 86_400_000) + 1;
}

async function loadProject(item: SearchResultItem, signal: AbortSignal): Promise<ProjectPreview> {
  const projectId = item.projectId ?? item.id;
  const [sessionsBody, gitBody] = await Promise.all([
    api.projectSessions(projectId, { limit: 50 }, { signal }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
    api.git.status(projectId, { signal }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
  ]);
  const sessions: ProjectSession[] = Array.isArray(sessionsBody?.sessions) ? sessionsBody.sessions : [];
  const whenOf = (session: ProjectSession) => (session.lastActivity ?? session.updated_at ?? session.createdAt ?? session.created_at ?? null) as string | null;
  const sorted = [...sessions].sort((a, b) => (whenOf(b) ?? '').localeCompare(whenOf(a) ?? ''));
  const now = Date.now();
  const activityByDay = new Array<number>(14).fill(0);
  for (const session of sorted) {
    const age = daysAgo(whenOf(session) ?? undefined, now);
    if (age >= 0 && age < 14) activityByDay[13 - age] += 1;
  }
  const total = sessionsBody?.sessionMeta?.total ?? sessionsBody?.total;
  return {
    kind: 'project',
    recent: sorted.slice(0, 3).map((session) => ({
      title: String(session.summary || session.title || session.name || 'Без названия'),
      when: whenOf(session),
    })),
    sessionTotal: typeof total === 'number' ? total : sessions.length,
    lastActivity: sorted[0] ? whenOf(sorted[0]) : null,
    activityByDay,
    branch: typeof gitBody?.branch === 'string' && gitBody.branch ? gitBody.branch : null,
  };
}

async function loadDialog(item: SearchResultItem, query: string, signal: AbortSignal): Promise<DialogPreview | null> {
  if (!item.sessionId) return null;
  const response = await api.providers.sessionMessages(item.sessionId, {}, { signal });
  if (!response.ok) return null;
  const body = await response.json();
  const messages: HistoryMessage[] = Array.isArray(body?.data?.messages) ? body.data.messages : [];
  return dialogAroundMatch(messages, query, item.timestamp);
}

async function loadFile(item: SearchResultItem, query: string, signal: AbortSignal): Promise<FilePreview | null> {
  if (!item.projectId || !item.path) return null;
  if (BINARY_EXTENSIONS.test(item.path)) return { kind: 'file-binary' };
  const response = await api.readFile(item.projectId, item.path);
  if (signal.aborted || !response.ok) return null;
  const body = await response.json();
  return typeof body?.content === 'string' ? fileAroundMatch(body.content, query) : null;
}

/**
 * Used by KabinaSearch: loads what the preview of the selected row needs from the authors'
 * APIs — project sessions and git branch, the dialog transcript around the hit, the file's
 * lines. Results are cached per row and query for the life of the overlay.
 */
export function useSearchPreview(item: SearchResultItem | null, query: string) {
  const cacheRef = useRef(new Map<string, LoadedPreview | null>());
  const key = item ? `${item.type}:${item.id}:${item.type === 'project' ? '' : query.trim()}` : '';
  // The preview for `key`, or undefined while it loads (the aside shows a skeleton then).
  const [loaded, setLoaded] = useState<{ key: string; value: LoadedPreview | null } | null>(null);

  useEffect(() => {
    if (!item || !['project', 'session', 'file'].includes(item.type)) return undefined;
    if (cacheRef.current.has(key)) {
      setLoaded({ key, value: cacheRef.current.get(key) ?? null });
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const work = item.type === 'project'
        ? loadProject(item, controller.signal)
        : item.type === 'session'
          ? loadDialog(item, query, controller.signal)
          : loadFile(item, query, controller.signal);
      work
        .catch(() => null)
        .then((value) => {
          if (controller.signal.aborted) return;
          cacheRef.current.set(key, value);
          setLoaded({ key, value });
        });
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `item` is identified by `key`; its other fields do not change the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!item) return { preview: null, isLoading: false };
  if (loaded?.key === key) return { preview: loaded.value, isLoading: false };
  const cached = cacheRef.current.get(key);
  if (cached !== undefined) return { preview: cached, isLoading: false };
  return { preview: null, isLoading: ['project', 'session', 'file'].includes(item.type) };
}
