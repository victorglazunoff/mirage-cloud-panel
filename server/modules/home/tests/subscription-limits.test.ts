import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSubscriptionLimitsService,
  normalizeUsageResponse,
  parseSubscriptionCredentials,
} from '@/modules/home/services/subscription-limits.service.js';

// The counter is off by default; these tests are about the counter itself.
process.env.MIRAGE_SUBSCRIPTION_LIMITS = '1';

const SECRET_TOKEN = 'fake-oauth-token';
const NOW = Date.parse('2026-10-26T09:32:00Z');

function credentialsJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: SECRET_TOKEN,
      refreshToken: 'refresh-must-never-be-read',
      expiresAt: NOW + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      ...overrides,
    },
  });
}

/** Trimmed copy of a real `/api/oauth/usage` answer (26.10.2026). */
const USAGE_RESPONSE = {
  five_hour: { utilization: 27, resets_at: '2026-10-26T13:10:00.322788+00:00', limit_dollars: null },
  seven_day: { utilization: 47, resets_at: '2026-10-29T00:00:00.322811+00:00', limit_dollars: null },
  seven_day_opus: null,
  iguana_necktie: {
    utilization: 80.42459559999999,
    resets_at: '2026-11-05T07:59:00+00:00',
    limit_dollars: 250,
    used_dollars: 201.061489,
    remaining_dollars: 48.938511000000005,
  },
  extra_usage: { is_enabled: false, monthly_limit: null },
  limits: [
    { kind: 'session', percent: 27, resets_at: '2026-10-26T13:10:00Z', scope: null },
    { kind: 'weekly_all', percent: 47, resets_at: '2026-10-29T00:00:00Z', scope: null },
    { kind: 'weekly_scoped', percent: 3, resets_at: '2026-10-29T00:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' } } },
  ],
};

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

test('normalizeUsageResponse maps the session, week, per-model week and dollar credits', () => {
  const limits = normalizeUsageResponse(USAGE_RESPONSE);
  assert.deepEqual(limits.session, { percent: 27, resetsAt: '2026-10-26T13:10:00.322788+00:00' });
  assert.deepEqual(limits.weekly, { percent: 47, resetsAt: '2026-10-29T00:00:00.322811+00:00' });
  assert.deepEqual(limits.weeklyByModel, [{ model: 'Fable', percent: 3, resetsAt: '2026-10-29T00:00:00+00:00' }]);
  assert.equal(limits.credits?.limitDollars, 250);
  assert.equal(Math.floor(limits.credits?.remainingDollars ?? 0), 48);
  assert.equal(limits.credits?.percent, 80.4);
  assert.equal(limits.credits?.resetsAt, '2026-11-05T07:59:00+00:00');
});

test('normalizeUsageResponse hides credits when no bucket has a dollar allowance', () => {
  const limits = normalizeUsageResponse({ five_hour: { utilization: 5, resets_at: null } });
  assert.equal(limits.credits, null);
  assert.equal(limits.weekly, null);
  assert.deepEqual(limits.weeklyByModel, []);
  assert.deepEqual(normalizeUsageResponse('garbage'), { session: null, weekly: null, weeklyByModel: [], credits: null });
});

test('parseSubscriptionCredentials reads the plan and expiry, rejects malformed files', () => {
  const parsed = parseSubscriptionCredentials(credentialsJson(), NOW);
  assert.equal(parsed?.plan, 'MAX 20×');
  assert.equal(parsed?.expired, false);
  assert.equal(parseSubscriptionCredentials(credentialsJson({ expiresAt: NOW - 1 }), NOW)?.expired, true);
  assert.equal(parseSubscriptionCredentials('{not json', NOW), null);
  assert.equal(parseSubscriptionCredentials(JSON.stringify({ claudeAiOauth: {} }), NOW), null);
});

test('the counter is off unless MIRAGE_SUBSCRIPTION_LIMITS is set: nothing is read or fetched', async () => {
  let reads = 0;
  let fetches = 0;
  const service = createSubscriptionLimitsService({
    isEnabled: () => false,
    now: () => NOW,
    readCredentialsFile: async () => {
      reads += 1;
      return credentialsJson();
    },
    fetchUsage: async () => {
      fetches += 1;
      return okResponse(USAGE_RESPONSE);
    },
  });
  assert.deepEqual(await service.getLimits(), {
    status: 'disabled', reason: null, plan: null, fetchedAt: null, session: null, weekly: null, weeklyByModel: [], credits: null,
  });
  assert.equal(reads + fetches, 0);

  const previous = process.env.MIRAGE_SUBSCRIPTION_LIMITS;
  try {
    for (const value of ['', '0', 'off']) {
      process.env.MIRAGE_SUBSCRIPTION_LIMITS = value;
      assert.equal((await createSubscriptionLimitsService({ readCredentialsFile: async () => { reads += 1; return ''; } }).getLimits()).status, 'disabled');
    }
    assert.equal(reads, 0);
  } finally {
    process.env.MIRAGE_SUBSCRIPTION_LIMITS = previous;
  }
});

