import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';

import '@/modules/kabina/kabinaStates.css';
import { Button } from '@/modules/kabina/ui/Button';
import { WarnTriangleIcon } from '@/modules/kabina/ui/KabinaIcons';

/** What went wrong with the API call: an HTTP status (429, 500, 529…) or a dropped stream. */
type ClaudeErrorKind = number | 'stream';

/** Chip next to the title and the default explanation per kind (DarkStates E1). */
function describe(kind: ClaudeErrorKind): { chip: string; reason: string } {
  if (kind === 'stream') return { chip: 'поток оборвался', reason: 'Ответ Claude оборвался на середине — так бывает при сбоях сети между сервером и Anthropic.' };
  if (kind === 529) return { chip: 'API 529 · перегружен', reason: 'Серверы Anthropic сейчас перегружены — ты ни при чём.' };
  if (kind === 429) return { chip: 'API 429 · лимит запросов', reason: 'Anthropic просит притормозить: слишком много запросов подряд.' };
  if (kind >= 500) return { chip: `API ${kind} · сбой сервера`, reason: 'На стороне Anthropic случился сбой — ты ни при чём.' };
  return { chip: `API ${kind}`, reason: 'Anthropic вернул ошибку на запрос.' };
}

type ClaudeErrorCardProps = {
  /** HTTP status from the API, or `'stream'` for a dropped stream. */
  kind: ClaudeErrorKind;
  /** Heading; «Claude не ответил» by default. */
  title?: string;
  /** Overrides the default «why» sentence for the kind. */
  reason?: ReactNode;
  /** Step the turn is saved at («Ход сохранён на шаге 14»), when known. */
  savedStep?: number | null;
  /** When the next automatic retry fires (epoch ms); null — no auto retry left, only the button. */
  retryAt?: number | null;
  /** Pause between automatic retries; drives the progress bar. 20 s by default. */
  retryPauseMs?: number;
  /** Retry counter for «попытка 2 из 3». */
  attempt?: number;
  maxAttempts?: number;
  /** «Повторить сейчас»; omitted → no button (Claude Code is already retrying on its own). */
  onRetryNow?: () => void;
  /** Second action, e.g. «Сменить модель на Sonnet»; omitted → not drawn. */
  altAction?: { label: string; onClick: () => void };
  /** Raw log for «Подробности» (request id, status lines); omitted → no toggle. */
  details?: string;
};

/**
 * Used by the kabina-chat feed and the /states showcase: DarkStates E1 «Ошибка API» —
 * what happened in plain words, that nothing is lost, the countdown to the next
 * automatic retry and the raw response folded under «Подробности».
 */
export function ClaudeErrorCard({
  kind,
  title = 'Claude не ответил',
  reason,
  savedStep,
  retryAt = null,
  retryPauseMs = 20_000,
  attempt,
  maxAttempts,
  onRetryNow,
  altAction,
  details,
}: ClaudeErrorCardProps) {
  const { chip, reason: defaultReason } = describe(kind);
  const detailsId = useId();
  // Whether the raw response is unfolded.
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  // Ticks while a retry is scheduled so the countdown and bar move.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (retryAt === null) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  const msLeft = retryAt === null ? null : Math.max(0, retryAt - now);
  const secondsLeft = msLeft === null ? null : Math.ceil(msLeft / 1000);
  const share = msLeft === null ? 0 : Math.min(1, Math.max(0, 1 - msLeft / retryPauseMs));
  const saved = savedStep ? ` Ход сохранён на шаге ${savedStep}, ничего не потеряно.` : ' Ход сохранён, ничего не потеряно.';
  const attemptText = attempt && maxAttempts ? ` · попытка ${attempt} из ${maxAttempts}` : '';

  return (
    <div className="kb-errcard" role="alert">
      <div className="kb-errcard-head">
        <WarnTriangleIcon stroke="#D9A35B" />
        <span className="kb-errcard-title">{title}</span>
        <span className="kb-m kb-errcard-chip">{chip}</span>
      </div>
      <p className="kb-errcard-text">
        {reason ?? defaultReason}
        {saved}
        {secondsLeft === 0 ? (
          ` Повторяю${attemptText}…`
        ) : secondsLeft !== null ? (
          <>
            {' '}Повторю сам через <span className="kb-m kb-errcard-sec">{secondsLeft}&nbsp;с</span>{attemptText}.
          </>
        ) : (
          ' Автоповторы закончились — повтори кнопкой.'
        )}
      </p>
      {secondsLeft !== null && (
        <span className="kb-errcard-bar" aria-hidden="true">
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      )}
      <div className="kb-errcard-actions">
        {onRetryNow && <Button variant="pri" onClick={onRetryNow}>Повторить сейчас</Button>}
        {altAction && <Button variant="ghost" className="kb-soft-btn" onClick={altAction.onClick}>{altAction.label}</Button>}
        {details && (
          <button
            type="button"
            className="kb-lnk kb-textlink kb-errcard-toggle"
            aria-expanded={isDetailsOpen}
            aria-controls={detailsId}
            onClick={() => setIsDetailsOpen((open) => !open)}
          >
            {isDetailsOpen ? 'Скрыть подробности' : 'Подробности'}
          </button>
        )}
      </div>
      {details && isDetailsOpen && <pre id={detailsId} className="kb-m kb-fadein kb-errcard-log">{details}</pre>}
    </div>
  );
}
