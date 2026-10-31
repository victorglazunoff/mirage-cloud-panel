import assert from 'node:assert/strict';

import { test } from 'vitest';

import { applyAgentsDelta } from '@/modules/kabina-agents/hooks/useAgentsLive';
import {
  buildRadarLayout,
  collectWaitingPrompts,
  columnYs,
  countAgents,
  defaultSelection,
  eyebrowText,
  formatDuration,
  formatTokens,
  leadText,
  tokensPerHourParts,
  workingPhrase,
} from '@/modules/kabina-agents/utils/agentsView';
import { agent, NOW, plainSession, snapshot, workflowSession } from '@/modules/kabina-agents/tests/agentsFixtures';

test('numbers read like the mock-up', () => {
  assert.equal(formatDuration(134_000), '02:14');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  assert.equal(formatTokens(9800), '9,8k');
  assert.equal(formatTokens(312_400), '312,4k');
  assert.equal(formatTokens(null), '—');
  assert.deepEqual(tokensPerHourParts(1_842_300), { n: '1,84', unit: 'M' });
  assert.equal(eyebrowText(3, 12), 'ЖИВАЯ СХЕМА · 3 ПРОЕКТА · 12 АГЕНТОВ');
  assert.equal(eyebrowText(1, 1), 'ЖИВАЯ СХЕМА · 1 ПРОЕКТ · 1 АГЕНТ');
});

test('column places follow the mock-up: 2 → 26/74, 3 → 16/50/84', () => {
  assert.deepEqual(columnYs(1), [50]);
  assert.deepEqual(columnYs(2), [26, 74]);
  assert.deepEqual(columnYs(3), [16, 50, 84]);
});

test('a small session is a narrow radar with straight lines from the core', () => {
  const layout = buildRadarLayout(plainSession());
  assert.equal(layout.wide, false);
  assert.deepEqual(layout.core, { x: 20, y: 50 });
  assert.equal(layout.nodes.length, 2);
  assert.ok(layout.nodes.every((node) => node.x === 70));
  assert.equal(layout.links[0].d, 'M20 50 L70 26');
  assert.equal(layout.columns.length, 0);
});

test('a workflow session spreads its agents over phase columns and hides the run node', () => {
  const layout = buildRadarLayout(workflowSession());
  assert.equal(layout.wide, true);
  assert.deepEqual(layout.columns.map((column) => column.label), ['ФАЗА 01', 'ФАЗА 02', 'ФАЗА 03']);
  assert.equal(layout.nodes.length, 3);
  assert.ok(!layout.nodes.some((node) => node.agent.id === 'wf'));
  const xs = layout.nodes.map((node) => node.x);
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2]);
  assert.ok(layout.links.every((link) => link.d.startsWith('M10 ')));
  assert.equal(layout.nodes.find((node) => node.agent.id === 'wf:2')?.look, 'wait');
});

test('many agents make a wide card with several columns; children link to their parent', () => {
  const session = plainSession();
  const extra = Array.from({ length: 5 }, (_, index) => agent({ id: `x${index}`, name: `агент ${index}` }));
  const child = agent({ id: 'child', name: 'внук', parentId: 'x0', spawnDepth: 2 });
  session.agents = [...session.agents, ...extra, child];
  const layout = buildRadarLayout(session);
  assert.equal(layout.wide, true);
  assert.equal(new Set(layout.nodes.map((node) => node.x)).size >= 2, true);
  const childLink = layout.links.find((link) => link.agentId === 'child');
  const parent = layout.nodes.find((node) => node.agent.id === 'x0');
  assert.ok(childLink && parent && childLink.d.startsWith(`M${parent.x} ${parent.y} L`));
});

test('waiting prompts carry the full command; the lead asks for the «да» first', () => {
  const sessions = [workflowSession(), plainSession()];
  const prompts = collectWaitingPrompts(sessions);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].command, 'rsync -az dist/ prod:/var/www/demo-site');
  assert.equal(prompts[0].agent.name, 'Выкладка на прод');
  const lead = leadText(sessions, prompts);
  assert.ok(lead.startsWith('Сайт клиента: «Выкладка на прод» ждёт разрешения на Bash'));
  assert.ok(lead.includes('«Выжимка конкурентов» споткнулся'));
  assert.deepEqual(defaultSelection(sessions), { sessionId: 's-zag', agentId: 'wf:2' });
});

test('a delta replaces changed sessions, drops removed ones and puts new feed rows on top', () => {
  const base = snapshot([workflowSession(), plainSession()], 10);
  const state = { sessions: base.sessions, feed: base.feed, stats: base.stats, receivedAt: { 's-zag': 1, 's-map': 1 }, seq: 10 };
  const changed = plainSession();
  changed.status = 'background';
  const next = applyAgentsDelta(state, {
    seq: 11,
    generatedAt: new Date(NOW).toISOString(),
    sessions: [changed],
    removedSessionIds: ['s-zag'],
    feed: [{ id: 3, at: new Date(NOW).toISOString(), sessionId: 's-map', projectName: 'Карта участков', agentId: 'a1', agentName: 'Запросы Wordstat', kind: 'done', text: 'готово' }],
    stats: { ...base.stats, waiting: 0 },
  }, 99);
  assert.deepEqual(next.sessions.map((session) => session.sessionId), ['s-map']);
  assert.equal(next.sessions[0].status, 'background');
  assert.equal(next.receivedAt['s-map'], 99);
  assert.equal(next.receivedAt['s-zag'], undefined);
  assert.deepEqual(next.feed.map((event) => event.id), [3, 2, 1]);
  assert.equal(next.stats?.waiting, 0);
  // A stale frame changes nothing.
  assert.equal(applyAgentsDelta(next, { seq: 11, generatedAt: '', sessions: [], removedSessionIds: ['s-map'], feed: [], stats: base.stats }, 100), next);
});

test('«работает» agrees with the number', () => {
  assert.equal(workingPhrase(1), 'Работает 1 агент');
  assert.equal(workingPhrase(2), 'Работают 2 агента');
  assert.equal(workingPhrase(5), 'Работают 5 агентов');
  assert.equal(workingPhrase(21), 'Работает 21 агент');
});

test('the board counts the same sessions the eyebrow and the lead read', () => {
  const sessions = [workflowSession(), plainSession()];
  const counts = countAgents(sessions);
  const all = sessions.flatMap((session) => session.agents);
  assert.equal(counts.agents, all.length);
  assert.equal(counts.waiting, all.filter((node) => node.state === 'waiting').length);
  assert.equal(counts.errors, all.filter((node) => node.state === 'error').length);
  assert.equal(counts.working + counts.waiting + counts.errors, all.filter((node) => !['done', 'stopped'].includes(node.state)).length);
  assert.ok(leadText(sessions.slice(0, 0), []).includes('никто не работает'));
});
