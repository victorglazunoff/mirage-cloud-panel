import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaudeSdkEnv, resolveBackgroundWaitCeilingMs } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Claude Code turns the Artifact tools off for SDK-driven sessions unless
// CLAUDE_CODE_ARTIFACT is set, so a UI session would lose them mid-conversation.
test('SDK sessions opt into the Artifact tools by default', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ARTIFACT, '1');
});

test('a host CLAUDE_CODE_ARTIFACT value wins over the default', () => {
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ARTIFACT: '0' }).CLAUDE_CODE_ARTIFACT, '0');
});

test('host env vars are still forwarded', () => {
  const env: Record<string, string | undefined> = buildClaudeSdkEnv({ ANTHROPIC_BASE_URL: 'http://proxy' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://proxy');
});

// Mirage Б4: the background-work ceiling comes from CLAUDE_SESSION_IDLE_TIMEOUT_MIN.
test('the background-work ceiling defaults to 30 minutes', () => {
  for (const raw of [undefined, '', 'abc', '0', '-5']) {
    assert.equal(resolveBackgroundWaitCeilingMs(raw), 30 * 60 * 1000);
  }
});

test('the background-work ceiling follows CLAUDE_SESSION_IDLE_TIMEOUT_MIN in minutes', () => {
  assert.equal(resolveBackgroundWaitCeilingMs('120'), 120 * 60 * 1000);
  assert.equal(resolveBackgroundWaitCeilingMs('1.5'), 90 * 1000);
});

test('the background-work ceiling stays within what setTimeout can hold, and at least a minute', () => {
  assert.equal(resolveBackgroundWaitCeilingMs('100000'), 2 ** 31 - 1);
  assert.equal(resolveBackgroundWaitCeilingMs('0.01'), 60 * 1000);
});

// Mirage: the settings screen changes the ceiling at runtime, so it is read per spawn.
test('a changed CLAUDE_SESSION_IDLE_TIMEOUT_MIN reaches the next spawned CLI without a restart', () => {
  const previous = process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN;
  try {
    process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN = '90';
    assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, String(90 * 60 * 1000));
    process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN = '15';
    assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, String(15 * 60 * 1000));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN;
    else process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN = previous;
  }
});
