import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-api-retry-1';

/**
 * Mirage: the SDK announces every automatic retry of a failed API call with a
 * live `system/api_retry` event. It used to normalize to nothing, so the chat
 * sat silent while Claude Code waited out an overloaded API.
 */
test('an api_retry event becomes one api_retry row with the retry numbers', () => {
  const rows = provider.normalizeMessage({
    type: 'system',
    subtype: 'api_retry',
    uuid: 'u-retry',
    attempt: 2,
    max_retries: 10,
    retry_delay_ms: 19_500,
    error_status: 529,
    error: 'server_error',
    session_id: 'sdk-session',
  }, SESSION_ID);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'api_retry');
  assert.equal(rows[0].sessionId, SESSION_ID);
  assert.deepEqual(rows[0].apiRetry, {
    attempt: 2,
    maxRetries: 10,
    retryDelayMs: 19_500,
    errorStatus: 529,
    error: 'server_error',
  });
});

test('a retry with no HTTP answer (dropped connection) has no status', () => {
  const [row] = provider.normalizeMessage({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 500,
    error_status: null,
  }, SESSION_ID);

  assert.equal(row.apiRetry?.errorStatus, null);
  assert.equal(row.apiRetry?.error, null);
});
