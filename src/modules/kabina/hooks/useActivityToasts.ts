import { useEffect, useRef, useState } from 'react';

import { useKabinaToasts } from '@/modules/kabina/context/KabinaToastContext';
import { useHomeOverviewFeed } from '@/shared/hooks/useHomeOverviewFeed';
import type { HomeActivityItem, KabinaLiveSummary } from '@/shared/types';

function chatPath(item: { projectId: string | null; sessionId: string }): string {
  return item.projectId
    ? `/p/${encodeURIComponent(item.projectId)}/s/${encodeURIComponent(item.sessionId)}`
    : `/session/${encodeURIComponent(item.sessionId)}`;
}

/** How long something has lasted: «меньше минуты», «4 мин» (a duration, never «только что»). */
function minutesSince(ms: number): string {
  const elapsed = Date.now() - ms;
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'меньше минуты';
  return `${Math.round(elapsed / 60_000)} мин`;
}

/**
 * Used by KabinaShell: watches the home read model and files DarkStates events into
 * the notification centre (the bell) on every screen — T3 «Нужно твоё решение» when a session starts waiting,
 * T1 «Ход закончен» and T2 «Фоновый агент сдал работу» when work ends. The
 * session open on screen gets no entry (its feed already shows it). Returns
 * what runs now: the phone «Агенты» badge and the HUD's «работают N · ждёт N».
 */
export function useActivityToasts(activeSessionId: string | null): KabinaLiveSummary {
  const { show, dismiss, items } = useKabinaToasts();
  // What runs now across the panel: the phone nav badge and the HUD summary read it.
  const [summary, setSummary] = useState<KabinaLiveSummary>({ runningCount: 0, working: 0, waiting: 0 });
  const previousRef = useRef<Map<string, HomeActivityItem> | null>(null);
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const toastRef = useRef({ show, dismiss, items });
  toastRef.current = { show, dismiss, items };

  // One shared poll of the home read model (the home screen reads the same answer).
  const { overview } = useHomeOverviewFeed();

  useEffect(() => {
    if (!overview) return;
    const activity = overview.activity;
    const { show: showToast, dismiss: dismissToast } = toastRef.current;
    const current = new Map(activity.map((item) => [item.sessionId, item]));
    const runningCount = activity.reduce((sum, item) => sum + (item.state === 'background' ? 0 : 1) + item.tasks.length, 0);
    const waiting = activity.filter((item) => item.state === 'waiting').length;
    setSummary((before) => (
      before.runningCount === runningCount && before.waiting === waiting && before.working === activity.length - waiting
        ? before
        : { runningCount, waiting, working: activity.length - waiting }
    ));

    const previous = previousRef.current;
    previousRef.current = current;
    if (!previous) {
      // The first read is the baseline, not news. Decisions kept in the bell from before a reload
      // whose session no longer waits (answered or ended meanwhile) are stale: they go.
      for (const entry of toastRef.current.items) {
        if (!entry.id.startsWith('wait-')) continue;
        if (current.get(entry.id.slice('wait-'.length))?.state !== 'waiting') dismissToast(entry.id);
      }
      return;
    }

    for (const item of activity) {
      const before = previous.get(item.sessionId);
      if (item.state === 'waiting' && before?.state !== 'waiting' && item.sessionId !== activeRef.current) {
        const since = item.permission ? Date.parse(item.permission.receivedAt) : item.startedAt;
        showToast({
          id: `wait-${item.sessionId}`,
          kind: 'wait',
          project: item.projectName.toUpperCase(),
          title: 'Нужно твоё решение',
          sub: `${item.permission?.toolName ?? 'Инструмент'}${item.permission?.summary ? ` · ${item.permission.summary}` : ''} · ждёт ${minutesSince(since)}`,
          actions: [{ label: 'Ответить', variant: 'pri', href: chatPath(item) }],
        });
      }
      if (before?.state === 'waiting' && item.state !== 'waiting') {
        dismissToast(`wait-${item.sessionId}`);
      }
      if (before) {
        const finishedTasks = before.tasks.filter((task) => !item.tasks.some((next) => next.taskId === task.taskId));
        if (finishedTasks.length > 0 && item.sessionId !== activeRef.current) {
          showToast({
            id: `bg-${item.sessionId}`,
            kind: 'bg',
            project: item.projectName.toUpperCase(),
            title: finishedTasks.length > 1 ? `${finishedTasks.length} агента закончили` : 'Фоновый агент сдал работу',
            sub: finishedTasks.map((task) => task.description).join(' · '),
            actions: [{ label: 'Посмотреть итог', href: chatPath(item) }],
          });
        }
      }
    }

    for (const [sessionId, before] of previous) {
      if (current.has(sessionId)) continue;
      dismissToast(`wait-${sessionId}`);
      if (sessionId === activeRef.current) continue;
      const hadTurn = before.state === 'running' || before.state === 'waiting';
      showToast({
        id: `done-${sessionId}`,
        kind: hadTurn ? 'ok' : 'bg',
        project: before.projectName.toUpperCase(),
        title: hadTurn ? 'Ход закончен' : 'Фоновая работа завершена',
        sub: `${before.sessionTitle} · ${minutesSince(before.startedAt)}`,
        actions: [{ label: 'Открыть', href: chatPath(before) }],
      });
    }
  }, [overview]);

  return summary;
}
