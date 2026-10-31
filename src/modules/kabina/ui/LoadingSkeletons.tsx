import type { CSSProperties } from 'react';

import '@/modules/kabina/kabinaStates.css';
import { Skeleton, useDelayedFlag } from '@/modules/kabina/ui/Skeleton';

/** DarkStates S2: widths of the two bars per row, cycled so rows do not look stamped. */
const ROW_WIDTHS: Array<[string, string]> = [
  ['62%', '38%'],
  ['48%', '30%'],
  ['70%', '44%'],
  ['55%', '26%'],
  ['66%', '40%'],
  ['44%', '34%'],
];

type FeedSkeletonProps = {
  /** Messages loaded so far, for «гружу диалог · 84 из 212 сообщений». */
  loaded?: number | null;
  total?: number | null;
  /** Past 5 s of loading: the caption says the session is big (DarkStates S1 → L4). */
  slow?: boolean;
  /** Wait before anything shows, so fast loads never flash. 200 ms by default; 0 shows at once. */
  delayMs?: number;
};

/**
 * Used by the chat feed while the history is on its way, and the /states
 * showcase: DarkStates S1 — a message plate, two Claude replies and the
 * orange scan bar with the progress caption. Nothing for the first 200 ms.
 */
export function FeedSkeleton({ loaded = null, total = null, slow = false, delayMs = 200 }: FeedSkeletonProps) {
  const isVisible = useDelayedFlag(true, delayMs) || delayMs <= 0;
  if (!isVisible) return null;
  const progress = loaded !== null && total ? ` · ${loaded} из ${total} сообщений` : '';
  const caption = slow ? `сессия большая — гружу дольше обычного${progress}` : `гружу диалог${progress}`;
  return (
    <div className="kb-skfeed" role="status" aria-label="Лента загружается">
      <div className="kb-skfeed-user">
        <Skeleton width={72} height={8} />
        <Skeleton width="92%" />
        <Skeleton width="58%" />
      </div>
      <div className="kb-skfeed-reply">
        <span className="kb-skfeed-who"><Skeleton width={13} height={13} radius="50%" /><Skeleton width={96} height={8} /></span>
        <Skeleton width="86%" />
        <Skeleton width="94%" />
        <Skeleton width="40%" />
        <Skeleton width={280} height={36} radius={5} style={{ maxWidth: '100%' }} />
      </div>
      <div className="kb-skfeed-reply">
        <span className="kb-skfeed-who"><Skeleton width={13} height={13} radius="50%" /><Skeleton width={96} height={8} /></span>
        <Skeleton width="76%" />
        <Skeleton width="52%" />
      </div>
      <div className="kb-m kb-skfeed-caption">
        <span className="kb-skfeed-scan" aria-hidden="true"><span className="kb-scan" /></span>
        <span>{caption}</span>
      </div>
    </div>
  );
}

type ListSkeletonProps = {
  /** How many rows; pass how many there were last time so the height does not jump. 6 by default. */
  rows?: number;
  /** Mono caption above the rows («ДИАЛОГИ»); omitted → no header. */
  title?: string;
  /** Accessible name of the loading region. */
  label?: string;
  /** Wait before anything shows. 200 ms by default; 0 shows at once. */
  delayMs?: number;
};

/**
 * Used by the home screen, the project list and the /states showcase (later
 * agents and dialogs): DarkStates S2 — 52px rows with a dot, two bars and a
 * short time bar, shimmering in a slight stagger. Nothing for the first 200 ms.
 */
export function ListSkeleton({ rows = 6, title, label = 'Список загружается', delayMs = 200 }: ListSkeletonProps) {
  const isVisible = useDelayedFlag(true, delayMs) || delayMs <= 0;
  if (!isVisible) return null;
  return (
    <div className="kb-sklist" role="status" aria-label={label}>
      {title && (
        <div className="kb-sklist-head">
          <span className="kb-m kb-sklist-title">{title}</span>
          <span className="kb-sklist-scale" aria-hidden="true" />
        </div>
      )}
      <div className="kb-sklist-rows">
        {Array.from({ length: rows }, (_, index) => {
          const [first, second] = ROW_WIDTHS[index % ROW_WIDTHS.length];
          const shimmerDelay = { '--kb-sk-delay': `${(index * 0.08).toFixed(2)}s` } as CSSProperties;
          return (
            <div key={index} className="kb-sklist-row">
              <Skeleton width={8} height={8} radius="50%" className="kb-sk-staggered" style={shimmerDelay} />
              <span className="kb-sklist-bars">
                <Skeleton width={first} height={10} />
                <Skeleton width={second} height={7} />
              </span>
              <Skeleton width={38} height={8} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
