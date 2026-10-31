import type { ReactNode } from 'react';

import '@/modules/kabina/kabinaStates.css';
import { Button } from '@/modules/kabina/ui/Button';
import { toPanelWall, usePanelTimeZone } from '@/modules/kabina/ui/panelTime';
import { StatusShape } from '@/modules/kabina/ui/StatusShape';

type TurnStoppedMarkProps = {
  /** When the turn was stopped; null leaves the time out. */
  at: Date | null;
  /** Step number the turn stopped at, when known («ШАГ 22»). */
  step?: number | null;
  /** What survived and what was cut («Правки до шага 22 сохранены — 3 файла…»). */
  summary?: ReactNode;
  /** «Продолжить с шага N»; omitted → not drawn. */
  onResume?: () => void;
  /** «Откатить правки хода»; omitted → not drawn. */
  onRollback?: () => void;
  /** After «Продолжить»: shows «продолжаю с шага N · ход идёт» instead of the buttons. */
  resumed?: boolean;
  /** «вернуть» on the resumed line; omitted → no link. */
  onUndoResume?: () => void;
};

function clock(instant: Date): string {
  const date = toPanelWall(instant);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Used by the kabina-chat feed (the one «■ остановлено» mark) and the /states showcase: DarkStates C2 —
 * the permanent «■ ОСТАНОВЛЕНО · 14:31 · ШАГ 22» separator after a hold-to-stop,
 * what was kept, and the resume / roll back actions.
 */
export function TurnStoppedMark({ at, step, summary, onResume, onRollback, resumed = false, onUndoResume }: TurnStoppedMarkProps) {
  usePanelTimeZone();
  const stepLabel = step ? ` · ШАГ ${step}` : '';
  return (
    <div className="kb-stopped">
      <div role="separator" aria-label="Ход остановлен" className="kb-stopmark">
        <i aria-hidden="true" />
        <span className="kb-m">ОСТАНОВЛЕНО{at ? ` · ${clock(at)}` : ''}{stepLabel}</span>
        <i aria-hidden="true" />
      </div>
      {summary && <p className="kb-stopped-text">{summary}</p>}
      {!resumed && (onResume || onRollback) && (
        <div className="kb-stopped-actions">
          {onResume && <Button variant="ghost" onClick={onResume}>{step ? `Продолжить с шага ${step}` : 'Продолжить'}</Button>}
          {onRollback && <Button variant="ghost" className="kb-soft-btn" onClick={onRollback}>Откатить правки хода</Button>}
        </div>
      )}
      {resumed && (
        <div role="status" className="kb-m kb-fadein kb-stopped-resumed">
          <StatusShape kind="run" />
          <span>{step ? `продолжаю с шага ${step} · ход идёт` : 'продолжаю · ход идёт'}</span>
          {onUndoResume && <button type="button" className="kb-lnk kb-textlink" onClick={onUndoResume}>вернуть</button>}
        </div>
      )}
    </div>
  );
}
