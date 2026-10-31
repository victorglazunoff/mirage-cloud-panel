import { formatClock } from '@/modules/kabina-agents/utils/agentsView';
import type { LiveAgentsFeedEvent } from '@/shared/types';

type AgentsFeedProps = {
  events: LiveAgentsFeedEvent[];
  live: boolean;
  now: number;
  onPick: (sessionId: string, agentId: string) => void;
};

const FEED_ROWS = 8;

const MARK_BY_KIND: Record<LiveAgentsFeedEvent['kind'], string> = {
  tool: 'kba-mk kba-mk-tool',
  resolved: 'kba-mk kba-mk-tool',
  start: 'kba-mk kba-mk-think',
  turn: 'kba-mk kba-mk-think',
  waiting: 'kba-mk kba-mk-wait',
  done: 'kba-led kba-led-done',
  error: 'kba-led kba-led-error',
  stopped: 'kba-led kba-led-off',
};

function sinceLabel(ms: number): string {
  if (ms < 5_000) return 'сейчас';
  if (ms < 60_000) return `${Math.floor(ms / 1000)} с назад`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} мин назад`;
  return `${Math.floor(ms / 3_600_000)} ч назад`;
}

/** Used by the «Агенты» screen: «03 / ЛЕНТА» — the newest agent events of every project, new rows slide in. */
export default function AgentsFeed({ events, live, now, onPick }: AgentsFeedProps) {
  const rows = events.slice(0, FEED_ROWS);
  const last = rows[0] ? now - new Date(rows[0].at).getTime() : null;

  return (
    <section className="kb-rise kb-d4" aria-labelledby="kba-h-feed" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="kba-feed-head">
        <span className="kb-m kb-ruler-n" aria-hidden="true">03</span>
        <h2 id="kba-h-feed" className="kb-m kb-ruler-title">ЛЕНТА</h2>
        <span className="kba-feed-scale" aria-hidden="true" />
        <span className="kb-m kba-feed-live">
          <span className={live ? 'kba-led kba-led-tool' : 'kba-led kba-led-off'} aria-hidden="true" />
          {live ? `в эфире${last !== null ? ` · ${sinceLabel(last)}` : ''}` : 'нет потока · обновлю сам'}
        </span>
      </div>
      <ol className="kba-feed" aria-label="События агентов" aria-live="polite">
        {rows.length === 0 ? <li className="kba-feed-empty">Событий за последний час нет.</li> : null}
        {rows.map((event) => (
          <li key={event.id} data-fresh="">
            <span className="kb-m kba-feed-t">{formatClock(event.at, true)}</span>
            <span className="kba-feed-mk"><span className={MARK_BY_KIND[event.kind]} aria-hidden="true" /></span>
            <button
              type="button"
              className="kba-feed-body"
              style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }}
              onClick={() => onPick(event.sessionId, event.agentId)}
            >
              <span className="kb-m kba-feed-p">{event.projectName.toUpperCase()}</span>
              <span className="kba-feed-line">
                <span className="kba-feed-a">{event.agentName}</span>
                <span className="kba-feed-x" data-kind={event.kind}>{'\u00a0— '}{event.text}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
