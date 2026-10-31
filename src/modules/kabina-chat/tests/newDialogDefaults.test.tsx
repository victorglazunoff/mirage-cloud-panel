import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { useNewDialogDefaults } from '@/modules/kabina-chat/hooks/useNewDialogDefaults';
import { publishMirageSettingsView } from '@/shared/hooks/useMirageSettingsView';
import type { MirageSettingsView } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: { mirageSettings: { get: vi.fn(async () => new Response('{}', { status: 500 })) } },
  readApiJson: async () => {
    throw new Error('offline');
  },
}));

function settingsView(claude: Partial<MirageSettingsView['settings']['claude']>): MirageSettingsView {
  return {
    settings: {
      claude: {
        permissionMode: 'auto', model: 'sonnet', effort: 'medium', artifacts: true, workflows: true,
        silenceCeilingMin: 30, midTurnMessage: 'queue', ...claude,
      },
    },
    claudeSettings: { path: '/home/user/.claude/settings.json', exists: true, readable: true, error: null },
    server: { homeDir: '/home/user', isRoot: false },
    savedAt: null,
  } as unknown as MirageSettingsView;
}

function fakeChat() {
  return {
    provider: {
      provider: 'claude',
      currentProviderModelOptions: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }],
      availablePermissionModes: ['default', 'auto', 'plan', 'acceptEdits'],
      selectPermissionMode: vi.fn(),
    },
    composer: { setSteerMode: vi.fn() },
    selectModel: vi.fn(async () => undefined),
    selectEffort: vi.fn(async () => undefined),
  };
}

type Chat = Parameters<typeof useNewDialogDefaults>[0]['chat'];

afterEach(() => {
  publishMirageSettingsView(null);
});

test('a new dialog starts from the Claude defaults in settings', () => {
  publishMirageSettingsView(settingsView({}));
  const chat = fakeChat();
  renderHook(() => useNewDialogDefaults({ chat: chat as unknown as Chat, isNewDialog: true, dialogKey: 'p:0' }));
  assert.deepEqual(chat.selectModel.mock.calls, [['sonnet']]);
  assert.deepEqual(chat.selectEffort.mock.calls, [['medium']]);
  assert.deepEqual(chat.provider.selectPermissionMode.mock.calls, [['auto']]);
  assert.deepEqual(chat.composer.setSteerMode.mock.calls, [['after']], '«в очередь» → после хода');
});

test('the defaults land once per new dialog, so a choice made in it stays', () => {
  publishMirageSettingsView(settingsView({ midTurnMessage: 'inject' }));
  const chat = fakeChat();
  const { rerender } = renderHook((props: { isNew: boolean; key: string }) => useNewDialogDefaults({
    chat: chat as unknown as Chat, isNewDialog: props.isNew, dialogKey: props.key,
  }), { initialProps: { isNew: true, key: 'p:0' } });
  assert.deepEqual(chat.composer.setSteerMode.mock.calls, [['now']], '«вклинить» → сейчас');

  // Settings saved again while the dialog is open: nothing is re-applied.
  act(() => publishMirageSettingsView(settingsView({ model: 'opus' })));
  rerender({ isNew: true, key: 'p:0' });
  assert.equal(chat.selectModel.mock.calls.length, 1);

  // An open session is never touched; the next new dialog gets the defaults again.
  rerender({ isNew: false, key: 'p:0' });
  assert.equal(chat.selectModel.mock.calls.length, 1);
  rerender({ isNew: true, key: 'p:1' });
  assert.deepEqual(chat.selectModel.mock.calls.at(-1), ['opus']);
});

test('nothing happens before settings load, for other providers or for an unknown model', () => {
  const chat = fakeChat();
  const { rerender } = renderHook(() => useNewDialogDefaults({ chat: chat as unknown as Chat, isNewDialog: true, dialogKey: 'p:0' }));
  assert.equal(chat.selectEffort.mock.calls.length, 0, 'no settings yet');

  act(() => publishMirageSettingsView(settingsView({ model: 'claude-unknown-9' })));
  rerender();
  assert.equal(chat.selectModel.mock.calls.length, 0, 'a model the catalog does not offer is skipped');
  assert.equal(chat.selectEffort.mock.calls.length, 1);

  const codex = fakeChat();
  codex.provider.provider = 'codex';
  renderHook(() => useNewDialogDefaults({ chat: codex as unknown as Chat, isNewDialog: true, dialogKey: 'p:0' }));
  assert.equal(codex.selectEffort.mock.calls.length, 0);
});

test('the dialog left behind keeps its model: defaults wait until the chat lets go of it', () => {
  publishMirageSettingsView(settingsView({ model: 'opus', effort: 'high' }));
  // «Новый диалог» from an open session: the address is new, the chat still holds the old id
  // (selectModel / selectEffort would record the defaults against that session on the server).
  const chat = { ...fakeChat(), activeSessionId: 'old-session' as string | null };
  const { rerender } = renderHook(() => useNewDialogDefaults({ chat: chat as unknown as Chat, isNewDialog: true, dialogKey: 'p:1' }));
  assert.equal(chat.selectModel.mock.calls.length, 0, 'not while the old session is still active');
  assert.equal(chat.selectEffort.mock.calls.length, 0);

  chat.activeSessionId = null;
  rerender();
  assert.deepEqual(chat.selectModel.mock.calls, [['opus']], 'applied to the new, empty dialog');
  assert.deepEqual(chat.selectEffort.mock.calls, [['high']]);
});
