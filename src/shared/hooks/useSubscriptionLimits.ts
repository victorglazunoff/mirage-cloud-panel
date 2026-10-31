import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { SubscriptionLimits } from '@/shared/types';

/** Matches the server cache: polling faster would only re-read the same numbers. */
const POLL_INTERVAL_MS = 60_000;
/** Remembers whether the counter was on at the last answer, so a reload draws (or hides) it at once. */
const ENABLED_STORAGE_KEY = 'mirage-subscription-limits-enabled';

const UNAVAILABLE: SubscriptionLimits = {
  status: 'unavailable',
  reason: 'upstream-error',
  plan: null,
  fetchedAt: null,
  session: null,
  weekly: null,
  weeklyByModel: [],
  credits: null,
};

/*
 * One poller for the whole page: the HUD on every screen, the home limits block and the
 * limit warnings read the same answer instead of each fetching it once a minute.
 * The first subscriber starts the poll (and re-reads at once), the last one stops it.
 */
let latest: SubscriptionLimits | null = null;
const listeners = new Set<(limits: SubscriptionLimits | null) => void>();
let timer: number | null = null;

function readRememberedEnabled(): boolean {
  try {
    return window.localStorage.getItem(ENABLED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the next reload just waits for the server again.
  }
}

function stopPolling(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

async function loadLimits() {
  try {
    const body = await readApiJson<{ data: SubscriptionLimits }>(await api.home.limits());
    latest = body.data;
    rememberEnabled(latest.status !== 'disabled');
    // The counter is off on the server: nothing will change until it restarts, stop asking.
    if (latest.status === 'disabled') stopPolling();
  } catch {
    // Keep the previous numbers; a first failure shows the "unavailable" note.
    latest = latest ?? UNAVAILABLE;
  }
  listeners.forEach((listener) => listener(latest));
}

function subscribe(listener: (limits: SubscriptionLimits | null) => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && latest?.status !== 'disabled') {
    void loadLimits();
    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadLimits();
    }, POLL_INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopPolling();
  };
}

/**
 * Used by the home limits block, the Kabina HUD instruments and the Kabina limit warnings:
 * subscription limits polled once a minute (one shared poll); null until the first answer arrives.
 */
export function useSubscriptionLimits(): SubscriptionLimits | null {
  // The latest shared limits answer (including `unavailable`); starts from the cache so a
  // screen change does not blink the instruments empty.
  const [limits, setLimits] = useState<SubscriptionLimits | null>(latest);

  useEffect(() => subscribe(setLimits), []);

  return limits;
}

/**
 * Whether the subscription limits exist in this panel (server `MIRAGE_SUBSCRIPTION_LIMITS`).
 * Until the first answer it is what the last answer said (off on a first visit), so a
 * reload neither flashes empty gauges nor makes them pop in. Used by the HUD, home,
 * settings and ⌘K, which then leave the limits out entirely instead of an empty place.
 */
export function isSubscriptionLimitsEnabled(limits: SubscriptionLimits | null): boolean {
  return limits ? limits.status !== 'disabled' : readRememberedEnabled();
}
