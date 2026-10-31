import { ArrowRightIcon, Button, CheckIcon, StatusShape } from '@/modules/kabina';
import { formatClock, formatElapsed, plural } from '@/modules/home/utils/homeFormatting';
import type { HomeActivityItem } from '@/shared/types';

type HomeWaitingCardProps = {
  waiting: HomeActivityItem[];
  /** The prompt just allowed here; the card turns into the «разрешено один раз» row. */
  allowed: { sessionId: string; projectId: string | null; projectName: string; at: Date } | null;
  allowError: string | null;
  now: Date;
  onAllowOnce: (item: HomeActivityItem) => void;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
};

/**
 * Phone only (DarkPhoneMain): the first prompt waiting for the user, lifted
 * above everything — «Разрешить 1 раз» answers it on the spot through the
 * chat socket (`chat.permission-response`), «Ответить» opens the dialog.
 */
export default function HomeWaitingCard({ waiting, allowed, allowError, now, onAllowOnce, onOpenSession }: HomeWaitingCardProps) {
  const first = waiting[0];

  if (!first && allowed) {
    return (
      <button
        type="button"
        className="mh-allowed kb-row kb-bz kb-fadein"
        onClick={() => onOpenSession(allowed.sessionId, allowed.projectId)}
      >
        <CheckIcon size={18} stroke="#9CC49A" style={{ flex: 'none' }} />
        <span className="mh-allowed-text">
          <span className="mh-allowed-title">{allowed.projectName} · разрешено один раз</span>
          <span className="kb-m mh-allowed-sub">{formatClock(allowed.at)} · ход идёт дальше</span>
        </span>
        <span className="mh-allowed-open">Открыть</span>
        <ArrowRightIcon size={14} stroke="#B3AA9B" />
      </button>
    );
  }
  if (!first) return null;

  const since = first.permission ? Date.parse(first.permission.receivedAt) : first.startedAt;
  const more = waiting.length - 1;
  const tool = first.permission?.toolName ?? 'инструмент';

  return (
    <section className="mh-wait-card kb-rise kb-d1" aria-labelledby="mh-h-wait">
      <div className="mh-wait-stripe" aria-hidden="true" />
      <div className="mh-wait-body">
        <div className="mh-wait-head">
          <StatusShape kind="wait" />
          <h2 id="mh-h-wait" className="kb-m mh-wait-title">ЖДЁТ ТЕБЯ</h2>
          <div className="kb-spacer" />
          <span className="kb-m mh-wait-meta">
            {formatElapsed(since, now.getTime())}
            {more > 0 ? ` · ещё ${more} ${plural(more, ['диалог', 'диалога', 'диалогов'])}` : ''}
          </span>
        </div>
        <div className="mh-wait-who">
          <div className="kb-t mh-wait-mono" aria-hidden="true">{first.projectName.slice(0, 1).toUpperCase()}</div>
          <div className="mh-wait-names">
            <span className="mh-wait-proj">{first.projectName}</span>
            <span className="mh-wait-session">{first.sessionTitle}</span>
          </div>
        </div>
        <p className="mh-wait-text kb-pretty">
          Claude поставил шаг на паузу и просит разрешить {tool}. Остальная работа идёт дальше.
        </p>
        {first.permission?.summary && (
          <div className="kb-m mh-wait-cmd">
            <span className="mh-wait-prompt">$</span>
            <span className="mh-wait-cmd-text">{first.permission.summary}</span>
          </div>
        )}
        {allowError && <p className="mh-wait-error" role="alert">{allowError}</p>}
        <div className="mh-wait-actions">
          <Button
            variant="out"
            size="lg"
            aria-label={`Разрешить ${tool} один раз`}
            onClick={() => onAllowOnce(first)}
          >
            Разрешить 1 раз
          </Button>
          <Button variant="pri" size="lg" onClick={() => onOpenSession(first.sessionId, first.projectId)}>
            <span>Ответить</span>
            <ArrowRightIcon strokeWidth={2} />
          </Button>
        </div>
      </div>
    </section>
  );
}
