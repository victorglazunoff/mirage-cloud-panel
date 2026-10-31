import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { searchDialogsWithRipgrep } from '../search-ripgrep.js';

test('dialog search finds text with quotes and backslashes, which the transcript stores escaped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'search-rg-'));
  try {
    const text = 'выложи "Карту участков" в C:\\deploy и «Мираж»';
    const line = JSON.stringify({
      type: 'user', sessionId: 's-1', timestamp: '2026-10-28T10:00:00Z', cwd: '/root/p',
      message: { role: 'user', content: text },
    });
    await writeFile(path.join(root, 's-1.jsonl'), `${line}\n`, 'utf8');

    for (const query of ['"Карту участков"', 'C:\\deploy', '«Мираж»', 'карту']) {
      const { hits } = await searchDialogsWithRipgrep(query, { rootDir: root, maxHits: 10, deadlineMs: 5_000 });
      assert.equal(hits.length, 1, `no hit for ${query}`);
      assert.equal(hits[0].text, text);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
