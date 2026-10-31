import { Link } from 'react-router-dom';

import { Button, HoldButton, kabinaChatPath } from '@/modules/kabina';
import {
  agentActivity,
  agentLook,
  agentStateLabel,
  formatClock,
  formatDuration,
  formatTokens,
  isActiveState,
  liveDurationMs,
  parentName,
} from '@/modules/kabina-agents/utils/agentsView';
import type { LiveAgentAction, LiveAgentNode, LiveAgentsSession } from '@/shared/types';

type AgentDetailPanelProps = {
  session: LiveAgentsSession;
  agent: LiveAgentNode;
  receivedAt: number | undefined;
  now: number;
  busy: boolean;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onStop: () => void;
  onRetry: () => void;
};

const KIND_ROLE: Record<LiveAgentNode['kind'], string> = {
  orchestrator: 'главный диалог',
  subagent: 'субагент',
  shell: 'фоновая команда',
  workflow: 'воркфлоу',
  workflow_agent: 'агент воркфлоу',
  task: 'фоновая задача',
};

const MUTED_TOOLS = new Set(['Старт', 'Думает', 'Готово']);

function toolTone(action: LiveAgentAction): string | undefined {
  if (action.failed || action.kind === 'error') return 'err';
  if (action.tool === 'Ты') return 'you';
  if (action.tool === 'Agent' || action.tool === 'Task') return 'agent';
  if (MUTED_TOOLS.has(action.tool) || action.kind === 'start' || action.kind === 'finish') return 'mute';
  return undefined;
}

/**
 * Used by the «Агенты» screen: «02 / АГЕНТ» — what the picked agent does now,
 * its time, tokens and calls, its task, last actions and the actions on it.
 */
export default function AgentDetailPanel({ session, agent, receivedAt, now, busy, onApprove, onReject, onStop, onRetry }: AgentDetailPanelProps) {
  const look = agentLook(agent.state);
  const live = isActiveState(agent.state);
  const isMain = agent.id === 'main';
  const role = agent.role || KIND_ROLE[agent.kind];
  const task = agent.task || (isMain ? session.sessionTitle : null);
  const actions = agent.recentActions.slice(0, 5);
  const chatPath = session.projectId ? kabinaChatPath(session.projectId, session.sessionId) : null;

  return (
    <section className="kba-detail kb-bz kb-rise kb-d3" aria-labelledby="kba-h-agent" data-tone={look === 'wait' ? 'wait' : undefined}>
      <div className="kb-heading">
        <span className="kb-m kb-ruler-n" aria-hidden="true">02</span>
        <h2 id="kba-h-agent" className="kb-m kb-ruler-title">АГЕНТ</h2>
        <span className="kb-spacer" />
        <span className="kb-m kba-detail-where">{session.projectName} · {parentName(session, agent)}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span className="kb-t kba-detail-name">{agent.name}</span>
        <span className="kba-detail-tags">
          {agent.modelFamily ? <span className="kb-m kba-chip" data-model={agent.modelFamily}>{agent.modelFamily}</span> : null}
          <span className="kb-m kba-detail-state kba-st" data-look={look}>
            <span className={`kba-led kba-led-${look}`} aria-hidden="true" />
            {agentStateLabel(agent.state)}
          </span>
          <span className="kb-m" style={{ fontSize: 10.5, color: 'var(--kb-mute)' }}>{role}</span>
        </span>
      </div>

      <div className="kba-now" data-look={live || look === 'error' ? look : undefined}>
        <span className="kb-m kba-cap">СЕЙЧАС</span>
        <span className="kba-now-text">{agentActivity(agent)}</span>
        {look === 'tool' ? <span className="kba-toolline" aria-hidden="true"><span className="kba-scanbar" /></span> : null}
      </div>

      <div className="kba-read" role="list" data-cols={agent.tokens !== null ? 3 : 2}>
        <div role="listitem">
          <span className="kb-m kba-read-k">{live ? 'РАБОТАЕТ' : 'ЗАНЯЛО'}</span>
          <span className="kb-t kba-read-v">{formatDuration(liveDurationMs(agent, receivedAt, now))}</span>
        </div>
        {agent.tokens !== null ? (
          <div role="listitem">
            <span className="kb-m kba-read-k">ТОКЕНЫ</span>
            <span className="kb-t kba-read-v">{formatTokens(agent.tokens)}</span>
          </div>
        ) : null}
        <div role="listitem">
          <span className="kb-m kba-read-k">ВЫЗОВЫ</span>
          <span className="kb-t kba-read-v">{agent.toolCalls}</span>
        </div>
      </div>

      <div className="kba-block">
        <span className="kb-m kba-cap">ЗАДАЧА</span>
        <span className="kba-task">{task || 'Задача не передана — агент запущен без описания.'}</span>
      </div>

      <div className="kba-block">
        <span className="kb-m kba-cap">ПОСЛЕДНИЕ ДЕЙСТВИЯ</span>
        {actions.length === 0 ? (
          <p className="kba-log-empty">
            {isMain && session.status === 'external'
              ? 'Диалог идёт в терминале — его шаги появятся здесь, как только Claude вызовет инструмент.'
              : 'Агент ещё не вызывал инструменты.'}
          </p>
        ) : (
        <ol className="kba-log">
          {actions.map((action, index) => (
            <li key={`${action.at}-${index}`}>
              <span className="kb-m kba-log-t">{formatClock(action.at, true)}</span>
              <span className="kb-m kba-log-tool" data-tone={toolTone(action)}>{action.tool}</span>
              <span className="kba-log-what" title={action.text}>{action.text}</span>
            </li>
          ))}
        </ol>
        )}
      </div>

      {agent.state === 'waiting' && agent.permission ? (
        <div className="kba-detail-actions">
          <Button variant="pri" disabled={busy} onClick={() => agent.permission && onApprove(agent.permission.requestId)}>Разрешить один раз</Button>
          <Button variant="ghost" className="kba-reject" disabled={busy} onClick={() => agent.permission && onReject(agent.permission.requestId)}>Отклонить</Button>
        </div>
      ) : null}

      <div className="kba-detail-actions">
        {chatPath ? (
          <Link className="kb-btn kb-ghost" to={chatPath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" /></svg>
            Открыть диалог
          </Link>
        ) : null}
        {agent.canStop && live ? (
          <HoldButton
            label="Остановить"
            ariaLabel={isMain ? 'Остановить ход и всех агентов диалога — удерживай полторы секунды' : 'Остановить агента — удерживай полторы секунды'}
            onConfirm={onStop}
            disabled={busy}
          />
        ) : null}
        {agent.state === 'error' && !isMain && chatPath ? (
          <Button variant="ghost" className="kba-retry" onClick={onRetry}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg>
            Повторить
          </Button>
        ) : null}
      </div>
    </section>
  );
}
