import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { setPanelTimeZone } from '@/modules/kabina';

// The fixtures are built from local fields, so the panel zone is the process zone here.
beforeAll(() => setPanelTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));

import {
  buildGroups,
  buildProjectViews,
  buildSummary,
  countProjects,
  formatLastActivity,
  shortProjectPath,
  sortProjects,
  sparkBars,
} from '@/modules/kabina-projects/utils/projectsBoardView';
import type { HomeBoardProject, HomeProjectsBoard } from '@/shared/types';

const NOW = new Date(2026, 9, 26, 14, 32).getTime();
const DAY = 24 * 60 * 60_000;
const FOLDER = '/home/user/Documents/Claude Code/Проекты';

function project(overrides: Partial<HomeBoardProject> & { projectId: string; displayName: string }): HomeBoardProject {
  return {
    projectPath: `${FOLDER}/${overrides.projectId}`,
    lastActivity: new Date(NOW - 2 * DAY).toISOString(),
    lastSessionId: null,
    lastSessionTitle: null,
    sessionCount: 3,
    activityByDay: new Array(14).fill(0),
    isStarred: false,
    isArchived: false,
    ...overrides,
  };
}

const BOARD: HomeProjectsBoard = {
  generatedAt: new Date(NOW).toISOString(),
  projects: [
    project({ projectId: 'demo-map', displayName: 'Карта участков', isStarred: true, activityByDay: [...new Array(13).fill(0), 9] }),
    project({ projectId: 'demo-site', displayName: 'Сайт клиента', isStarred: true }),
    project({ projectId: 'demo-villa', displayName: 'DemoVilla', isStarred: true, lastSessionTitle: 'скриншоты формы' }),
    project({ projectId: 'domo', displayName: 'Домо', lastActivity: new Date(NOW - 20 * DAY).toISOString() }),
    project({ projectId: 'fresh', displayName: 'Новый', sessionCount: 0, lastActivity: null }),
    project({ projectId: 'old-quiz', displayName: 'Квиз v2', isArchived: true }),
  ],
  activity: [
    {
      sessionId: 's-run', provider: 'claude', projectId: 'demo-map', projectName: 'Карта участков', sessionTitle: 'SEO',
      state: 'running', startedAt: NOW - 12 * 60_000, external: false, permission: null,
      tasks: [{ taskId: 't1', description: 'SEO-тексты 9 из 14', taskType: 'local_agent', startedAt: NOW }],
    },
    {
      sessionId: 's-wait', provider: 'claude', projectId: 'demo-site', projectName: 'Сайт клиента', sessionTitle: 'Цены',
      state: 'waiting', startedAt: NOW - 5 * 60_000, external: false,
      permission: { requestId: 'r', toolName: 'Bash', summary: 'выкладка цен на прод', receivedAt: new Date(NOW - 2 * 60_000).toISOString() },
      tasks: [],
    },
  ],
  terminalRecent: [],
  projectsFolder: { path: FOLDER, unadded: [] },
};

test('statuses follow live work: running, waiting, quiet with the last chat, new without chats', () => {
  const views = buildProjectViews(BOARD, NOW);
  const byId = new Map(views.map((view) => [view.id, view]));
  assert.equal(byId.get('demo-map')?.status, 'Агент работает · 12 мин');
  assert.equal(byId.get('demo-map')?.sub, '2 агента · SEO-тексты 9 из 14');
  assert.equal(byId.get('demo-map')?.last, 'сейчас');
  assert.equal(byId.get('demo-site')?.status, 'Ждёт разрешения · 2 мин');
  assert.equal(byId.get('demo-site')?.sub, 'выкладка цен на прод');
  assert.equal(byId.get('demo-site')?.last, '2 мин назад');
  assert.equal(byId.get('demo-villa')?.sub, 'последний: скриншоты формы');
  assert.equal(byId.get('fresh')?.kind, 'new');
  assert.equal(byId.get('fresh')?.status, 'Новый · чат не начат');
  assert.equal(byId.get('domo')?.isDim, true, 'quiet for over a week and not starred');
  assert.equal(byId.get('demo-villa')?.isDim, false, 'starred projects are never dimmed');
  assert.equal(byId.get('demo-map')?.shortPath, 'Проекты/demo-map');
});

test('groups per filter, search over name and folder, and the counters', () => {
  const views = buildProjectViews(BOARD, NOW);
  assert.deepEqual(countProjects(views), { all: 5, fav: 3, active: 2, archive: 1 });
  assert.deepEqual(buildGroups(views, 'all', '', 'act').map((group) => [group.title, group.meta]), [
    ['ИЗБРАННЫЕ', '3 · на главном экране'],
    ['ОСТАЛЬНЫЕ', '2 · тихие дольше недели приглушены'],
  ]);
  assert.deepEqual(buildGroups(views, 'active', '', 'act')[0].items.map((view) => view.id), ['demo-site', 'demo-map']);
  assert.deepEqual(buildGroups(views, 'archive', '', 'act')[0].items.map((view) => view.id), ['old-quiz']);
  assert.deepEqual(buildGroups(views, 'all', 'VILLA', 'act').flatMap((group) => group.items.map((view) => view.id)), ['demo-villa']);
  assert.deepEqual(buildGroups(views, 'all', 'nothing-here', 'act'), []);
});

test('sorting by activity puts waiting, running and new first; by name is alphabetical', () => {
  const views = buildProjectViews(BOARD, NOW).filter((view) => !view.isArchived);
  assert.deepEqual(sortProjects(views, 'act').map((view) => view.id).slice(0, 3), ['demo-site', 'demo-map', 'fresh']);
  assert.deepEqual(sortProjects(views, 'name').map((view) => view.name), ['Домо', 'Карта участков', 'Новый', 'Сайт клиента', 'DemoVilla']);
});

test('summary cells name the running and waiting projects', () => {
  const summary = buildSummary(buildProjectViews(BOARD, NOW), BOARD);
  assert.equal(summary.total, 5);
  assert.equal(summary.totalLabel, 'проектов · ещё 1 в архиве');
  assert.equal(summary.running, 2);
  assert.equal(summary.runningLabel, 'агента · Карта участков');
  assert.equal(summary.waiting, 1);
  assert.equal(summary.waitingLabel, 'Сайт клиента · выкладка цен на прод');
});

test('wording of dates and paths', () => {
  assert.equal(formatLastActivity(new Date(2026, 9, 26, 9, 12).toISOString(), NOW), 'сегодня 09:12');
  assert.equal(formatLastActivity(new Date(2026, 9, 25, 19, 40).toISOString(), NOW), 'вчера 19:40');
  assert.equal(formatLastActivity(new Date(2026, 9, 21, 10, 0).toISOString(), NOW), '21.10');
  assert.equal(formatLastActivity(null, NOW), '—');
  assert.equal(shortProjectPath('/home/user/Downloads/brief', FOLDER), '~/Downloads/brief');
});

test('activity bars share the board scale and live projects light the last three', () => {
  const bars = sparkBars([0, 9, 1, 2], true, false, 9);
  assert.deepEqual(bars.map((bar) => bar.tone), ['off', 'hot', 'hot', 'hot']);
  assert.equal(bars[0].height, 3);
  assert.equal(bars[1].height, 19);
  assert.equal(sparkBars([1], false, true, 1)[0].height, 3 + 16 / 5, 'a quiet board is not blown up');
});
