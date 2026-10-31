import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, scheduledMessagesDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { readTimezoneOffset } from '@/modules/home/home.routes.js';
import { createHomeOverviewService } from '@/modules/home/services/home-overview.service.js';

async function withIsolatedDatabase(runTest: (context: { userId: number; root: string }) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'home-overview-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('alice', 'hash');
    await runTest({ userId: Number(user.id), root: tempDirectory });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('overview lists waiting before running work, with project names and the pending tool', async () => {
  await withIsolatedDatabase(async ({ userId, root }) => {
    const demoMap = path.join(root, 'demo-map');
    const demoSite = path.join(root, 'demo-site');
    sessionsDb.createAppSession('s-run', 'claude', demoMap, 'SEO-тексты');
    sessionsDb.createAppSession('s-wait', 'claude', demoSite, 'Выкладка цен');
    sessionsDb.createAppSession('s-bg', 'claude', demoMap, 'Фон');

    const service = createHomeOverviewService({
      now: () => Date.parse('2026-10-26T09:32:00Z'),
      listRunningSessions: async () => [
        { sessionId: 's-run', provider: 'claude', startedAt: 1000 },
        { sessionId: 's-wait', provider: 'claude', startedAt: 2000 },
        {
          sessionId: 's-bg',
          provider: 'claude',
          startedAt: 500,
          background: true,
          tasks: [{ taskId: 't1', toolUseId: 'u1', taskType: 'local_agent', description: 'SEO для 14 страниц', startedAt: 500 }],
        },
      ],
      getPendingApprovals: (sessionId) => (sessionId === 's-wait'
        ? [{ requestId: 'r1', toolName: 'Bash', input: { command: 'bash deploy.sh --prod' }, receivedAt: new Date('2026-10-26T09:30:00Z') }]
        : []),
    });

    const overview = await service.getOverview({ userId, tzOffsetMinutes: -300 });
    assert.deepEqual(overview.activity.map((item) => [item.sessionId, item.state]), [
      ['s-wait', 'waiting'],
      ['s-run', 'running'],
      ['s-bg', 'background'],
    ]);
    const waiting = overview.activity[0];
    assert.equal(waiting.projectName, 'demo-site');
    assert.equal(waiting.sessionTitle, 'Выкладка цен');
    assert.deepEqual(waiting.permission, {
      requestId: 'r1',
      toolName: 'Bash',
      summary: 'bash deploy.sh --prod',
      receivedAt: '2026-10-26T09:30:00.000Z',
    });
    assert.equal(overview.activity[2].tasks[0].description, 'SEO для 14 страниц');
    assert.ok(overview.activity[1].projectId, 'project id resolves for navigation');
  });
});

test('favourites are the starred projects with last session and a 14-day strip', async () => {
  await withIsolatedDatabase(async ({ userId, root }) => {
    const starredPath = path.join(root, 'demo-villa');
    sessionsDb.createAppSession('fav-1', 'claude', starredPath, 'Запуск');
    sessionsDb.createAppSession('other-1', 'claude', path.join(root, 'quiet'), 'Тихий');
    projectsDb.updateProjectIsStarred(starredPath, true);

    const service = createHomeOverviewService({ listRunningSessions: async () => [], getPendingApprovals: () => [] });
    const overview = await service.getOverview({ userId, tzOffsetMinutes: 0 });

    assert.equal(overview.projectCount, 2);
    assert.equal(overview.favorites.length, 1);
    const [favorite] = overview.favorites;
    assert.equal(favorite.displayName, 'demo-villa');
    assert.equal(favorite.lastSessionId, 'fav-1');
    assert.equal(favorite.sessionCount, 1);
    assert.equal(favorite.activityByDay.length, 14);
    assert.equal(favorite.activityByDay[13], 1, 'today is the last bar');
  });
});

test('scheduled messages become events with their session and project', async () => {
  await withIsolatedDatabase(async ({ userId, root }) => {
    sessionsDb.createAppSession('sched-1', 'claude', path.join(root, 'intehstal'), 'Отчёт клиенту');
    const at = new Date(Date.now() + 2 * 60 * 60 * 1000);
    scheduledMessagesDb.create({ userId, sessionId: 'sched-1', content: 'Пришли   итоги\nнедели', options: {}, scheduledFor: at });
    // Far beyond the horizon: not an event of this month.
    scheduledMessagesDb.create({ userId, sessionId: 'sched-1', content: 'later', options: {}, scheduledFor: new Date(Date.now() + 90 * 86_400_000) });

    const service = createHomeOverviewService({ listRunningSessions: async () => [], getPendingApprovals: () => [] });
    const overview = await service.getOverview({ userId, tzOffsetMinutes: 0 });

    assert.equal(overview.scheduled.length, 1);
    assert.equal(overview.scheduled[0].projectName, 'intehstal');
    assert.equal(overview.scheduled[0].sessionTitle, 'Отчёт клиенту');
    assert.equal(overview.scheduled[0].preview, 'Пришли итоги недели');
    assert.equal(overview.scheduled[0].scheduledFor, at.toISOString());
  });
});

test('readTimezoneOffset accepts real browser offsets only', () => {
  assert.equal(readTimezoneOffset('-300'), -300);
  assert.equal(readTimezoneOffset('180'), 180);
  assert.equal(readTimezoneOffset('99999'), 0);
  assert.equal(readTimezoneOffset('abc'), 0);
  assert.equal(readTimezoneOffset(undefined), 0);
  assert.equal(readTimezoneOffset(['-300']), 0);
});

test('projects board lists active and archived projects with stats and terminal-only folders', async () => {
  await withIsolatedDatabase(async ({ root }) => {
    const active = path.join(root, 'demo-map');
    const archived = path.join(root, 'old-quiz');
    sessionsDb.createAppSession('a-1', 'claude', active, 'SEO-тексты');
    sessionsDb.createAppSession('b-1', 'claude', archived, 'Квиз');
    projectsDb.updateProjectIsArchived(archived, true);

    const service = createHomeOverviewService({
      listRunningSessions: async () => [{ sessionId: 'a-1', provider: 'claude', startedAt: 1000 }],
      getPendingApprovals: () => [],
    });
    const board = await service.getProjectsBoard({ tzOffsetMinutes: 0 });

    const byName = new Map(board.projects.map((project) => [project.displayName, project]));
    assert.equal(byName.get('demo-map')?.isArchived, false);
    assert.equal(byName.get('demo-map')?.lastSessionTitle, 'SEO-тексты');
    assert.equal(byName.get('demo-map')?.sessionCount, 1);
    assert.equal(byName.get('old-quiz')?.isArchived, true);
    assert.deepEqual(board.activity.map((item) => [item.projectId, item.state]), [[byName.get('demo-map')?.projectId, 'running']]);
    // The archived project's folder is not an active project, so the wizard may offer it again.
    assert.deepEqual(board.terminalRecent.map((row) => row.path), [archived]);
  });
});
