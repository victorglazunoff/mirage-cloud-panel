import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

/** One line of the «журнал запуска»: when a check finished, what it was and how it went. */
type PreflightLogLine = {
  at: Date;
  what: string;
  result: string;
  tone: 'ok' | 'warn' | 'error';
};

/** Live result of the sign-in screen's preflight check (DarkLogin «Проверка систем»). */
type PreflightState = {
  /** `checking` until the first round finishes; `offline` when the server did not answer at all. */
  phase: 'checking' | 'done' | 'offline';
  /** Best round-trip to `/api/auth/status`, ms. */
  pingMs: number | null;
  /** Server clock minus this device's clock, ms (positive: the server is ahead). */
  clockSkewMs: number | null;
  /** The difference as printed on the dial and in the log, «±0,2 с». */
  skewLabel: string | null;
  /** The status answered with a user count, so the panel database is readable. */
  databaseOk: boolean;
  /** The page is served over HTTPS. */
  secure: boolean;
  log: PreflightLogLine[];
};

const PING_SAMPLES = 3;
const RETRY_OFFLINE_MS = 5_000;

type StatusSample = { rttMs: number; skewMs: number | null; ok: boolean };

/** One timed status request; the server clock is read against the midpoint of the round trip. */
async function sampleStatus(): Promise<StatusSample> {
  const sentAt = Date.now();
  const started = performance.now();
  const response = await api.auth.status();
  const rttMs = performance.now() - started;
  let skewMs: number | null = null;
  try {
    const body = (await response.json()) as { serverTime?: unknown };
    if (typeof body.serverTime === 'number') {
      skewMs = body.serverTime - (sentAt + rttMs / 2);
    }
  } catch {
    // An older server without `serverTime` — the clock gauge stays empty.
  }
  return { rttMs, skewMs, ok: response.ok };
}

/** «±0,2 с» — the clock difference the way the dial and the log print it. */
function formatSkew(skewMs: number): string {
  return `±${(Math.abs(skewMs) / 1000).toFixed(1).replace('.', ',')} с`;
}

/**
 * Runs the sign-in screen's preflight: three timed pings of the public status
 * endpoint (latency and the clock difference with the server, from the
 * fastest sample), then fills the boot log. Retries every 5 s while the
 * server does not answer. Used by the auth module's sign-in and setup screens.
 */
export function usePreflightCheck(): PreflightState {
  // The whole preflight result; one object so the gauges, lamps and log always agree.
  const [state, setState] = useState<PreflightState>(() => ({
    phase: 'checking',
    pingMs: null,
    clockSkewMs: null,
    skewLabel: null,
    databaseOk: false,
    secure: typeof window !== 'undefined' && window.location.protocol === 'https:',
    log: [],
  }));

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    const host = window.location.host;
    const secure = window.location.protocol === 'https:';

    const run = async () => {
      const samples: StatusSample[] = [];
      for (let index = 0; index < PING_SAMPLES; index += 1) {
        try {
          samples.push(await sampleStatus());
        } catch {
          break;
        }
      }
      if (cancelled) return;

      if (samples.length === 0) {
        setState((previous) => ({
          ...previous,
          phase: 'offline',
          log: [{ at: new Date(), what: `связь с ${host}`, result: 'нет ответа', tone: 'error' }],
        }));
        retryTimer = window.setTimeout(() => void run(), RETRY_OFFLINE_MS);
        return;
      }

      const fastest = samples.reduce((best, sample) => (sample.rttMs < best.rttMs ? sample : best));
      const pingMs = Math.max(1, Math.round(fastest.rttMs));
      const skewMs = fastest.skewMs;
      const databaseOk = samples.some((sample) => sample.ok);
      const now = new Date();
      const skewOk = skewMs !== null && Math.abs(skewMs) < 10_000;

      const log: PreflightLogLine[] = [
        { at: now, what: `связь с ${host}`, result: `${pingMs} мс`, tone: pingMs <= 150 ? 'ok' : 'warn' },
        secure
          ? { at: now, what: 'шифрование · HTTPS', result: 'ок', tone: 'ok' }
          : { at: now, what: 'шифрование · локальный адрес', result: 'без TLS', tone: 'warn' },
        skewMs === null
          ? { at: now, what: 'часы сервера', result: 'не сверены', tone: 'warn' }
          : { at: now, what: 'часы сверены с сервером', result: formatSkew(skewMs), tone: skewOk ? 'ok' : 'warn' },
        { at: now, what: 'служба панели · Claude Code', result: databaseOk ? 'отвечает' : 'с ошибкой', tone: databaseOk ? 'ok' : 'error' },
      ];
      const passed = log.filter((line) => line.tone === 'ok').length + (databaseOk ? 1 : 0);
      log.push({ at: now, what: 'проверка систем', result: `${passed} из 5`, tone: passed === 5 ? 'ok' : 'warn' });

      setState({
        phase: 'done',
        pingMs,
        clockSkewMs: skewMs,
        skewLabel: skewMs === null ? null : formatSkew(skewMs),
        databaseOk,
        secure,
        log,
      });
    };

    void run();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, []);

  return state;
}
