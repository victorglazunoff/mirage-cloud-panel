import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { claudeRuntime, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { providerRuntimeEvents } from '@/modules/providers/services/provider-runtime-events.service.js';
import type { ProviderRuntimeContext, ProviderRuntimeEvent } from '@/shared/types.js';

/**
 * Mirage (Х27, Х29): the runtime publishes what it sees on the runtime event
 * tap and answers live control requests (stopTask, getContextUsage) for the
 * agents-live and context-usage modules. Driven with a scripted SDK stream.
 */

const SESSION_ID = 'app-events-session';
const NATIVE_ID = 'native-events-session';

function createScriptedQuery() {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  const stopped: string[] = [];
  const contextCalls: unknown[] = [];

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const message of prompt) { void message; }
    })();
    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (!next) {
          return;
        }
        yield next;
      }
    })();
    return Object.assign(iterator, {
      interrupt: async () => {},
      stopTask: async (taskId: string) => { stopped.push(taskId); },
      getContextUsage: async (options: unknown) => {
        contextCalls.push(options);
        return { totalTokens: 1200, maxTokens: 200000, percentage: 0.6, categories: [] };
      },
    });
  };

  return {
    createQuery,
    emit: (message: Record<string, unknown>) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    stopped,
    contextCalls,
  };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

test('the runtime publishes its run, stream and process end on the tap, and answers live control requests', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-events-'));
  const events: ProviderRuntimeEvent[] = [];
  const unsubscribe = providerRuntimeEvents.subscribe((event) => events.push(event));
  const script = createScriptedQuery();
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: script.createQuery,
  };
  const writer = { send: () => {}, userId: null };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    script.emit({ type: 'system', subtype: 'init', session_id: NATIVE_ID, model: 'claude-haiku-4-5' });
    script.emit({
      type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
      message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: 'u1', name: 'Agent', input: { description: 'Скептик', prompt: 'p' } }] },
    });
    script.emit({ type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: 't1', tool_use_id: 'u1', description: 'Скептик', task_type: 'local_agent' });
    await settle();

    assert.equal(events[0].type, 'run_started');
    const runId = events[0].type === 'run_started' ? events[0].runId : '';
    assert.ok(runId);
    const messages = events.filter((event) => event.type === 'sdk_message');
    assert.deepEqual(messages.map((event) => (event.type === 'sdk_message' ? event.message.subtype ?? event.message.type : '')), ['init', 'assistant', 'task_started']);
    assert.ok(events.every((event) => event.sessionId === SESSION_ID && event.runId === runId));

    // Live control requests reach the process.
    assert.equal(claudeRuntime.isLive(SESSION_ID), true);
    assert.equal(await claudeRuntime.stopTask(SESSION_ID, 't1'), true, 'a foreground agent can be stopped too');
    assert.deepEqual(script.stopped, ['t1']);
    const usage = await claudeRuntime.getContextUsage(SESSION_ID, 'summary');
    assert.equal((usage as { totalTokens?: number } | null)?.totalTokens, 1200);
    assert.deepEqual(script.contextCalls, [{ detail: 'summary' }]);
    assert.equal(await claudeRuntime.stopTask('no-such-session', 't1'), false);
    assert.equal(await claudeRuntime.getContextUsage('no-such-session', 'full'), null);

    script.emit({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', is_error: false, total_cost_usd: 0.01, duration_ms: 1, num_turns: 1 });
    script.end();
    await done;

    const last = events[events.length - 1];
    assert.equal(last.type, 'run_ended');
    assert.equal(last.type === 'run_ended' ? last.reason : '', 'completed');
    assert.equal(claudeRuntime.isLive(SESSION_ID), false);
  } finally {
    unsubscribe();
    await rm(cwd, { recursive: true, force: true });
  }
});
