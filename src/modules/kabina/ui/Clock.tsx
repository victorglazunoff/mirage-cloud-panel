import { useEffect, useState } from 'react';

import { getPanelTimeZone, panelZoneLabel, toPanelWall, usePanelTimeZone } from '@/modules/kabina/ui/panelTime';

const WEEKDAYS_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

/**
 * Used by the sign-in lock note («в 14:47 ЕКБ»): the caption of the panel zone
 * (server `MIRAGE_TIMEZONE_LABEL`, else «UTC+N»), not of the browser's.
 */
export function zoneLabel(date: Date): string {
  return panelZoneLabel(getPanelTimeZone(), date);
}

/** Wall clock for the header, re-read every few seconds so the minute flips on time. */
function useClockNow(intervalMs: number): Date {
  // The time the clock currently shows.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

type ClockProps = {
  /** Phone header: only "14:32", no date and zone. */
  compact?: boolean;
};

/** Used by the shell header: «ПН 26.10 14:32 ЕКБ» in the panel zone, with the blinking colon. */
export function Clock({ compact = false }: ClockProps) {
  const instant = useClockNow(5_000);
  const timeZone = usePanelTimeZone();
  // The panel's wall clock, whatever zone the browser is in.
  const now = toPanelWall(instant, timeZone);
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const date = `${WEEKDAYS_SHORT[now.getDay()]} ${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}`;
  const zone = panelZoneLabel(timeZone, instant);

  return (
    <time
      className="kb-m kb-clock"
      data-compact={compact ? '' : undefined}
      dateTime={instant.toISOString()}
      aria-label={`${date}, ${hours}:${minutes}, ${zone}`}
    >
      {!compact && <span aria-hidden="true">{date}</span>}
      <span className="kb-clock-time" aria-hidden="true">
        {hours}
        <span className="kb-colon">:</span>
        {minutes}
      </span>
      {!compact && <span aria-hidden="true">{zone}</span>}
    </time>
  );
}
