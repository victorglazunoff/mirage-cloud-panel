import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import type {
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';

type UseChatControllerArgs = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean | void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
};

/**
 * Used by the kabina-chat module (the «Кабина» chat screen) to run a project
 * session's chat without the authors' markup. It wires the provider, session,
 * composer and realtime hooks exactly the way ChatInterface does — same
 * arguments, same reconnect re-subscribe — so steering, the queue, hold-to-stop
 * and permission prompts behave identically; only the rendering differs.
 * Returns every piece of state and every handler a screen needs.
 */
export function useChatController({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
}: UseChatControllerArgs) {
  const { subscribe } = useWebSocket();
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
    markSessionBackground: onSessionBackground,
    getSessionActivity,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // Same bookkeeping as ChatInterface: when each `chat.subscribe` was sent and
  // the highest live `seq` seen, so replays after a reconnect are exact.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const providerState = useChatProviderState({ selectedSession, selectedProject });
  const {
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
    pendingPermissionRequests,
    selectProviderModel,
    selectProviderEffort,
  } = providerState;

  const sessionState = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });
  const {
    addMessage,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    tokenBudget,
    setTokenBudget,
    scrollToBottom,
    setIsUserScrolledUp,
    requestLatestMessages,
  } = sessionState;

  // A brand-new conversation gets its id before the first send; record it and
  // put it in the address (as ChatInterface does).
  const handleSessionEstablished = useCallback((sessionId: string, context: SessionEstablishedContext) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const composerState = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });
  const {
    handleSteerConnectionRestored,
    handleSteered,
    handleSteerUnavailable,
    handleTurnDispatched,
  } = composerState;

  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) {
      handleSteerConnectionRestored();
      return;
    }
    await requestLatestMessages(selectedSession.id, isActive);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
    handleSteerConnectionRestored();
  }, [handleSteerConnectionRestored, isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onSessionBackground,
    getSessionActivity,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
    onSteered: handleSteered,
    onSteerUnavailable: handleSteerUnavailable,
    onTurnDispatched: handleTurnDispatched,
  });

  useEffect(() => () => resetStreamingState(), [resetStreamingState]);

  const activeSessionId = currentSessionId || selectedSession?.id || null;

  const selectModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, activeSessionId);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [activeSessionId, provider, selectProviderModel]);

  const selectEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, activeSessionId);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [activeSessionId, provider, selectProviderEffort]);

  return useMemo(() => ({
    provider: providerState,
    session: sessionState,
    composer: composerState,
    activeSessionId,
    selectModel,
    selectEffort,
  }), [activeSessionId, composerState, providerState, selectEffort, selectModel, sessionState]);
}
