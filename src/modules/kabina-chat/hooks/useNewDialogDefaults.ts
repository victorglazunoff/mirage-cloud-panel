import { useEffect, useRef } from 'react';

import type { useChatController } from '@/modules/chat';
import { useMirageSettingsView } from '@/shared/hooks/useMirageSettingsView';
import type { PermissionMode } from '@/shared/types';

type ChatController = ReturnType<typeof useChatController>;

type NewDialogDefaultsArgs = {
  chat: ChatController;
  /** True only for a brand-new dialog (`/p/:projectId` without a session). */
  isNewDialog: boolean;
  /** Changes every time a new dialog is opened (project + new-session trigger), so each one gets the defaults once. */
  dialogKey: string;
};

/**
 * Used by the kabina-chat screen: applies the Claude defaults from settings
 * («Claude по умолчанию»: model, effort, permission mode and «сообщение во
 * время хода: вклинить / в очередь») to the composer of a new dialog — once per
 * new dialog, so a choice made in it afterwards stays. An open session keeps
 * whatever it already uses: its model and effort come from the server, its
 * permission mode from its own record.
 */
export function useNewDialogDefaults({ chat, isNewDialog, dialogKey }: NewDialogDefaultsArgs): void {
  const view = useMirageSettingsView();
  const { provider: providerState, composer, selectModel, selectEffort, activeSessionId } = chat;
  const { provider, currentProviderModelOptions, availablePermissionModes, selectPermissionMode } = providerState;
  const { setSteerMode } = composer;
  // The new dialog the defaults were last applied to; null once a session is open again.
  const appliedForRef = useRef<string | null>(null);
  const catalogReady = currentProviderModelOptions.length > 0;

  useEffect(() => {
    if (!isNewDialog) {
      appliedForRef.current = null;
      return;
    }
    // Only Claude has these settings; wait for the settings and the model list.
    if (provider !== 'claude' || !view || !catalogReady || appliedForRef.current === dialogKey) return;
    // The address already says «new dialog», but for a render or two the chat still holds
    // the dialog it came from: a model or effort chosen now would be recorded against that
    // session on the server and silently change its model. Wait until it lets go.
    if (activeSessionId) return;
    appliedForRef.current = dialogKey;

    const defaults = view.settings.claude;
    if (currentProviderModelOptions.some((option) => option.value === defaults.model)) {
      void selectModel(defaults.model);
    }
    void selectEffort(defaults.effort);
    if ((availablePermissionModes as PermissionMode[]).includes(defaults.permissionMode)) {
      selectPermissionMode(defaults.permissionMode);
    }
    setSteerMode(defaults.midTurnMessage === 'queue' ? 'after' : 'now');
  }, [
    activeSessionId,
    availablePermissionModes,
    catalogReady,
    currentProviderModelOptions,
    dialogKey,
    isNewDialog,
    provider,
    selectEffort,
    selectModel,
    selectPermissionMode,
    setSteerMode,
    view,
  ]);
}
