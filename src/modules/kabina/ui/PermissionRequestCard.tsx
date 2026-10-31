import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import '@/modules/kabina/kabinaStates.css';
import { Button } from '@/modules/kabina/ui/Button';
import { toPanelWall } from '@/modules/kabina/ui/panelTime';
import { StatusShape } from '@/modules/kabina/ui/StatusShape';
import { computeLineDiff } from '@/modules/kabina/utils/permissionDiff';
import type { PermissionDiffInput } from '@/shared/types';

/** DarkStates P2: a long diff folds to 12 lines, the rest opens on click. */
const DIFF_FOLD_LINES = 12;

/** The answer to a permission request. */
type PermissionDecision = 'once' | 'session' | 'deny';

const SIGN = { context: ' ', add: '+', del: '−' } as const;

function waitingLabel(sinceMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (seconds < 60) return `ждёт ${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `ждёт ${minutes} мин`;
  return `ждёт ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function linesWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'строка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'строки';
  return 'строк';
}

function clock(instant: Date): string {
  const date = toPanelWall(instant);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

type PermissionRequestCardProps = {
  /** Tool name for the chip: `Bash`, `Edit`, `Write`, `MultiEdit`… */
  toolName: string;
  /** Why Claude stopped (classifier reason or Claude's own words). */
  reason?: ReactNode;
  /**
   * When the request arrived (epoch ms, Date, or the ISO string a re-subscribe
   * brings); drives «ждёт 2 мин». Omitted or unreadable → no timer chip.
   */
  waitingSince?: number | Date | string | null;
  /** Bash: the command shown after `$`. */
  command?: string;
  /** Bash: a muted comment after the command («# 40 цен, 3 посёлка»). */
  commandNote?: string;
  /** Write / Edit: the file change, drawn as a numbered old/new line diff (see `permissionDiffFromToolInput`). */
  diff?: PermissionDiffInput | null;
  /** «Разрешить один раз». */
  onAllowOnce: () => void;
  /** «В этой сессии» (or `sessionLabel`) — allow this kind of action for the rest of the session; omitted → not drawn. */
  onAllowSession?: () => void;
  /** Label of the session-wide button; DarkStates: «В этой сессии». */
  sessionLabel?: string;
  /** What «В этой сессии» will allow, for the result line («deploy.sh», «правки в src/lib»). */
  sessionScope?: string;
  /** «Отклонить». */
  onDeny: () => void;
  /**
   * Controlled answer. `undefined` — the card keeps its own answer after a
   * click and shows the result line; `null` — always shows the question.
   */
  decision?: PermissionDecision | null;
  /** «показать запрос снова» under the result line (the showcase); omitted → no link. */
  onShowAgain?: () => void;
  /**
   * Keyboard answers while the card is open: 1 — once, 2 — session, 3 — deny
   * (digits only, so Enter/Esc keep their usual meaning on focused controls). Off by default (DarkStates draws no hotkeys); turn on only
   * where a single card owns the screen and focus is not in a text field.
   */
  hotkeys?: boolean;
  /** Said after the wait time in the head; DarkChat: «· на паузе только этот шаг». */
  waitNote?: string;
  /**
   * `states` — DarkStates P1/P2 (the default); `chat` — the larger DarkChat plate;
   * `phone` — DarkPhoneChat: «Разрешить один раз» full width, the other two below it.
   */
  variant?: 'states' | 'chat' | 'phone';
};

/**
 * Used by the kabina-chat feed (every tool request but plans and questions) and the /states showcase:
 * DarkStates 03 «Запрос разрешения» — the orange-striped «НУЖНО ТВОЁ РЕШЕНИЕ»
 * plate with the tool, the wait time, the reason, a Bash command or a numbered
 * file diff (+/− with colour, folded past 12 lines), and «Разрешить один раз» /
 * «В этой сессии» / «Отклонить». After an answer it collapses to a result line.
 */
export function PermissionRequestCard({
  toolName,
  reason,
  waitingSince = null,
  command,
  commandNote,
  diff = null,
  onAllowOnce,
  onAllowSession,
  sessionLabel = 'В этой сессии',
  sessionScope,
  onDeny,
  decision,
  onShowAgain,
  hotkeys = false,
  waitNote,
  variant = 'states',
}: PermissionRequestCardProps) {
  // The answer given on this card when the parent does not control it, with its time for the result line.
  const [ownDecision, setOwnDecision] = useState<{ value: PermissionDecision; at: Date } | null>(null);
  // Whether the folded part of a long diff is shown.
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  // Ticks every second for «ждёт N с».
  const [now, setNow] = useState(() => Date.now());

  // A request replayed by `chat.subscribe` carries its time as a string over JSON;
  // read as is it made «ждёт NaN ч NaN мин».
  const sinceRaw = waitingSince === null ? NaN : new Date(waitingSince).getTime();
  const sinceMs = Number.isFinite(sinceRaw) ? sinceRaw : null;
  const effective = decision === undefined ? ownDecision?.value ?? null : decision;
  const isOpen = effective === null;

  useEffect(() => {
    if (sinceMs === null || !isOpen) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isOpen, sinceMs]);

  const diffRows = useMemo(() => (diff ? computeLineDiff(diff) : []), [diff]);
  const added = diffRows.filter((row) => row.kind === 'add').length;
  const removed = diffRows.filter((row) => row.kind === 'del').length;
  const shownRows = isDiffOpen ? diffRows : diffRows.slice(0, DIFF_FOLD_LINES);
  const hiddenCount = diffRows.length - shownRows.length;

  const answer = (value: PermissionDecision) => {
    if (decision === undefined) setOwnDecision({ value, at: new Date() });
    if (value === 'once') onAllowOnce();
    else if (value === 'session') onAllowSession?.();
    else onDeny();
  };
  const answerRef = useRef(answer);
  answerRef.current = answer;

  useEffect(() => {
    if (!hotkeys || !isOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '1') answerRef.current('once');
      else if (event.key === '2' && onAllowSession) answerRef.current('session');
      else if (event.key === '3') answerRef.current('deny');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, isOpen, onAllowSession]);

  if (!isOpen) {
    const at = ownDecision?.at ?? new Date();
    const isDenied = effective === 'deny';
    const scope = sessionScope ?? (command ? command.split(/\s+/)[0] : diff ? `правки в ${diff.filePath}` : toolName);
    const text = effective === 'once'
      ? `Разрешено один раз · ${clock(at)} · шаг продолжается`
      : effective === 'session'
        ? `Разрешено до конца сессии: ${scope} · больше не спрошу`
        : 'Отклонено · Claude получил отказ и ищет другой путь';
    return (
      <div className="kb-perm-done kb-fadein">
        <div role="status" className="kb-m kb-perm-result" data-denied={isDenied ? '' : undefined}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d={isDenied ? 'M6 6l12 12M18 6L6 18' : 'M5 12l5 5 9-10'} />
          </svg>
          <span className="kb-pretty">{text}</span>
        </div>
        {onShowAgain && (
          <button
            type="button"
            className="kb-lnk kb-textlink kb-perm-again"
            onClick={() => {
              setOwnDecision(null);
              onShowAgain();
            }}
          >
            показать запрос снова
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="kb-perm kb-fadein" data-variant={variant === 'states' ? undefined : variant} aria-label={`Запрос разрешения: ${diff ? 'правка файла' : toolName}`}>
      <span className="kb-perm-stripe" aria-hidden="true" />
      <div className="kb-perm-body">
        <div className="kb-perm-head">
          <StatusShape kind="wait" />
          <span className="kb-m kb-perm-eyebrow">НУЖНО ТВОЁ РЕШЕНИЕ</span>
          <span className="kb-m kb-perm-tool">{toolName}</span>
          {variant === 'phone' && <span className="kb-perm-push" aria-hidden="true" />}
          {sinceMs !== null && (
            <span className="kb-m kb-perm-wait">
              {variant === 'phone' ? waitingLabel(sinceMs, now).replace(/^ждёт /, '') : waitingLabel(sinceMs, now)}
              {waitNote && variant !== 'phone' ? ` ${waitNote}` : ''}
            </span>
          )}
        </div>
        {reason && <p className="kb-perm-reason">{reason}</p>}
        {command && (
          <div className="kb-m kb-perm-command">
            <span className="kb-perm-prompt" aria-hidden="true">$</span>
            <span className="kb-perm-cmdtext">
              {command}
              {commandNote && <span className="kb-perm-cmdnote"> # {commandNote}</span>}
            </span>
          </div>
        )}
        {diff && (
          <div className="kb-m kb-perm-diff">
            <div className="kb-perm-diffhead">
              <span className="kb-perm-file" title={diff.filePath}>{diff.filePath}</span>
              <span className="kb-perm-plus">+{added}</span>
              <span className="kb-perm-minus">−{removed}</span>
            </div>
            <div className="kb-perm-lines" role="table" aria-label={`Изменения в ${diff.filePath}`}>
              {shownRows.map((row, index) => (
                <div key={index} className="kb-perm-line" data-kind={row.kind} role="row">
                  <span className="kb-perm-n" role="cell">{row.number}</span>
                  <span className="kb-perm-sign" role="cell" aria-label={row.kind === 'add' ? 'добавлено' : row.kind === 'del' ? 'удалено' : undefined}>
                    {SIGN[row.kind]}
                  </span>
                  <span className="kb-perm-code" role="cell">{row.text}</span>
                </div>
              ))}
              {diffRows.length === 0 && <div className="kb-perm-line kb-perm-emptydiff">файл без изменений</div>}
            </div>
            {diffRows.length > DIFF_FOLD_LINES && (
              <button type="button" className="kb-perm-fold kb-lnk" aria-expanded={isDiffOpen} onClick={() => setIsDiffOpen((open) => !open)}>
                {isDiffOpen ? 'свернуть' : `ещё ${hiddenCount} ${linesWord(hiddenCount)}`}
              </button>
            )}
          </div>
        )}
        {variant === 'phone' ? (
          <div className="kb-perm-actions" data-stacked="">
            <Button variant="pri" className="kb-perm-btn" onClick={() => answer('once')}>Разрешить один раз</Button>
            <div className="kb-perm-actions-row">
              {onAllowSession && (
                <Button variant="out" className="kb-perm-btn" onClick={() => answer('session')}>{sessionLabel}</Button>
              )}
              <Button variant="ghost" className="kb-perm-btn kb-soft-btn" onClick={() => answer('deny')}>Отклонить</Button>
            </div>
          </div>
        ) : (
          <div className="kb-perm-actions">
            <Button variant="pri" className="kb-perm-btn" onClick={() => answer('once')}>Разрешить один раз</Button>
            {onAllowSession && (
              <Button variant="out" className="kb-perm-btn" onClick={() => answer('session')}>{sessionLabel}</Button>
            )}
            <Button variant="ghost" className="kb-perm-btn kb-soft-btn" onClick={() => answer('deny')}>Отклонить</Button>
          </div>
        )}
      </div>
    </section>
  );
}
