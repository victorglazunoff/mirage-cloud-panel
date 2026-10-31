import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent,MarkSessionIdle,MarkSessionProcessing,PendingPermissionRequest,ProjectSession,LLMProvider,NormalizedMessage,GetSessionActivity,MarkSessionBackground,SteerAck,TurnDispatchedAck } from '@/shared/types';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '@/shared/utils';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { collectRunningBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

/** Mirage: frames other modules send on the chat socket; none of them is a chat event. */
export function isForeignFrameKind(kind: unknown): boolean {
  return typeof kind === 'string' && kind.startsWith('agents_');
}

const hasActionablePermissionRequests =(requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /**
   * Kept for the callers' reset; Mirage buffers streamed text per session in
   * this hook instead (see `liveStreamsRef`).
   */
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  /** Reports the tasks a session still runs once its turn ends, so it reads as background work rather than idle. */
  onSessionBackground?: MarkSessionBackground;
  getSessionActivity?: GetSessionActivity;
  onWebSocketReconnect?: () => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
  /** The server accepted a steer: the composer shows it in the transcript as a user message tagged "steered". */
  onSteered?: (ack: SteerAck) => void;
  /** The server refused a steer (STEER_UNAVAILABLE): the composer queues or re-sends that steer (by steerId when the server names it). */
  onSteerUnavailable?: (sessionId: string, steerId?: string) => void;
  /** Mirage: the server sent a queued or scheduled message as a new turn; the composer drops the queued card and shows the message. `seq` de-duplicates replays. */
  onTurnDispatched?: (ack: TurnDispatchedAck, seq?: number) => void;
};

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onSessionBackground,
  getSessionActivity,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
  onSteered,
  onSteerUnavailable,
  onTurnDispatched,
}: UseChatRealtimeHandlersArgs) {
  // Read through refs so a new callback identity never resubscribes the
  // websocket listener below.
  const onSteeredRef = useRef(onSteered);
  onSteeredRef.current = onSteered;
  const onSteerUnavailableRef = useRef(onSteerUnavailable);
  onSteerUnavailableRef.current = onSteerUnavailable;
  const onTurnDispatchedRef = useRef(onTurnDispatched);
  onTurnDispatchedRef.current = onTurnDispatched;
  // `chat_steered` frames already handled, for a server that sends no steerId
  // (see the handler below). Lives as long as the chat view.
  const seenSteeredFramesRef = useRef(new Set<string>());
  // Mirage: streamed text not yet written to the store, per session.
  const liveStreamsRef = useRef(new Map<string, { text: string; timer: number | null }>());

  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    // What a session that has finished responding is left with: the tasks it
    // launched that are still running, or nothing, which marks it idle. The
    // store's records are what the transcript's cards fold their live status
    // from, so this reads the same answer they draw.
    const reportRemainingBackgroundWork = (sid: string) => {
      onSessionBackground?.(sid, collectRunningBackgroundTasks(normalizedToChatMessages(sessionStore.getMessages(sid))));
    };

    const liveStreams = liveStreamsRef.current;
    // Writes a session's buffered stream to the store and forgets it; true when there was text.
    const flushLiveStream = (sid: string): boolean => {
      const stream = liveStreams.get(sid);
      if (!stream) return false;
      if (stream.timer !== null) window.clearTimeout(stream.timer);
      liveStreams.delete(sid);
      if (!stream.text) return false;
      sessionStore.updateStreaming(sid, stream.text, provider);
      return true;
    };

    const handleEvent = (msg: ServerEvent) => {
      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // `chat.steered` acknowledges a message steered into a running turn. The
      // contract names it by `type`; accept the gateway-style `kind` too. It is
      // sequenced like any live frame, so its seq is recorded first — a
      // reconnect then does not ask for it again. A frame seen before (a replay)
      // is dropped so it never adds a second bubble: by its steerId in the
      // composer, and here by session + seq + text for a server that sends no
      // steerId. Seq alone is not enough: it restarts with every run.
      if (
        msg.type === 'chat.steered'
        || msg.kind === 'chat.steered'
        || msg.kind === 'chat_steered'
      ) {
        const steeredSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
        if (!steeredSessionId || typeof msg.content !== 'string') {
          return;
        }
        const steerId = typeof msg.steerId === 'string' && msg.steerId ? msg.steerId : undefined;
        if (typeof msg.seq === 'number') {
          const known = lastSeqRef.current.get(steeredSessionId) ?? 0;
          if (msg.seq > known) {
            lastSeqRef.current.set(steeredSessionId, msg.seq);
          }
          if (!steerId) {
            const replayKey = `${steeredSessionId}\u0000${msg.seq}\u0000${msg.content}`;
            if (seenSteeredFramesRef.current.has(replayKey)) {
              return;
            }
            seenSteeredFramesRef.current.add(replayKey);
          }
        }
        onSteeredRef.current?.({
          sessionId: steeredSessionId,
          content: msg.content,
          at: typeof msg.at === 'string' ? msg.at : undefined,
          steerId,
          attachments: Array.isArray(msg.attachments) ? msg.attachments : undefined,
        });
        return;
      }

      if (!msg.kind) {
        return;
      }

      // Mirage: a steered message missed its turn and ran as a request of its own — history
      // shows it as a plain message, so its live echo drops «вклинено» too.
      if (msg.kind === 'chat_steer_new_turn') {
        if (typeof msg.sessionId === 'string' && typeof msg.steerId === 'string' && msg.steerId) {
          sessionStore.unmarkSteered(msg.sessionId, msg.steerId);
        }
        return;
      }

      // Mirage: the live-agents panel shares this socket (`agents_snapshot`,
      // `agents_delta`, `agents_action_result`). Those frames carry no chat row
      // and no session id, so the fallback below filed them under the viewed
      // dialog as rows without an id — and every later merge of that dialog
      // threw, leaving its feed empty while a turn ran.
      if (isForeignFrameKind(msg.kind)) {
        return;
      }

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'turn_dispatched': {
          // Mirage: the server started a turn for a queued or scheduled
          // message. It opens the run's stream, so this tab shows the turn as
          // its own send would: the session is busy, the message is in the
          // transcript and the queued card is gone.
          if (!sid || typeof msg.content !== 'string') {
            return;
          }
          onSessionProcessing?.(sid);
          onTurnDispatchedRef.current?.(
            {
              sessionId: sid,
              content: msg.content,
              at: typeof msg.at === 'string' ? msg.at : undefined,
              origin: typeof msg.origin === 'string' ? msg.origin : undefined,
              attachments: Array.isArray(msg.attachments) ? msg.attachments : undefined,
            },
            typeof msg.seq === 'number' ? msg.seq : undefined,
          );
          return;
        }

        case 'history_truncated': {
          // An already-sent message was replaced. Every client watching this
          // session drops the superseded turns before the replacement streams
          // in, so a second tab does not end up showing the question twice.
          if (sid && typeof msg.anchorId === 'string') {
            sessionStore.truncateAt(sid, msg.anchorId);
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          // A refused steer says nothing about the run itself: it keeps going,
          // and the composer re-queues the message for after the turn.
          if (msg.code === 'STEER_UNAVAILABLE') {
            if (sid) {
              onSteerUnavailableRef.current?.(
                sid,
                typeof msg.steerId === 'string' && msg.steerId ? msg.steerId : undefined,
              );
            }
            return;
          }
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            // A refused stop request is not about the run: the task had
            // already settled, and idling here would drop a response in
            // flight on that session.
            if (msg.code !== 'NO_SUCH_TASK' && msg.code !== 'TASK_ID_REQUIRED') {
              onSessionIdle?.(sid);
            }
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffer for performance ---
      // Mirage: one buffer per session. A single shared buffer mixed the text
      // of two dialogs streaming at once (one open, one in the background), and
      // every raw delta of a background dialog also landed as its own row.
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text || !sid) return;
        const stream = liveStreams.get(sid) ?? { text: '', timer: null };
        liveStreams.set(sid, stream);
        stream.text += text;
        if (stream.timer === null) {
          stream.timer = window.setTimeout(() => {
            stream.timer = null;
            sessionStore.updateStreaming(sid, stream.text, provider);
          }, 100);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid) {
          flushLiveStream(sid);
          sessionStore.finalizeStreaming(sid);
        }
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_resolved'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state
          if (sid && flushLiveStream(sid)) {
            sessionStore.finalizeStreaming(sid);
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so the entry changes
          // immediately and atomically: a turn that ended with tasks still
          // running leaves the session as background work — the CLI is held
          // open for them — and any other leaves it idle. An abort releases
          // the CLI and takes that work down with it.
          if (sid && !msg.aborted) {
            reportRemainingBackgroundWork(sid);
          } else {
            onSessionIdle?.(sid);
          }
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. Mirage:
            // the transcript gets its quiet "stopped" mark now; the one the
            // CLI records replaces it on the next history load.
            if (sid) {
              sessionStore.appendRealtime(sid, {
                id: `turn_stopped_${Date.now()}`,
                sessionId: sid,
                timestamp: new Date().toISOString(),
                provider,
                kind: 'turn_stopped',
              } as NormalizedMessage);
            }
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        // `permission_resolved` arrives when any client answers the prompt: it
        // retracts a replayed `permission_request` after a mid-run refresh and
        // clears the prompt in other tabs watching the same run.
        case 'permission_resolved':
        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            // The counter shows the viewed session's context; budgets from
            // other concurrently running sessions must not overwrite it.
            if (sid === activeViewSessionId) {
              setTokenBudget(msg.tokenBudget as Record<string, unknown>);
            }
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        case 'task_status': {
          // A task's notification, or the patch that killed it, can leave a
          // session that was only doing background work with nothing left
          // to do. A turn in flight is left alone: its `complete` reports.
          if (
            sid
            && (msg.event === 'notification' || msg.event === 'updated')
            && getSessionActivity?.(sid)?.background
          ) {
            reportRemainingBackgroundWork(sid);
          }
          // The notification carries only a summary; the task's actual result
          // is folded onto its card by the history reader, so a card that
          // just settled live shows it only after a sync — the same sync a
          // turn's `complete` triggers. Without it the result waited for a
          // manual reload.
          if (sid && sid === activeViewSessionId && msg.event === 'notification') {
            void requestLatestMessages(sid, isActiveRef.current);
          }
          break;
        }

        // text, tool_use, tool_result, thinking, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onSessionBackground,
    getSessionActivity,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}
