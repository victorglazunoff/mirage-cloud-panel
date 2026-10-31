type MirageLogoProps = {
  /** Show the «MIRAGE» wordmark next to the mark; off for a bare mark (collapsed sidebar). */
  withWordmark?: boolean;
  /** Mark size in px; the wordmark scales with it. */
  size?: number;
  className?: string;
};

/**
 * Mirage mark and wordmark in the «Кабина» style: a gauge ring with the
 * signal-orange horizon line, then «MIRAGE» in widely tracked Tektur.
 *
 * Used by the auth module (login and loading screens), the sidebar module
 * (panel header) and the settings module (About tab), so the brand reads the
 * same before and after signing in.
 */
export function MirageLogo({ withWordmark = true, size = 26, className = '' }: MirageLogoProps) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-3 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 26 26"
        fill="none"
        aria-hidden="true"
        className="flex-none text-foreground"
      >
        <circle cx="13" cy="13" r="11.5" stroke="currentColor" strokeOpacity="0.45" />
        <path d="M2.5 15.2h21" stroke="#FF6A2B" strokeWidth="1.6" />
        <path
          d="M8 11.2l5-3.8 5 3.8"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M13 1.5v2.4M1.5 13h2.4M22.1 13h2.4" stroke="currentColor" strokeOpacity="0.45" />
      </svg>
      {withWordmark && (
        <span
          className="kb-t truncate font-semibold text-foreground"
          // Tracking is part of the mark; padding-right balances the trailing letter-space.
          style={{ fontSize: Math.round(size * 0.62), letterSpacing: '0.34em', paddingRight: '0.1em' }}
        >
          MIRAGE
        </span>
      )}
    </span>
  );
}
