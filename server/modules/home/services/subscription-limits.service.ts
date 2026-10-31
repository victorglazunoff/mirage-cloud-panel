import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getMirageDataDir, isSubscriptionLimitsSwitchOn } from '@/shared/utils.js';

/**
 * The endpoint Claude Code's own `/usage` reads. Unofficial and undocumented,
 * so the counter is off unless `MIRAGE_SUBSCRIPTION_LIMITS=1`: every field is
 * read defensively and anything unrecognised is simply not shown.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** All browser tabs share one upstream call per minute. */
const CACHE_TTL_MS = 60_000;
/**
 * The usage endpoint answers 429 when polled too often (the old panel, its plugin and Claude
 * Code itself read it with the same token). A refused refresh waits 2, 4, 8… up to 15 minutes
 * before asking again, so the panel stops adding to the pressure.
 */
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Buckets that are already shown as the session / weekly gauges. */
const KNOWN_WINDOW_KEYS = new Set(['five_hour', 'seven_day']);

type LimitWindow = { percent: number; resetsAt: string | null };

type SubscriptionLimits = {
  /**
   * `ok` — fresh numbers; `stale` — last good numbers, upstream failed since; `unavailable` — nothing
   * to show; `disabled` — the counter is off (`MIRAGE_SUBSCRIPTION_LIMITS` is not set), the panel hides it.
   */
  status: 'ok' | 'stale' | 'unavailable' | 'disabled';
  reason: 'no-credentials' | 'token-expired' | 'upstream-error' | null;
  plan: string | null;
  fetchedAt: string | null;
  session: LimitWindow | null;
  weekly: LimitWindow | null;
  weeklyByModel: Array<LimitWindow & { model: string }>;
  /** Prepaid cloud credits; null when the account has none (the row is then hidden). */
  credits: (LimitWindow & { limitDollars: number; remainingDollars: number }) | null;
};

type SubscriptionCredentials = { accessToken: string; expired: boolean; plan: string | null };

type SubscriptionLimitsDependencies = {
  /** The counter is switched on; while it is off nothing is read or fetched. */
  isEnabled(): boolean;
  readCredentialsFile(): Promise<string>;
  fetchUsage(accessToken: string): Promise<{
    ok: boolean;
    status: number;
    headers?: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;
  /** Last good numbers kept across restarts, so a refused first refresh still shows them. */
  readSnapshot(): Promise<string | null>;
  writeSnapshot(text: string): Promise<void>;
  now(): number;
};

const defaultDependencies: SubscriptionLimitsDependencies = {
  isEnabled: () => isSubscriptionLimitsSwitchOn(),
  readCredentialsFile: () => {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return fs.readFile(path.join(claudeDir, '.credentials.json'), 'utf8');
  },
  fetchUsage: (accessToken) =>
    fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  readSnapshot: async () => null,
  writeSnapshot: async () => {},
  now: () => Date.now(),
};

/** Next to the panel database; a stand with its own database keeps its own snapshot. */
function snapshotPath(): string {
  const databasePath = process.env.DATABASE_PATH || path.join(getMirageDataDir(), 'auth.db');
  return path.join(path.dirname(databasePath), 'subscription-limits.json');
}

const fileSnapshot: Pick<SubscriptionLimitsDependencies, 'readSnapshot' | 'writeSnapshot'> = {
  readSnapshot: () => fs.readFile(snapshotPath(), 'utf8').catch(() => null),
  writeSnapshot: (text) => fs.writeFile(snapshotPath(), text, { mode: 0o600 }),
};

function retryAfterMs(value: string | null | undefined): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/** "default_claude_max_20x" → "MAX 20×"; falls back to the subscription type. */
function formatPlan(tier: unknown, subscriptionType: unknown): string | null {
  if (typeof tier === 'string') {
    const match = /max_(\d+)x/i.exec(tier);
    if (match) {
      return `MAX ${match[1]}×`;
    }
  }
  return typeof subscriptionType === 'string' && subscriptionType ? subscriptionType.toUpperCase() : null;
}

/**
 * Reads the OAuth block of `~/.claude/.credentials.json`. Only the access token
 * is used, and only in the upstream request header: the refresh token is never
 * touched and the token never leaves this module.
 */
export function parseSubscriptionCredentials(raw: string, now: number): SubscriptionCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = asRecord(asRecord(parsed)?.claudeAiOauth);
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return null;
  }
  const expiresAt = readFiniteNumber(oauth.expiresAt);
  return {
    accessToken: oauth.accessToken,
    expired: expiresAt !== null && expiresAt < now,
    plan: formatPlan(oauth.rateLimitTier, oauth.subscriptionType),
  };
}

function readWindow(value: unknown): LimitWindow | null {
  const record = asRecord(value);
  const percent = readFiniteNumber(record?.utilization);
  if (!record || percent === null) {
    return null;
  }
  return { percent: clampPercent(percent), resetsAt: typeof record.resets_at === 'string' ? record.resets_at : null };
}

/**
 * Maps the usage response to the three gauges plus per-model weekly limits.
 *
 * Credits are any extra bucket with a dollar allowance — the upstream names
 * these buckets with internal code words that change, so they are matched by
 * shape rather than by key.
 */
