import { Button } from '@/modules/kabina';
import { formatDuration } from '@/modules/kabina-agents/utils/agentsView';
import type { WaitingPrompt } from '@/modules/kabina-agents/utils/agentsView';

type AgentsWaitStripProps = {
  prompt: WaitingPrompt;
  /** Other prompts waiting behind this one. */
  more: number;
  now: number;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onPick: () => void;
};

function phaseOf(prompt: WaitingPrompt): string | null {
  for (const workflow of prompt.session.workflows) {
    const phase = workflow.phases.find((candidate) => candidate.agentIds.includes(prompt.agent.id));
    if (phase) return `ФАЗА ${String(phase.index + 1).padStart(2, '0')}`;
  }
  return null;
}

/** DarkAgents «ЖДЁТ ТЕБЯ» band: who asks, the exact command, and the three answers. */
export default function AgentsWaitStrip({ prompt, more, now, busy, onApprove, onReject, onPick }: AgentsWaitStripProps) {
  const waitedMs = now - new Date(prompt.receivedAt).getTime();
  const isMain = prompt.agent.id === 'main';
  const context = [
    prompt.session.projectName.toUpperCase(),
    (prompt.session.workflows[0]?.name ?? prompt.session.sessionTitle).toUpperCase(),
    phaseOf(prompt),
  ].filter(Boolean).join(' · ');
  const who = isMain ? `Главный диалог «${prompt.agent.name}»` : `Агент «${prompt.agent.name}»`;

  return (
    <section className="kba-wait kb-rise kb-d1" aria-labelledby="kba-need-you">
      <div className="kba-wait-stripe" aria-hidden="true" />
      <div className="kba-wait-body">
        <div className="kba-wait-main">
          <div className="kba-wait-head">
            <span className="kba-led kba-led-wait" aria-hidden="true" />
            <h2 id="kba-need-you" className="kb-m kba-wait-title">
              ЖДЁТ ТЕБЯ <span>{formatDuration(waitedMs)}</span>
            </h2>
            <span className="kb-m kba-wait-ctx">
              {context} · на паузе только этот шаг{more > 0 ? ` · ещё ${more} в очереди` : ''}
            </span>
          </div>
          <p className="kba-wait-text">
            {who} просит разрешения на {prompt.toolName}
            {prompt.summary ? `: ${prompt.summary}` : ''}. Остальные агенты не ждут — работают дальше.
          </p>
          <div className="kb-m kba-cmd">
            <span>$</span>
            <span>{prompt.command}</span>
          </div>
        </div>
        <div className="kba-wait-actions">
          <Button variant="pri" onClick={onApprove} disabled={busy}>Разрешить один раз</Button>
          <Button variant="ghost" className="kba-reject" onClick={onReject} disabled={busy}>Отклонить</Button>
          <Button variant="ghost" onClick={onPick}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="12" cy="12" r="8" />
              <circle cx="12" cy="12" r="2" />
              <path d="M12 1v4M12 19v4M1 12h4M19 12h4" />
            </svg>
            К агенту
          </Button>
        </div>
      </div>
    </section>
  );
}
