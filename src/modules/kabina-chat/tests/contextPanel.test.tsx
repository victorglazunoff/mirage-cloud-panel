import assert from 'node:assert/strict';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { ContextPanel } from '@/modules/kabina-chat/ContextPanel';
import { shortProjectPath } from '@/modules/kabina-chat/utils/chatFormat';
import type { SessionContextUsage } from '@/shared/types';

afterEach(cleanup);

const USAGE: SessionContextUsage = {
  sessionId: 's1',
  source: 'transcript',
  estimated: false,
  detail: null,
  model: 'claude-haiku-4-5',
  totalTokens: 60_900,
  maxTokens: 200_000,
  percentage: 30.45,
  autoCompactThreshold: null,
  isAutoCompactEnabled: null,
  tokensUntilAutoCompact: null,
  categories: [
    { id: 'messages', name: 'Использовано', tokens: 60_900, percentage: 30.45, kind: 'used', color: null, items: [] },
    { id: 'free_space', name: 'Свободно', tokens: 139_100, percentage: 69.55, kind: 'free', color: null, items: [] },
  ],
  heavyMcpTools: [],
  heavySkills: [],
  memoryFiles: [],
  agents: [],
  files: [
    { path: '/p/data/villages.json', dir: 'data/', name: 'villages.json', tokens: 18_200 },
    { path: '/tmp/look/a.jpg', dir: '/tmp/look/', name: 'a.jpg', tokens: 0 },
  ],
  messageBreakdown: null,
  session: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, assistantTurns: 1, costUsd: null },
  compactQueued: false,
  cachedAt: new Date(0).toISOString(),
} as SessionContextUsage;

function renderPanel(isRunning: boolean, usage = USAGE) {
  return render(
    <ContextPanel
      usage={usage}
      error={null}
      hasSession
      variant="aside"
      modelLine={{ name: 'Haiku', meta: '200k · авто' }}
      onOpenFile={() => undefined}
      isRunning={isRunning}
    />,
  );
}

test('the cost during a live turn waits for its end instead of «нет живого хода»', () => {
  renderPanel(true);
  assert.ok(screen.getByText('посчитаю в конце хода'));
  assert.equal(screen.queryByText('нет живого хода'), null);
  cleanup();
  renderPanel(false);
  assert.ok(screen.getByText('нет живого хода'));
});

test('a known window is not marked as an estimate, and a file without a size shows none', () => {
  renderPanel(false);
  assert.ok(screen.getByText('занято · запас большой'));
  assert.ok(screen.getByText('60.9k / 200k'));
  const image = screen.getByRole('button', { name: /a\.jpg/ });
  assert.equal(image.textContent?.includes('0'), false);
  assert.ok(screen.getByRole('button', { name: /villages\.json 18\.2k/ }));
});

test('the project folder is short: ~/<folder>', () => {
  // The home is the one the server reported (here root's), or a /home/<user> guess before that.
  assert.equal(shortProjectPath('/root/work/My Projects/demo-site', '/root'), '~/demo-site');
  assert.equal(shortProjectPath('/home/alice/work/site/', null), '~/site');
  assert.equal(shortProjectPath('/home/alice/work/site/', '/root'), '…/site');
  assert.equal(shortProjectPath('/root', '/root'), '~');
  assert.equal(shortProjectPath('/srv/app'), '/srv/app');
  assert.equal(shortProjectPath('/tmp/claude-0/scratchpad/e2e-project'), '…/e2e-project');
});
