import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readExternalTranscript, resolveClaudeTranscriptFile } from '@/modules/agents-live/services/external-transcript.service.js';

function row(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

test('reads model, context tokens, calls and last actions of a CLI transcript, then only what was appended', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kba-ext-'));
  const file = path.join(directory, 's.jsonl');
  try {
    fs.writeFileSync(file, [
      row({ type: 'user', message: { content: 'привет' } }),
      row({
        type: 'assistant',
        timestamp: '2026-10-26T14:00:00Z',
        message: {
          model: 'claude-opus-4-8',
          usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 90 },
          content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/srv/app/server/index.ts' } }],
        },
      }),
      row({
        type: 'assistant',
        isSidechain: true,
        message: { model: 'claude-haiku-4', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      }),
      'not json\n',
    ].join(''));
    const first = await readExternalTranscript(file, '/srv/app');
    assert.equal(first?.model, 'claude-opus-4-8');
    assert.equal(first?.tokens, 1100);
    assert.equal(first?.toolCalls, 1, 'sidechain calls belong to a subagent, not the dialog');
    assert.deepEqual(first?.recentActions.map((action) => [action.tool, action.text]), [['Read', 'server/index.ts']]);

    fs.appendFileSync(file, row({
      type: 'assistant',
      timestamp: '2026-10-26T14:01:00Z',
      message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 5, output_tokens: 5 },
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
      },
    }));
    const second = await readExternalTranscript(file, '/srv/app');
    assert.equal(second?.toolCalls, 2);
    assert.equal(second?.tokens, 10);
    assert.deepEqual(second?.recentActions.map((action) => action.text), ['npm test', 'server/index.ts']);
    assert.equal(await readExternalTranscript(path.join(directory, 'missing.jsonl'), null), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent reads of the same transcript fold appended rows once', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kba-ext-race-'));
  const file = path.join(directory, 's.jsonl');
  const toolRow = (id: string) => row({
    type: 'assistant',
    timestamp: '2026-10-26T14:00:00Z',
    message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } }] },
  });
  try {
    fs.writeFileSync(file, toolRow('a'));
    assert.equal((await readExternalTranscript(file, null))?.toolCalls, 1);

    fs.appendFileSync(file, toolRow('b') + toolRow('c'));
    // Two tabs subscribing at once both ask for the snapshot.
    const [first, second] = await Promise.all([readExternalTranscript(file, null), readExternalTranscript(file, null)]);
    assert.equal(first?.toolCalls, 3);
    assert.equal(second?.toolCalls, 3);
    assert.equal((await readExternalTranscript(file, null))?.toolCalls, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the transcript path stays inside the projects folder', () => {
  assert.equal(resolveClaudeTranscriptFile({ jsonl_path: '/x/y.jsonl', session_id: 's' }), '/x/y.jsonl');
  assert.equal(resolveClaudeTranscriptFile({ project_path: null, session_id: 's' }), null);
  const resolved = resolveClaudeTranscriptFile({ project_path: '/root/app', provider_session_id: 'abc', session_id: 's' });
  assert.ok(resolved?.endsWith(path.join('-root-app', 'abc.jsonl')));
});