test('limits are cached for a minute and the token never appears in the answer', async () => {
  let now = NOW;
  const seenTokens: string[] = [];
  const service = createSubscriptionLimitsService({
    now: () => now,
    readCredentialsFile: async () => credentialsJson(),
    fetchUsage: async (token) => {
      seenTokens.push(token);
      return okResponse(USAGE_RESPONSE);
    },
  });

  const first = await service.getLimits();
  await service.getLimits();
  assert.equal(seenTokens.length, 1, 'second read within 60 s is served from cache');
  assert.equal(first.status, 'ok');
  assert.equal(first.plan, 'MAX 20×');
  assert.equal(JSON.stringify(first).includes(SECRET_TOKEN), false);
  assert.equal(JSON.stringify(first).includes('refresh'), false);

  now += 61_000;
  await service.getLimits();
  assert.equal(seenTokens.length, 2, 'cache expires after a minute');
  assert.deepEqual(seenTokens, [SECRET_TOKEN, SECRET_TOKEN]);
});

test('concurrent reads share one upstream call', async () => {
  let calls = 0;
  const service = createSubscriptionLimitsService({
    now: () => NOW,
    readCredentialsFile: async () => credentialsJson(),
    fetchUsage: async () => {
      calls += 1;
      return okResponse(USAGE_RESPONSE);
    },
  });
  await Promise.all([service.getLimits(), service.getLimits(), service.getLimits()]);
  assert.equal(calls, 1);
});

test('a failed refresh keeps the last good numbers marked stale', async () => {
  let now = NOW;
  let fail = false;
  const service = createSubscriptionLimitsService({
    now: () => now,
    readCredentialsFile: async () => credentialsJson(),
    fetchUsage: async () => (fail ? { ok: false, status: 502, json: async () => ({}) } : okResponse(USAGE_RESPONSE)),
  });
  await service.getLimits();
  fail = true;
  now += 61_000;
  const stale = await service.getLimits();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reason, 'upstream-error');
  assert.equal(stale.session?.percent, 27);
});

test('missing credentials, an expired token and a 401 each explain themselves', async () => {
  const missing = await createSubscriptionLimitsService({
    readCredentialsFile: async () => {
      throw new Error('ENOENT');
    },
  }).getLimits();
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'no-credentials');

  let fetched = false;
  const expired = await createSubscriptionLimitsService({
    now: () => NOW,
    readCredentialsFile: async () => credentialsJson({ expiresAt: NOW - 1000 }),
    fetchUsage: async () => {
      fetched = true;
      return okResponse(USAGE_RESPONSE);
    },
  }).getLimits();
  assert.equal(expired.reason, 'token-expired');
  assert.equal(fetched, false, 'an expired token is not sent upstream');

  const rejected = await createSubscriptionLimitsService({
    now: () => NOW,
    readCredentialsFile: async () => credentialsJson(),
    fetchUsage: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  }).getLimits();
  assert.equal(rejected.status, 'unavailable');
  assert.equal(rejected.reason, 'token-expired');
});

test('a 429 keeps the last numbers and waits before asking again', async () => {
  let now = NOW;
  let calls = 0;
  let limited = false;
  const service = createSubscriptionLimitsService({
    now: () => now,
    readCredentialsFile: async () => credentialsJson(),
    fetchUsage: async () => {
      calls += 1;
      return limited
        ? { ok: false, status: 429, headers: { get: () => '0' }, json: async () => ({}) }
        : okResponse(USAGE_RESPONSE);
    },
  });
  await service.getLimits();
  limited = true;
  now += 61_000;
  const stale = await service.getLimits();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.session?.percent, 27);
  now += 61_000;
  await service.getLimits();
  assert.equal(calls, 2, 'no new upstream call within the 2-minute wait');
  now += 60_000;
  await service.getLimits();
  assert.equal(calls, 3, 'asks again once the wait is over');
});

test('numbers saved before a restart are shown when the first refresh is refused', async () => {
  let saved: string | null = null;
  await createSubscriptionLimitsService({
    now: () => NOW,
    readCredentialsFile: async () => credentialsJson(),
    fetchUsage: async () => okResponse(USAGE_RESPONSE),
    writeSnapshot: async (text) => {
      saved = text;
    },
  }).getLimits();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(saved && !String(saved).includes(SECRET_TOKEN));
  const restarted = await createSubscriptionLimitsService({
    now: () => NOW + 3_600_000,
    readCredentialsFile: async () => credentialsJson({ expiresAt: NOW + 7_200_000 }),
    fetchUsage: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    readSnapshot: async () => saved,
  }).getLimits();
  assert.equal(restarted.status, 'stale');
  assert.equal(restarted.session?.percent, 27);
});
