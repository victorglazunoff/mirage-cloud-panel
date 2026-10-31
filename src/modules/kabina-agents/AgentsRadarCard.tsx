import { Link } from 'react-router-dom';

import { kabinaChatPath } from '@/modules/kabina';
import {
  agentActivity,
  agentLook,
  agentStateLabel,
  formatDuration,
  formatTokens,
  isActiveState,
  liveDurationMs,
  ruPlural,
  shortProjectPath,
} from '@/modules/kabina-agents/utils/agentsView';
import type { RadarLayout } from '@/modules/kabina-agents/utils/agentsView';
import type { LiveAgentNode, LiveAgentsSession, LiveWorkflowPhase } from '@/shared/types';

type AgentsRadarCardProps = {
  session: LiveAgentsSession;
  layout: RadarLayout;
  selectedAgentId: string | null;
  receivedAt: number | undefined;
  now: number;
  clock: string;
  onSelect: (agentId: string) => void;
};

const PHASE_STATE: Record<LiveWorkflowPhase['state'], { label: string; color: string }> = {
  queued: { label: 'в очереди', color: 'var(--kb-mute)' },
  running: { label: 'идёт', color: 'var(--kb-signal-text)' },
  waiting: { label: 'ждёт тебя', color: 'var(--kb-signal)' },
  done: { label: 'готово', color: 'var(--kb-sage)' },
  failed: { label: 'сбой', color: 'var(--kb-sand)' },
};

/** Range rings, ticks and axes of the radar, centred on the core (DarkAgents `.fx` svg). */
function RadarRings({ left, top }: { left: string; top: string }) {
  return (
    <svg className="kba-fx kba-rings" width="1600" height="1600" viewBox="-800 -800 1600 1600" aria-hidden="true" style={{ left, top }}>
      <circle r="96" fill="none" stroke="rgba(255,106,43,0.18)" strokeWidth="5" strokeDasharray="1 9.05" />
      <circle r="96" fill="none" stroke="rgba(255,236,210,0.08)" />
      <circle r="192" fill="none" stroke="rgba(255,236,210,0.06)" strokeDasharray="2 6" />
      <circle r="288" fill="none" stroke="rgba(255,236,210,0.07)" />
      <circle r="384" fill="none" stroke="rgba(255,236,210,0.05)" strokeDasharray="2 6" />
      <circle r="480" fill="none" stroke="rgba(255,236,210,0.06)" />
      <circle r="576" fill="none" stroke="rgba(255,236,210,0.045)" strokeDasharray="2 6" />
      <circle r="672" fill="none" stroke="rgba(255,236,210,0.05)" />
      <circle r="768" fill="none" stroke="rgba(255,236,210,0.04)" strokeDasharray="2 6" />
      <path d="M-800 0H800M0 -800V800" stroke="rgba(255,236,210,0.06)" strokeDasharray="3 5" />
      <text x="292" y="-6" fill="#948C7E" fillOpacity="0.7" fontFamily="Martian Mono, monospace" fontSize="9">1</text>
      <text x="484" y="-6" fill="#948C7E" fillOpacity="0.7" fontFamily="Martian Mono, monospace" fontSize="9">2</text>
      <text x="676" y="-6" fill="#948C7E" fillOpacity="0.7" fontFamily="Martian Mono, monospace" fontSize="9">3</text>
    </svg>
  );
}

function ModelChip({ family }: { family: string | null }) {
  if (!family) return null;
  return <span className="kb-m kba-chip" data-model={family}>{family}</span>;
}

/** «02:14 · 9,8k»; the tokens part is left out while the agent has none to report. */
function nodeMeta(agent: LiveAgentNode, receivedAt: number | undefined, now: number): string {
  const prefix = agent.state === 'waiting' ? 'ждёт ' : '';
  const tokens = agent.tokens !== null ? ` · ${formatTokens(agent.tokens)}` : '';
  return `${prefix}${formatDuration(liveDurationMs(agent, receivedAt, now))}${tokens}`;
}

