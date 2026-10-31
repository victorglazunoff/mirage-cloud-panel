import { useMemo, useState } from 'react';

import '@/modules/kabina/kabinaStates.css';
import { computeLimitWarnings, readLimitWarningFlag, writeLimitWarningFlag } from '@/modules/kabina/utils/limitWarnings';
import { Button } from '@/modules/kabina/ui/Button';
import { GaugeDial } from '@/modules/kabina/ui/Gauge';
import { StatusShape } from '@/modules/kabina/ui/StatusShape';
import type { KabinaLimitWarning, SubscriptionLimits } from '@/shared/types';

type LimitWarningAction = { label: string; onClick: () => void };

type LimitWarningCardProps = {
  warning: KabinaLimitWarning;
  /** Left button; orange only on a `stop` (the week exhausted). */
  primaryAction?: LimitWarningAction;
  /** Right, outlined button. */
  secondaryAction?: LimitWarningAction;
};

/**
 * Used by the home limit plaques and the /states showcase: one DarkStates 04
 * card (L1 80 % недели, L3 кредиты сгорают) — dial, tag,
 * title, meta, explanation and two actions.
 */
export function LimitWarningCard({ warning, primaryAction, secondaryAction }: LimitWarningCardProps) {
  const isStop = warning.tone === 'stop';
  const color = isStop ? '#FF6A2B' : '#D9A35B';
  const labelColor = isStop ? (warning.share >= 1 ? '#FF8A55' : '#EDE6DA') : '#D9A35B';
  return (
    <div className="kb-limitcard" data-tone={warning.tone} role={warning.share >= 1 ? 'alert' : 'status'}>
      <div className="kb-limitcard-head">
        <GaugeDial
          className="kb-limitcard-dial"
          share={warning.share}
          color={color}
          label={warning.value}
          labelColor={labelColor}
          ariaLabel={`${warning.tag.toLowerCase()}: ${warning.value}`}
          stroke={6}
          needleWidth={1.8}
          labelY={94}
          labelSize={19}
        />
        <div className="kb-limitcard-titles">
          <span className="kb-limitcard-tagrow">
            <StatusShape kind={isStop ? 'wait' : 'warn'} />
            <span className="kb-m kb-limitcard-tag">{warning.tag}</span>
          </span>
          <span className="kb-limitcard-title">{warning.title}</span>
          <span className="kb-m kb-limitcard-meta">{warning.meta}</span>
        </div>
      </div>
      <p className="kb-limitcard-text">{warning.text}</p>
      {(primaryAction || secondaryAction) && (
        <div className="kb-limitcard-actions">
          {primaryAction && (
            <Button variant={isStop ? 'pri' : 'ghost'} className="kb-limitcard-pri" onClick={primaryAction.onClick}>
              {primaryAction.label}
            </Button>
          )}
          {secondaryAction && (
            <Button variant="ghost" className="kb-limitcard-sec" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type LimitWarningsProps = {
  limits: SubscriptionLimits | null;
  now: Date;
  /** «Подробнее» — the HUD's limits panel (`kabinaLimitsHref`); omitted → the button is not drawn. */
  onOpenDetails?: () => void;
};

/**
 * Used by the home screen (DarkMain, DarkPhoneMain): the plaques of every
 * active limits warning, each hidden «до 90 % или сброса» / «до сброса» /
 * «до завтра» by its key once the user dismisses it. Renders nothing when
 * all is well.
 */
export function LimitWarnings({ limits, now, onOpenDetails }: LimitWarningsProps) {
  const nowMs = now.getTime();
  const warnings = useMemo(() => computeLimitWarnings(limits, nowMs), [limits, nowMs]);
  // Keys hidden during this visit; storage keeps them across visits.
  const [hiddenNow, setHiddenNow] = useState<string[]>([]);
  const visible = warnings.filter((warning) => !hiddenNow.includes(warning.key) && !readLimitWarningFlag('hidden', warning.key));
  if (visible.length === 0) return null;

  const hide = (key: string) => {
    writeLimitWarningFlag('hidden', key);
    setHiddenNow((previous) => [...previous, key]);
  };

  return (
    <section className="kb-limitwarnings kb-rise" aria-label="Предупреждения о лимитах">
      {visible.map((warning) => (
        <LimitWarningCard
          key={warning.key}
          warning={warning}
          primaryAction={{ label: warning.code === 'L3' ? 'Напомнить завтра' : 'Понятно', onClick: () => hide(warning.key) }}
          secondaryAction={onOpenDetails ? { label: 'Подробнее', onClick: onOpenDetails } : undefined}
        />
      ))}
    </section>
  );
}
