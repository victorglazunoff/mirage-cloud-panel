import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { resetUserPreferences } from '@/shared/userSettings';
import type { ProjectSession } from '@/shared/types';

/**
 * Mirage (Х7): the permission mode belongs to the dialog. A dialog that never
 * had its mode changed used to follow the provider-wide «last picked» key, so
 * choosing Auto in one dialog silently moved every such dialog to Auto.
 */

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
    },
  },
}));

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

const session = (id: string): ProjectSession => ({ id, __provider: 'claude' });

test('a dialog keeps the mode it opened with when another dialog picks a different one', async () => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const { result, rerender } = renderHook(
    ({ selected }: { selected: ProjectSession | null }) => useChatProviderState({ selectedSession: selected, selectedProject: null }),
    { initialProps: { selected: session('dialog-a') } },
  );
  await waitFor(() => assert.equal(result.current.permissionMode, 'default'));

  rerender({ selected: session('dialog-b') });
  act(() => result.current.selectPermissionMode('auto'));
  assert.equal(result.current.permissionMode, 'auto');

  rerender({ selected: session('dialog-a') });
  await waitFor(() => assert.equal(result.current.permissionMode, 'default'));
});

test('a new dialog keeps the mode chosen before its first message once its id arrives', async () => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const { result, rerender } = renderHook(
    ({ selected }: { selected: ProjectSession | null }) => useChatProviderState({ selectedSession: selected, selectedProject: null }),
    { initialProps: { selected: null as ProjectSession | null } },
  );
  act(() => result.current.selectPermissionMode('plan'));
  rerender({ selected: session('dialog-new') });
  await waitFor(() => assert.equal(result.current.permissionMode, 'plan'));
  assert.equal(localStorage.getItem('permissionMode-dialog-new'), 'plan');
});
