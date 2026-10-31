import '@/modules/kabina/kabinaStates.css';
import { Button } from '@/modules/kabina/ui/Button';
import { StatusShape } from '@/modules/kabina/ui/StatusShape';

const MB = 1024 * 1024;
/** DarkStates L4: the scale runs to 400 МБ in 20 cells, the threshold mark sits at 250 МБ. */
const SCALE_CELLS = 20;

type BigSessionNoticeProps = {
  /** Size of the session's transcript (jsonl) in bytes. */
  sizeBytes: number;
  /** Where the warning starts; the white mark on the scale. 250 МБ by default. */
  thresholdBytes?: number;
  /** Right end of the scale; «Остаться» hides the notice until this size. 400 МБ by default. */
  scaleMaxBytes?: number;
  /** Dialog title for «Диалог «…» разросся». */
  sessionTitle?: string | null;
  /** How long the feed took to load, when measured («лента грузится 9 с»). */
  loadSeconds?: number | null;
  /** How many files the summary will list, when known («и 12 файлов»). */
  filesCount?: number | null;
  /** What the user chose; null shows the two buttons. */
  outcome?: 'new' | 'stay' | null;
  /** «Новый с выжимкой» — start a new dialog seeded with a summary of this one. */
  onNewWithSummary: () => void;
  /** «Остаться здесь» — hide until `scaleMaxBytes`. */
  onStay: () => void;
  /** «вернуть» next to the outcome line; omitted → no link. */
  onUndo?: () => void;
};

function megabytes(bytes: number): number {
  return Math.round(bytes / MB);
}

/**
 * Used by the chat (above the composer) and the /states showcase: DarkStates L4
 * «Большая сессия» — the transcript size in МБ on a 20-cell scale with the
 * threshold mark, and the offer to start a new dialog with a summary.
 */
export function BigSessionNotice({
  sizeBytes,
  thresholdBytes = 250 * MB,
  scaleMaxBytes = 400 * MB,
  sessionTitle,
  loadSeconds,
  filesCount,
  outcome = null,
  onNewWithSummary,
  onStay,
  onUndo,
}: BigSessionNoticeProps) {
  const sizeMb = megabytes(sizeBytes);
  const thresholdMb = megabytes(thresholdBytes);
  const maxMb = megabytes(scaleMaxBytes);
  const cellMb = maxMb / SCALE_CELLS;
  const thresholdShare = Math.min(1, thresholdMb / maxMb);
  const cells = Array.from({ length: SCALE_CELLS }, (_, index) => {
    const upTo = (index + 1) * cellMb;
    if (upTo > sizeMb) return 'empty';
    return upTo > thresholdMb ? 'over' : 'under';
  });
  const files = filesCount ? ` и ${filesCount} файлов, с которыми работали` : '';

  return (
    <div className="kb-bigsession" role="alert">
      <div className="kb-bigsession-tagrow">
        <StatusShape kind="warn" />
        <span className="kb-m kb-bigsession-tag">БОЛЬШАЯ СЕССИЯ</span>
      </div>
      <div className="kb-bigsession-size">
        <span className="kb-t kb-bigsession-num">{sizeMb}</span>
        <span className="kb-m kb-bigsession-unit">МБ{loadSeconds ? ` · лента грузится ${Math.round(loadSeconds)} с` : ''}</span>
      </div>
      <div className="kb-bigsession-scale" aria-hidden="true">
        <div className="kb-bigsession-cells">
          {cells.map((state, index) => <span key={index} data-state={state} />)}
          <span className="kb-bigsession-mark" style={{ left: `${(thresholdShare * 100).toFixed(1)}%` }} />
        </div>
        <div className="kb-m kb-bigsession-legend">
          <span>0</span>
          <span style={{ paddingLeft: `${Math.max(0, thresholdShare * 100 - 32).toFixed(0)}%` }}>порог {thresholdMb}</span>
          <span>{maxMb} МБ</span>
        </div>
      </div>
      <p className="kb-bigsession-text">
        {sessionTitle ? `Диалог «${sessionTitle}» разросся` : 'Диалог разросся'} — автосжатие уже не спасает. Начни новый: Claude соберёт
        выжимку — цель, решения, открытые задачи{files}.
      </p>
      {outcome === null ? (
        <div className="kb-bigsession-actions">
          <Button variant="pri" onClick={onNewWithSummary}>Новый с выжимкой</Button>
          <Button variant="ghost" className="kb-soft-btn" onClick={onStay}>Остаться здесь</Button>
        </div>
      ) : (
        <div role="status" className="kb-m kb-fadein kb-bigsession-outcome" data-outcome={outcome}>
          <StatusShape kind={outcome === 'new' ? 'ok' : 'idle'} />
          <span className="kb-bigsession-outcome-text">
            {outcome === 'new' ? 'новый диалог открыт · выжимка вместо всей ленты' : `остаёмся · напомню на ${maxMb} МБ`}
          </span>
          {onUndo && <button type="button" className="kb-lnk kb-textlink" onClick={onUndo}>вернуть</button>}
        </div>
      )}
    </div>
  );
}
