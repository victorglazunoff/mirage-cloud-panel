import { Gauge, Panel, SectionRuler, TrendIcon } from '@/modules/kabina';
import {
  formatClock,
  formatCredits,
  formatPercent,
  formatReset,
  formatShortDay,
  weeklyElapsedShare,
} from '@/modules/home/utils/homeFormatting';
import type { SubscriptionLimits } from '@/shared/types';

type HomeLimitsProps = {
  index: string;
  limits: SubscriptionLimits | null;
  now: Date;
  isPhone: boolean;
  /** «Подробнее →»; absent in the classic interface. */
  onOpenDetails?: () => void;
};

type GaugeSpec = { key: string; name: string; caption: string; percent: number | null; tone: 'signal' | 'sand' };

const UNAVAILABLE_TEXT: Record<NonNullable<SubscriptionLimits['reason']>, string> = {
  'no-credentials': 'На сервере нет входа Claude Code — войди в claude, и лимиты появятся здесь.',
  'token-expired': 'Токен Claude истёк. Он обновится сам при следующем запросе в любой сессии.',
  'upstream-error': 'Anthropic сейчас не отдал лимиты. Повторю через минуту.',
};

/** Х18 «Лимиты» (DarkMain 05 / DarkPhoneMain 03): the week and credits needles and the week's pace. */
export default function HomeLimits({ index, limits, now, isPhone, onOpenDetails }: HomeLimitsProps) {
  const hasNumbers = Boolean(limits && limits.status !== 'unavailable');
  // Mirage: no 5-hour «Сессия» dial — the plan has no 5-hour window any more (`five_hour: null`).
  const gauges: GaugeSpec[] = [
    {
      key: 'weekly',
      name: 'Неделя',
      caption: limits?.weekly
        ? isPhone ? formatReset(limits.weekly.resetsAt, now) : `все модели · ${formatReset(limits.weekly.resetsAt, now)}`
        : 'нет данных',
      percent: limits?.weekly?.percent ?? null,
      tone: 'signal',
    },
  ];
  // No credits source → no third dial, per Х18.
  if (limits?.credits) {
    const expires = formatShortDay(limits.credits.resetsAt);
    const amount = formatCredits(limits.credits.remainingDollars, limits.credits.limitDollars);
    gauges.push({
      key: 'credits',
      name: 'Кредиты',
      caption: isPhone ? amount : `${amount}${expires ? ` · до ${expires}` : ''}`,
      percent: limits.credits.percent,
      tone: 'sand',
    });
  }

  const elapsed = limits?.weekly ? weeklyElapsedShare(limits.weekly.resetsAt, now.getTime()) : null;
  const weeklyPercent = limits?.weekly?.percent ?? null;
  const ahead = elapsed !== null && weeklyPercent !== null && weeklyPercent > elapsed * 100;

  return (
    <Panel as="section" className={`mh-limits kb-rise kb-d4`} aria-labelledby="mh-h-lim" data-phone={isPhone ? '' : undefined}>
      <SectionRuler id="mh-h-lim" index={index} title={`ЛИМИТЫ${limits?.plan ? ` · ${limits.plan}` : ''}`} scale="none" touch={isPhone}>
        {/* A phone ruler has no room for it: «Подробнее →» would be pushed off the card. */}
        {limits?.status === 'stale' && limits.fetchedAt && !isPhone && (
          <span className="kb-m kb-ruler-meta" title="Последние известные данные">на {formatClock(new Date(limits.fetchedAt))}</span>
        )}
        {onOpenDetails && (
          <button type="button" className="kb-ruler-link kb-lnk" onClick={onOpenDetails}>Подробнее →</button>
        )}
      </SectionRuler>

      {limits && !hasNumbers ? (
        <p className="mh-note kb-pretty" style={{ margin: 0 }}>{UNAVAILABLE_TEXT[limits.reason ?? 'upstream-error']}</p>
      ) : (
        <div className="mh-gauges" aria-busy={limits ? undefined : true} style={{ gridTemplateColumns: `repeat(${gauges.length}, minmax(0, 1fr))` }}>
          {gauges.map((spec) => (
            <Gauge
              key={spec.key}
              name={spec.name}
              caption={spec.caption}
              percent={spec.percent}
              tone={spec.percent !== null && spec.percent >= 85 ? 'brick' : spec.tone}
              compact={isPhone}
            />
          ))}
        </div>
      )}

      {hasNumbers && elapsed !== null && weeklyPercent !== null && (
        <div className="mh-pace">
          <span style={{ color: ahead ? 'var(--kb-sand)' : 'var(--kb-sage)', display: 'inline-flex', flex: 'none' }}>
            <TrendIcon rising={!ahead} />
          </span>
          <span className="kb-pretty">
            {isPhone ? 'Неделя: ' : 'Темп недели: израсходовано '}
            <span className="kb-m mh-pace-num">{formatPercent(weeklyPercent)}</span> при прошедших{' '}
            <span className="kb-m mh-pace-num">{formatPercent(elapsed * 100)}</span> — {ahead ? 'идёшь быстрее времени' : 'запас есть'}
          </span>
        </div>
      )}
    </Panel>
  );
}
