import type { HomeActivityItem } from '@/shared/types';

type ActivityRow = {
  key: string;
  sessionId: string;
  projectId: string | null;
  kind: 'wait' | 'run' | 'bg';
  project: string;
  what: string;
  command: string | null;
  since: number;
};

/**
 * Flattens busy sessions into rows: one per turn (waiting or running) and one
 * per background task, so a session with three agents in flight shows three.
 */
export function buildActivityRows(activity: HomeActivityItem[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const item of activity) {
    if (item.state === 'waiting') {
      rows.push({
        key: `${item.sessionId}:turn`,
        sessionId: item.sessionId,
        projectId: item.projectId,
        kind: 'wait',
        project: item.projectName,
        what: `${item.sessionTitle} — нужно разрешить ${item.permission?.toolName ?? 'инструмент'}${item.permission?.summary ? ':' : ''}`,
        command: item.permission?.summary || null,
        since: item.permission ? Date.parse(item.permission.receivedAt) : item.startedAt,
      });
    } else if (item.state === 'running') {
      rows.push({
        key: `${item.sessionId}:turn`,
        sessionId: item.sessionId,
        projectId: item.projectId,
        kind: 'run',
        project: item.projectName,
        what: item.external ? `${item.sessionTitle} · в терминале Claude` : item.sessionTitle,
        command: null,
        since: item.startedAt,
      });
    }
    const tasks = item.tasks.length || item.state !== 'background'
      ? item.tasks
      : [{ taskId: 'work', description: 'фоновая работа', taskType: '', startedAt: item.startedAt }];
    for (const task of tasks) {
      rows.push({
        key: `${item.sessionId}:${task.taskId}`,
        sessionId: item.sessionId,
        projectId: item.projectId,
        kind: 'bg',
        project: item.projectName,
        what: `Фоновый агент · ${task.description}`,
        command: null,
        since: task.startedAt,
      });
    }
  }
  return rows;
}
