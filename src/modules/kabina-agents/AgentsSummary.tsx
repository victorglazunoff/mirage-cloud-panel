import { HoldButton } from '@/modules/kabina';
import { ruPlural, tokensPerHourParts } from '@/modules/kabina-agents/utils/agentsView';
import type { AgentCounts } from '@/modules/kabina-agents/utils/agentsView';
import type { LiveAgentsStats } from '@/shared/types';

type AgentsSummaryProps = {
  eyebrow: string;
  lead: string;
  /** Working / waiting / error counts of the sessions on screen — the same numbers as the eyebrow and lead. */
  counts: AgentCounts;
  /** Server-side «за час» figures (done and tokens); null until the first snapshot. */
  stats: LiveAgentsStats | null;
  /** «Сайт клиента · выкладка» under ЖДЁТ ТЕБЯ. */
  waitingLabel: string | null;
  /** Short reason under ОШИБКА («WebFetch · 403»). */
  errorLabel: string | null;
  /** Agents «Остановить всё» would reach; the button is off at zero. */
  stoppableCount: number;
  /** An action is on its way: the button waits. */
  busy?: boolean;
  onStopAll: () => void;
};

function pad2(value: number): string {
  return String(Math.max(0, value)).padStart(2, '0');
}

/** DarkAgents header: eyebrow, «Агенты в эфире», the lead, «Остановить всё» held, and the five counters. */
export default function AgentsSummary({ eyebrow, lead, counts, stats, waitingLabel, errorLabel, stoppableCount, busy = false, onStopAll }: AgentsSummaryProps) {
  const { working, waiting, errors, projects } = counts;
  const done = stats?.doneLastHour ?? 0;
  const tokens = tokensPerHourParts(stats?.tokensLastHour ?? 0);
  const loading = stats === null;

  const cells = [
    {
      key: 'working', led: working ? 'kba-led kba-led-tool' : 'kba-led kba-led-off', code: 'РАБОТАЮТ', n: pad2(working), unit: '', tone: undefined,
      label: working
        // No-break spaces: a folded caption reads «агент / в 1 проекте», not «агент в / 1 проекте».
        ? `${ruPlural(working, 'агент', 'агента', 'агентов')} в\u00a0${projects}\u00a0${ruPlural(projects, 'проекте', 'проектах', 'проектах')}`
        : 'никто не работает',
      aria: `${working} ${ruPlural(working, 'работает', 'работают', 'работают')}`,
    },
    {
      key: 'waiting', led: waiting ? 'kba-led kba-led-wait' : 'kba-led kba-led-off', code: 'ЖДЁТ ТЕБЯ', n: pad2(waiting), unit: '',
      tone: waiting ? 'wait' : undefined, label: waiting ? waitingLabel ?? 'ждут разрешения' : 'никто не ждёт',
      title: waiting && waitingLabel ? waitingLabel : undefined,
      aria: `${waiting} ждёт тебя`,
    },
    {
      key: 'done', led: 'kba-led kba-led-done', code: 'ГОТОВО', n: pad2(done), unit: '', tone: undefined,
      label: 'за этот час', aria: `${done} готово за час`,
    },
    {
      key: 'errors', led: 'kba-led kba-led-error', code: 'ОШИБКА', n: pad2(errors), unit: '', tone: errors ? 'error' : undefined,
      label: errors ? errorLabel ?? 'смотри агента' : 'без ошибок', title: errors && errorLabel ? errorLabel : undefined, aria: `${errors} ${ruPlural(errors, 'ошибка', 'ошибки', 'ошибок')}`,
    },
    {
      key: 'tokens', led: '', code: 'ТОКЕНЫ / ЧАС', n: tokens.n, unit: tokens.unit, tone: undefined,
      label: 'за последний\u00a0час', aria: `токенов за час: ${stats?.tokensLastHour ?? 0}`,
    },
  ];

  return (
    <section className="kba-summary kb-rise" aria-label="Сводка по агентам">
      <div className="kba-summary-text">
        <span className="kb-m kba-eyebrow">{eyebrow}</span>
        <h1 className="kb-t kba-title">Агенты в эфире</h1>
        <p className="kba-lead">{lead}</p>
        <div className="kba-stopall">
          <HoldButton
            label="Остановить всё"
            ariaLabel="Остановить всех агентов — удерживай полторы секунды"
            onConfirm={onStopAll}
            disabled={busy || stoppableCount === 0}
          />
          <span className="kb-m kba-note">
            {stoppableCount === 0 && working > 0
              ? 'останавливать некого — работают только главные диалоги'
              : 'главные диалоги не трогает — только агентов'}
          </span>
        </div>
      </div>
      <div className="kba-stats" role="list" aria-busy={loading || undefined}>
        {cells.map((cell) => (
          <div key={cell.key} role="listitem" className="kba-stat" data-tone={cell.tone} aria-label={cell.aria}>
            <span className="kba-stat-code">
              {cell.led ? <span className={cell.led} aria-hidden="true" /> : null}
              <span className="kb-m">{cell.code}</span>
            </span>
            <span className="kb-t kba-stat-n" style={loading ? { opacity: 0.35 } : undefined}>
              {cell.n}
              {cell.unit ? <span className="kb-m kba-stat-unit">{cell.unit}</span> : null}
            </span>
            <span className="kba-stat-label" title={'title' in cell ? cell.title : undefined}>{cell.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