export function normalizeUsageResponse(raw: unknown): Omit<SubscriptionLimits, 'status' | 'reason' | 'plan' | 'fetchedAt'> {
  const body = asRecord(raw) ?? {};
  const session = readWindow(body.five_hour);
  const weekly = readWindow(body.seven_day);

  const weeklyByModel: SubscriptionLimits['weeklyByModel'] = [];
  if (Array.isArray(body.limits)) {
    for (const entry of body.limits) {
      const limit = asRecord(entry);
      const model = asRecord(asRecord(limit?.scope)?.model)?.display_name;
      const percent = readFiniteNumber(limit?.percent);
      if (limit?.kind !== 'weekly_scoped' || typeof model !== 'string' || !model || percent === null) {
        continue;
      }
      weeklyByModel.push({
        model,
        percent: clampPercent(percent),
        resetsAt: typeof limit.resets_at === 'string' ? limit.resets_at : null,
      });
    }
  }

  let credits: SubscriptionLimits['credits'] = null;
  for (const [key, value] of Object.entries(body)) {
    if (KNOWN_WINDOW_KEYS.has(key)) continue;
    const bucket = asRecord(value);
    const limitDollars = readFiniteNumber(bucket?.limit_dollars);
    const remainingDollars = readFiniteNumber(bucket?.remaining_dollars);
    if (!bucket || limitDollars === null || limitDollars <= 0 || remainingDollars === null) continue;
    const used = readFiniteNumber(bucket.utilization) ?? ((limitDollars - remainingDollars) / limitDollars) * 100;
    credits = {
      percent: clampPercent(used),
      resetsAt: typeof bucket.resets_at === 'string' ? bucket.resets_at : null,
      limitDollars,
      remainingDollars: Math.max(0, remainingDollars),
    };
    break;
  }

  return { session, weekly, weeklyByModel, credits };
}

const EMPTY_LIMITS = { session: null, weekly: null, weeklyByModel: [], credits: null };

/** The answer while the counter is off: no plan, no numbers, nothing for the panel to draw. */
const DISABLED_LIMITS: SubscriptionLimits = { status: 'disabled', reason: null, plan: null, fetchedAt: null, ...EMPTY_LIMITS };

/**
 * Subscription limits (5-hour session, week, per-model week, cloud credits)
 * with a shared one-minute cache. A failed refresh keeps serving the last good
 * numbers marked `stale`; failures are cached too so a broken token does not
 * turn every poll into an upstream call.
 */
export function createSubscriptionLimitsService(overrides: Partial<SubscriptionLimitsDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  let cached: { at: number; ttl: number; value: SubscriptionLimits } | null = null;
  let lastGood: SubscriptionLimits | null = null;
  let snapshotLoaded = false;
  let inFlight: Promise<SubscriptionLimits> | null = null;
  // Refused refreshes in a row and how long to wait after the latest one.
  let refusals = 0;
  let waitMs = CACHE_TTL_MS;

  const loadSnapshot = async () => {
    if (snapshotLoaded) return;
    snapshotLoaded = true;
    try {
      const text = await dependencies.readSnapshot();
      const saved = text ? asRecord(JSON.parse(text)) : null;
      if (!lastGood && saved && typeof saved.fetchedAt === 'string') {
        lastGood = { ...(saved as unknown as SubscriptionLimits), status: 'ok', reason: null };
      }
    } catch {
      // A broken snapshot only means the first refusal shows nothing.
    }
  };

  const fail = (reason: NonNullable<SubscriptionLimits['reason']>, plan: string | null): SubscriptionLimits =>
    lastGood
      ? { ...lastGood, status: 'stale', reason }
      : { status: 'unavailable', reason, plan, fetchedAt: null, ...EMPTY_LIMITS };

  const refresh = async (): Promise<SubscriptionLimits> => {
    waitMs = CACHE_TTL_MS;
    await loadSnapshot();
    let rawCredentials: string;
    try {
      rawCredentials = await dependencies.readCredentialsFile();
    } catch {
      return fail('no-credentials', null);
    }
    const credentials = parseSubscriptionCredentials(rawCredentials, dependencies.now());
    if (!credentials) {
      return fail('no-credentials', null);
    }
    if (credentials.expired) {
      // Refreshing would mean writing the user's credentials file; Claude Code
      // renews the token itself on its next request.
      return fail('token-expired', credentials.plan);
    }
    try {
      const response = await dependencies.fetchUsage(credentials.accessToken);
      if (!response.ok) {
        if (response.status !== 401) {
          refusals += 1;
          const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (refusals - 1));
          waitMs = Math.max(backoff, retryAfterMs(response.headers?.get('retry-after')));
        }
        return fail(response.status === 401 ? 'token-expired' : 'upstream-error', credentials.plan);
      }
      refusals = 0;
      const value: SubscriptionLimits = {
        status: 'ok',
        reason: null,
        plan: credentials.plan,
        fetchedAt: new Date(dependencies.now()).toISOString(),
        ...normalizeUsageResponse(await response.json()),
      };
      lastGood = value;
      void dependencies.writeSnapshot(JSON.stringify(value)).catch(() => {});
      return value;
    } catch {
      // The error is dropped on purpose: nothing about the request is logged.
      return fail('upstream-error', credentials.plan);
    }
  };

  return {
    async getLimits(): Promise<SubscriptionLimits> {
      // Off: the credentials file is not read and the unofficial endpoint is never called.
      if (!dependencies.isEnabled()) return DISABLED_LIMITS;
      if (cached && dependencies.now() - cached.at < cached.ttl) {
        return cached.value;
      }
      // Concurrent tabs polling at the same moment share one upstream call.
      inFlight ??= refresh().then((value) => {
        cached = { at: dependencies.now(), ttl: waitMs, value };
        return value;
      }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/** Used by the home routes to answer `GET /api/home/limits`. */
export const subscriptionLimitsService = createSubscriptionLimitsService(fileSnapshot);
