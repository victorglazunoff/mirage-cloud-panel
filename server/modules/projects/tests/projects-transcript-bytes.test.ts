import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTranscriptBytes } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

test('readTranscriptBytes returns the transcript file size', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'transcript-bytes-'));
  try {
    const file = path.join(directory, 'session.jsonl');
    writeFileSync(file, 'x'.repeat(1234));
    assert.equal(readTranscriptBytes(file), 1234);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('readTranscriptBytes returns null without a path or for a missing file', () => {
  assert.equal(readTranscriptBytes(null), null);
  assert.equal(readTranscriptBytes(undefined), null);
  assert.equal(readTranscriptBytes('/definitely/not/here.jsonl'), null);
});
