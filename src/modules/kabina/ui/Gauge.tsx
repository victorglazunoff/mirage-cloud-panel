import type { CSSProperties } from 'react';

/** Dial geometry from DarkMain: r=40 arc over 240°, starting at −120° (lower left). */
const RADIUS = 40;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SWEEP = (CIRCUMFERENCE * 240) / 360;

function ticks(step: number, innerRadius: number, outerRadius: number): string {
  let d = '';
  for (let percent = 0; percent <= 100.001; percent += step) {
    const angle = ((-120 + 2.4 * percent) * Math.PI) / 180;
    d += `M${(60 + innerRadius * Math.sin(angle)).toFixed(1)} ${(60 - innerRadius * Math.cos(angle)).toFixed(1)}`;
    d += `L${(60 + outerRadius * Math.sin(angle)).toFixed(1)} ${(60 - outerRadius * Math.cos(angle)).toFixed(1)}`;
  }
  return d;
}

const MINOR_TICKS = ticks(5, 47, 50);
const MAJOR_TICKS = ticks(25, 45, 51.5);
const TRACK_DASH = `${SWEEP.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`;

const TONE_COLORS = { signal: '#FF6A2B', sand: '#D9A35B', brick: '#E9805E', sage: '#9CC49A' } as const;

type GaugeDialProps = {
  /** 0..1; null draws an empty dial (no arc). */
  share: number | null;
  /** Arc colour. */
  color: string;
  /** Text under the hub. */
  label: string;
  /** Colour of that text (a stop warning paints «100%» orange). */
  labelColor?: string;
  ariaLabel: string;
  /** Arc stroke: 5 on desktop gauges, 6 on phone gauges and DarkStates L cards. */
  stroke?: number;
  needleWidth?: number;
  hubRadius?: number;
  labelY?: number;
  labelSize?: number;
  /** Start of the sweep, so a row of dials comes alive one after another ("0.35s"). */
  delay?: string;
  className?: string;
};

/**
 * Used by Gauge and the limit-warning cards (DarkStates L1–L3): the bare 240° dial —
 * ticks, track, arc and needle with their sweep-in — without the name and caption.
 */
export function GaugeDial({
  share,
  color,
  label,
  labelColor = '#EDE6DA',
  ariaLabel,
  stroke = 5,
  needleWidth = 1.6,
  hubRadius = 4,
  labelY = 92,
  labelSize = 17,
  delay,
  className,
}: GaugeDialProps) {
  const clamped = share === null ? 0 : Math.min(1, Math.max(0, share));
  const arcDash = `${(SWEEP * clamped).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`;
  const delayStyle: CSSProperties = delay ? { animationDelay: delay } : {};
  const needleStyle = {
    '--kb-deg': `${(-120 + 240 * clamped).toFixed(1)}deg`,
    ...delayStyle,
  } as CSSProperties;
  return (
    <svg className={className} viewBox="0 0 120 98" role="img" aria-label={ariaLabel}>
      <path d={MINOR_TICKS} fill="none" stroke="rgba(255,236,210,0.28)" strokeWidth="1" />
      <path d={MAJOR_TICKS} fill="none" stroke="rgba(255,236,210,0.62)" strokeWidth="1.4" />
      <circle
        cx="60"
        cy="60"
        r={RADIUS}
        fill="none"
        stroke="rgba(255,236,210,0.08)"
        strokeWidth={stroke}
        strokeDasharray={TRACK_DASH}
        transform="rotate(150 60 60)"
      />
      {share !== null && (
        <circle
          className="kb-arc"
          data-testid="kb-gauge-arc"
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          style={{ strokeDasharray: arcDash, ...delayStyle }}
          transform="rotate(150 60 60)"
        />
      )}
      <g className="kb-needle" data-testid="kb-gauge-needle" style={needleStyle}>
        <path d="M60 64 L60 27" stroke="#EDE6DA" strokeWidth={needleWidth} strokeLinecap="round" />
      </g>
      <circle cx="60" cy="60" r={hubRadius} fill="#12110F" stroke="#EDE6DA" strokeWidth="1.4" />
      <text x="60" y={labelY} textAnchor="middle" fill={labelColor} fontFamily="Tektur, sans-serif" fontSize={labelSize} fontWeight="500">
        {label}
      </text>
    </svg>
  );
}

type GaugeProps = {
  name: string;
  caption: string;
  /** 0..100; null draws an empty dial with "—" (no data yet). */
  percent: number | null;
  /** Arc colour: signal orange (default), sand for credits, brick near the cap, sage for «всё в норме». */
  tone?: keyof typeof TONE_COLORS;
  /** Text in the dial; defaults to the rounded percent. */
  valueLabel?: string;
  /** Phone size: 100px dial, thicker arc and needle. */
  compact?: boolean;
  /** Colour of the number in the dial (DarkLogin paints «3 / 5» attempts orange). */
  valueColor?: string;
  /**
   * DarkLogin's power-on self-test: the needle swings to the stop and back
   * before settling, instead of sweeping up from zero.
   */
  selfTest?: boolean;
  /** Start of the sweep, so a row of dials comes alive one after another ("0.35s"). */
  delay?: string;
};

/** Used by the home limits block and the sign-in preflight (auth module): the 240° needle instrument with the sweep-in animation. */
export function Gauge({
  name,
  caption,
  percent,
  tone = 'signal',
  valueLabel,
  compact = false,
  valueColor = '#EDE6DA',
  selfTest = false,
  delay,
}: GaugeProps) {
  const label = valueLabel ?? (percent === null ? '—' : `${Math.round(percent)}%`);
  return (
    <div className="kb-gauge" data-compact={compact ? '' : undefined} data-selftest={selfTest ? '' : undefined}>
      <GaugeDial
        share={percent === null ? null : percent / 100}
        color={TONE_COLORS[tone]}
        label={label}
        labelColor={valueColor}
        ariaLabel={`${name}: ${label}, ${caption}`}
        stroke={compact ? 6 : 5}
        needleWidth={compact ? 1.8 : 1.6}
        hubRadius={compact ? 4.5 : 4}
        labelY={compact ? 94 : 92}
        labelSize={compact ? 20 : 17}
        delay={delay}
      />
      <span className="kb-gauge-name">{name}</span>
      <span className="kb-m kb-gauge-caption">{caption}</span>
    </div>
  );
}
