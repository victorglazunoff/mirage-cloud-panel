// Test data for the «Агенты» screen: a workflow session waiting for a permission
// and a plain session with a failed subagent, shaped like GET /api/agents/live.
import type { LiveAgentNode, LiveAgentsSession, LiveAgentsSnapshot } from '@/shared/types';

export const NOW = Date.parse('2026-10-26T14:32:16Z');

export function agent(overrides: Partial<LiveAgentNode> & { id: string; name: string }): LiveAgentNode {
  return {
    kind: 'subagent',
    parentId: 'main',
    taskId: `task-${overrides.id}`,
    toolUseId: `tu-${overrides.id}`,
    parentTaskId: null,
    spawnDepth: 1,
    role: 'субагент',
    model: 'claude-haiku-4-5',
    modelFamily: 'haiku',
    state: 'tool',
    currentAction: 'Bash npm test',
    task: 'Проверить тесты',
    backgrounded: true,
    startedAt: new Date(NOW - 120_000).toISOString(),
    endedAt: null,
    durationMs: 120_000,
    tokens: 18_400,
    toolCalls: 12,
    recentActions: [
      { at: new Date(NOW - 5_000).toISOString(), tool: 'Bash', text: 'npm test', kind: 'tool' },
      { at: new Date(NOW - 60_000).toISOString(), tool: 'Старт', text: 'задача от «Главный диалог»', kind: 'start' },
    ],
    summary: null,
    error: null,
    permission: null,
    canStop: true,
    ...overrides,
  };
}

function orchestrator(name: string, overrides: Partial<LiveAgentNode> = {}): LiveAgentNode {
  return agent({
    id: 'main',
    name,
    kind: 'orchestrator',
    parentId: null,
    taskId: null,
    spawnDepth: 0,
    role: 'оркестратор',
    modelFamily: 'opus',
    model: 'claude-opus-4',
    state: 'thinking',
    currentAction: 'Думает: сводит отчёт',
    ...overrides,
  });
}

const PERMISSION = {
  requestId: 'req-1',
  toolName: 'Bash',
  summary: 'rsync dist/ → прод',
  input: { command: 'rsync -az dist/ prod:/var/www/demo-site' },
  receivedAt: new Date(NOW - 134_000).toISOString(),
};

export function workflowSession(): LiveAgentsSession {
  const collect = agent({ id: 'wf:0', name: 'Сбор объявлений', kind: 'workflow_agent', parentId: 'wf', taskId: null, state: 'done', summary: 'Собрал 212 объявлений', endedAt: new Date(NOW - 60_000).toISOString() });
  const check = agent({ id: 'wf:1', name: 'скептик данных', kind: 'workflow_agent', parentId: 'wf', taskId: null, state: 'done', modelFamily: 'sonnet' });
  const deploy = agent({ id: 'wf:2', name: 'Выкладка на прод', kind: 'workflow_agent', parentId: 'wf', taskId: null, state: 'waiting', permission: PERMISSION, modelFamily: 'sonnet', canStop: false });
  const workflow = agent({ id: 'wf', name: 'ночная сборка', kind: 'workflow', state: 'tool' });
  return {
    sessionId: 's-zag',
    provider: 'claude',
    providerSessionId: 'p-s-zag',
    projectId: 'p-zag',
    projectName: 'Сайт клиента',
    projectPath: '/home/user/demo-site',
    sessionTitle: 'Ночная сборка',
    status: 'waiting',
    startedAt: new Date(NOW - 2_472_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    orchestrator: orchestrator('Ночная сборка'),
    agents: [orchestrator('Ночная сборка'), workflow, collect, check, deploy],
    workflows: [{
      nodeId: 'wf',
      name: 'ночная сборка',
      phases: [
        { index: 0, title: 'Сбор', state: 'done', agentIds: ['wf:0'] },
        { index: 1, title: 'Проверка', state: 'done', agentIds: ['wf:1'] },
        { index: 2, title: 'Выкладка', state: 'waiting', agentIds: ['wf:2'] },
      ],
    }],
    pendingPermissions: [{ ...PERMISSION, agentId: 'wf:2' }],
    usage: null,
  };
}

export function plainSession(): LiveAgentsSession {
  const main = orchestrator('SEO-тексты · 14 стр.', { modelFamily: 'sonnet' });
  return {
    sessionId: 's-map',
    provider: 'claude',
    providerSessionId: 'p-s-map',
    projectId: 'p-map',
    projectName: 'Карта участков',
    projectPath: '/home/user/demo-map',
    sessionTitle: 'SEO-тексты',
    status: 'running',
    startedAt: new Date(NOW - 742_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    orchestrator: main,
    agents: [
      main,
      agent({ id: 'a1', name: 'Запросы Wordstat', currentAction: 'WebSearch: участки Арамиль ИЖС' }),
      agent({ id: 'a2', name: 'Выжимка конкурентов', state: 'error', error: 'WebFetch: 403 на сайте конкурента', currentAction: null, canStop: false, endedAt: new Date(NOW - 30_000).toISOString() }),
    ],
    workflows: [],
    pendingPermissions: [],
    usage: null,
  };
}

export function snapshot(sessions: LiveAgentsSession[], seq = 10): LiveAgentsSnapshot {
  return {
    generatedAt: new Date(NOW).toISOString(),
    seq,
    sessions,
    feed: [
      { id: 2, at: new Date(NOW - 2_000).toISOString(), sessionId: 's-map', projectName: 'Карта участков', agentId: 'a1', agentName: 'Запросы Wordstat', kind: 'tool', text: 'WebSearch «дом в Арамиле»' },
      { id: 1, at: new Date(NOW - 9_000).toISOString(), sessionId: 's-zag', projectName: 'Сайт клиента', agentId: 'wf:2', agentName: 'Выкладка на прод', kind: 'waiting', text: 'ждёт разрешения: Bash rsync' },
    ],
    stats: { working: 4, waiting: 1, doneLastHour: 2, errors: 1, tokensLastHour: 1_842_300, activeProjects: 2 },
  };
}
