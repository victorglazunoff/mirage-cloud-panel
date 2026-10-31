import { useEffect, useState } from 'react';

/** Current time, re-read every `intervalMs`, so clocks, countdowns and "N мин" labels stay live. */
export function useNow(intervalMs = 15_000): Date {
  // Wall clock driving every relative label on the home screen.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(interval);
  }, [intervalMs]);

  return now;
}