/**
 * Used by the «Агенты» screen: one project card — header, workflow phase strip
 * and the radar stage with the main dialog in the centre and its agents as
 * contacts (a plain list on narrow cards, by container query).
 */
export default function AgentsRadarCard({ session, layout, selectedAgentId, receivedAt, now, clock, onSelect }: AgentsRadarCardProps) {
  const core = session.orchestrator;
  const coreLook = agentLook(core.state);
  const coreLive = isActiveState(core.state);
  const waiting = session.agents.filter((agent) => agent.state === 'waiting').length;
  const errors = session.agents.filter((agent) => agent.state === 'error').length;
  const total = session.agents.length;
  const contacts = layout.nodes.filter((node) => isActiveState(node.agent.state)).length;
  const coreLeft = `${layout.core.x}%`;
  const coreTop = `${layout.core.y}%`;

  let meta = `${total} ${ruPlural(total, 'агент', 'агента', 'агентов')}`;
  let metaColor = 'var(--kb-mute)';
  if (waiting > 0) {
    meta += ` · ${waiting} ждёт тебя`;
    metaColor = 'var(--kb-signal)';
  } else if (errors > 0) {
    meta += ` · ${errors} ${ruPlural(errors, 'ошибка', 'ошибки', 'ошибок')}`;
    metaColor = 'var(--kb-sand)';
  }
  const sub = layout.workflowName ? `воркфлоу «${layout.workflowName}»` : session.sessionTitle;
  const path = shortProjectPath(session.projectPath);

  return (
    <article
      className="kba-card kb-bz kb-rise kb-d2"
      aria-label={session.projectName}
      data-wide={layout.wide ? '' : undefined}
      data-tone={waiting > 0 ? 'wait' : undefined}
    >
      <div className="kba-card-head">
        <h3 className="kba-card-name">{session.projectName}</h3>
        <span className="kb-m kba-card-path">{path ? `${path} · ` : ''}{sub}</span>
        <span className="kb-spacer" />
        <span className="kb-m kba-card-meta" style={{ color: metaColor }}>{meta}</span>
        {session.projectId ? (
          <Link className="kba-open" to={kabinaChatPath(session.projectId, session.sessionId)}>Открыть →</Link>
        ) : null}
      </div>

      {layout.phases.length > 0 ? (
        <ol className="kba-phases" aria-label="Фазы воркфлоу">
          {layout.phases.map((phase) => {
            const look = PHASE_STATE[phase.state];
            return (
              <li key={phase.index} className="kba-phase">
                <span className="kb-m kba-phase-cap">
                  <span><b>{String(phase.index + 1).padStart(2, '0')}</b> {phase.title.toUpperCase()}</span>
                  <span style={{ color: look.color }}>{look.label}</span>
                </span>
                <span className="kba-phase-bar" data-state={phase.state} aria-hidden="true">
                  {phase.state === 'running' ? <span className="kba-scanbar" /> : null}
                </span>
                <span className="kba-phase-ticks" aria-hidden="true" />
              </li>
            );
          })}
        </ol>
      ) : null}

      <div className="kba-stage">
        <RadarRings left={coreLeft} top={coreTop} />
        <div className="kba-fx kba-sweepbox" aria-hidden="true" style={{ left: coreLeft, top: coreTop }}>
          <div className="kba-sweep"><span /></div>
        </div>

        {layout.columns.length > 0 ? (
          <div className="kba-fx" aria-hidden="true" style={{ inset: 0 }}>
            {layout.columns.map((column, index) => (
              <span key={column.label}>
                {index > 0 ? <span className="kba-phase-div" style={{ left: `${column.start}%` }} /> : null}
                <span className="kb-m kba-phase-label" style={{ left: `calc(${column.start}% + 10px)` }}>
                  {column.label}{column.overflow > 0 ? ` · +${column.overflow}` : ''}
                </span>
              </span>
            ))}
          </div>
        ) : null}

        <svg className="kba-fx kba-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {layout.links.map((link) => (
            <path key={`b-${link.agentId}`} className="kba-link-base" data-look={link.look} d={link.d} vectorEffect="non-scaling-stroke" />
          ))}
          {layout.links.map((link) => (
            <path key={`f-${link.agentId}`} className="kba-link-flow" data-look={link.look} d={link.d} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>

        <span className="kb-m kba-fx kba-cont" aria-hidden="true">
          КОНТ <b>{String(contacts).padStart(2, '0')}</b> · {clock}
        </span>

        <button
          type="button"
          className="kba-core"
          data-live={coreLive ? '' : undefined}
          aria-pressed={selectedAgentId === core.id}
          aria-label={`${core.name}${core.modelFamily ? `, ${core.modelFamily}` : ''} — ${agentStateLabel(core.state)}: ${agentActivity(core)}`}
          style={{ left: coreLeft, top: coreTop }}
          onClick={() => onSelect(core.id)}
        >
          <span className="kba-core-c">
            <svg className="kba-ring kba-core-orbit" width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
              <circle
                cx="38"
                cy="38"
                r="36"
                fill="none"
                stroke={coreLive ? 'rgba(255,106,43,0.55)' : 'rgba(255,236,210,0.16)'}
                strokeWidth="3"
                strokeDasharray="1 5.28"
              />
            </svg>
            {coreLook === 'tool' ? <span className="kba-ripple" aria-hidden="true" /> : null}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M12 3l9 9-9 9-9-9z" />
              <path d="M12 8.5v2M12 13.5v2M8.5 12h2M13.5 12h2" />
            </svg>
          </span>
          <span className="kba-core-l">
            <span className="kba-core-name">{core.name}</span>
            <span className="kba-core-act">{agentActivity(core)}</span>
            <span className="kba-core-meta">
              <ModelChip family={core.modelFamily} />
              <span className="kb-m" style={{ fontSize: 10.5, color: 'var(--kb-mute)' }}>
                {nodeMeta(core, receivedAt, now)}
              </span>
            </span>
          </span>
        </button>

        {layout.nodes.map((node) => {
          const { agent } = node;
          const activity = agentActivity(agent);
          return (
            <button
              key={agent.id}
              type="button"
              className="kba-node"
              data-look={node.look}
              aria-pressed={selectedAgentId === agent.id}
              aria-label={`${agent.name}${agent.modelFamily ? `, ${agent.modelFamily}` : ''} — ${agentStateLabel(agent.state)}: ${activity}`}
              style={{ left: `${node.x}%`, top: `${node.y}%`, width: node.width }}
              onClick={() => onSelect(agent.id)}
            >
              {node.look === 'wait' ? <span className="kba-node-stripe" aria-hidden="true" /> : null}
              <span className="kba-node-top">
                <span className={`kba-led kba-led-${node.look}`} aria-hidden="true" />
                <span className="kba-node-name">{agent.name}</span>
                <ModelChip family={agent.modelFamily} />
              </span>
              <span className="kba-node-act">{activity}</span>
              <span className="kb-m kba-node-meta">
                <span>{nodeMeta(agent, receivedAt, now)}</span>
                <span className="kba-st" data-look={node.look}>{agentStateLabel(agent.state)}</span>
              </span>
              {node.look === 'tool' ? (
                <span className="kba-toolline" aria-hidden="true"><span className="kba-scanbar" /></span>
              ) : null}
            </button>
          );
        })}

        {layout.hidden > 0 && layout.columns.length === 0 ? (
          <span className="kb-m kba-overflow">+{layout.hidden} {ruPlural(layout.hidden, 'агент', 'агента', 'агентов')} не поместились — список в чате</span>
        ) : null}
      </div>
    </article>
  );
}
