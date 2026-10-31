import { StatusShape } from '@/modules/kabina/ui/StatusShape';
import type { KabinaStatusKind } from '@/shared/types';

/** One cell of the board: code line with its status shape, the big number and a caption. */
type BoardCell = {
  key: string;
  status: KabinaStatusKind;
  code: string;
  /** Count shown as two digits ("02"). */
  value: number;
  label: string;
  ariaLabel: string;
  /** The orange "ждёт тебя" cell. */
  highlight?: boolean;
  onSelect?: () => void;
};

type BoardProps = {
  cells: BoardCell[];
  /** Phone board (100px cells, 36px digits). */
  compact?: boolean;
  /** Dims the digits while the first numbers load. */
  loading?: boolean;
  ariaLabel?: string;
};

/** Used by the home summary: the 01/02/03 digit board — РАБОТАЮТ / ЖДЁТ ТЕБЯ / СОБЫТИЯ. */
export function Board({ cells, compact = false, loading = false, ariaLabel }: BoardProps) {
  return (
    <div
      className="kb-board"
      role="list"
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      data-compact={compact ? '' : undefined}
      style={{ ['--kb-board-cols' as string]: cells.length }}
    >
      {cells.map((cell) => (
        <button
          key={cell.key}
          type="button"
          role="listitem"
          className="kb-board-cell kb-cell"
          data-tone={cell.highlight ? 'wait' : undefined}
          aria-label={cell.ariaLabel}
          onClick={cell.onSelect}
        >
          <span className="kb-board-code">
            <StatusShape kind={cell.status} />
            <span className="kb-m">{cell.code}</span>
          </span>
          <span className="kb-t kb-board-n" style={loading ? { opacity: 0.35 } : undefined}>
            {String(Math.max(0, cell.value)).padStart(2, '0')}
          </span>
          <span className="kb-board-label">{cell.label}</span>
        </button>
      ))}
    </div>
  );
}
