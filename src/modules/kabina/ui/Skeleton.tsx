import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

type SkeletonProps = {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  radius?: CSSProperties['borderRadius'];
  className?: string;
  style?: CSSProperties;
};

/** Used by loading states of the Kabina layer: a shimmering bar that keeps the final layout's shape. */
export function Skeleton({ width = '100%', height = 11, radius, className, style }: SkeletonProps) {
  return (
    <span
      className={`kb-sk${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/**
 * Used by loading states: true only after `delayMs`, so a fast load never
 * flashes a skeleton (DarkStates S1: «до 200 мс — ничего»).
 */
export function useDelayedFlag(active: boolean, delayMs = 200): boolean {
  // Whether the delay has passed while `active` stayed true.
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setTimeout(() => setIsVisible(true), delayMs);
    return () => {
      window.clearTimeout(timer);
      // The next activation waits its own delay again.
      setIsVisible(false);
    };
  }, [active, delayMs]);

  return active && isVisible;
}
