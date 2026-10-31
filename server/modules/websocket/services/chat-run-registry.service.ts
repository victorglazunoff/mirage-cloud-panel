import { sessionsDb } from '@/modules/database/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

/**
 * Mirage: the sockets that have a session open, keyed by app session id.
 *
 * A run's writer used to know only the socket that started it and the ones
 * that subscribed while it was running. A turn the server starts on its own —
 * a queued message sent the moment the previous turn ended, a scheduled one —
 * has no starting socket, so the tab showing that session heard nothing about
 * it until something made it send `chat.subscribe` again (a sidebar refresh,
 * seconds later), and then replayed only events above a `lastSeq` left over
 * from the previous run. Every new run now starts with this audience.
 *
 * A socket watches the sessions named in its latest `chat.subscribe` (a tab
 * subscribes to the session it opens) and any session it sends a turn to.
 */
const sessionWatchers = new Map<string, Set<RealtimeClientConnection>>();

/** The reverse index of `sessionWatchers`, so a new subscribe can drop the sessions a socket left. */
const watchedSessionsByConnection = new Map<RealtimeClientConnection, Set<string>>();

/**
 * Mirage: the last `seq` handed out per session, across its runs. A client
 * keeps the highest seq it saw per session and sends it back on reconnect;
 * when every run started again at 1, a reconnect during the session's next run
 * asked for events above the previous run's last seq and got none of them.
 */
const lastSeqBySession = new Map<string, number>();

/**
 * Mirage: completed runs whose writer is sending, right now, the aborted
 * `complete` for a turn the CLI ran after the run ended (see `reportStopped`).
 */
const lateStopReports = new WeakSet<ChatRun>();

function addSessionWatcher(appSessionId: string, connection: RealtimeClientConnection): void {
  let watchers = sessionWatchers.get(appSessionId);
  if (!watchers) {
    watchers = new Set();
    sessionWatchers.set(appSessionId, watchers);
  }
  watchers.add(connection);

  let watched = watchedSessionsByConnection.get(connection);
  if (!watched) {
    watched = new Set();
    watchedSessionsByConnection.set(connection, watched);
  }
  watched.add(appSessionId);
}

function removeSessionWatcher(appSessionId: string, connection: RealtimeClientConnection): void {
  const watchers = sessionWatchers.get(appSessionId);
  if (watchers) {
    watchers.delete(connection);
    if (watchers.size === 0) {
      sessionWatchers.delete(appSessionId);
    }
  }
  const watched = watchedSessionsByConnection.get(connection);
  if (watched) {
    watched.delete(appSessionId);
    if (watched.size === 0) {
      watchedSessionsByConnection.delete(connection);
    }
  }
}

/** The open sockets watching a session; closed ones are forgotten on the way. */
function readOpenWatchers(appSessionId: string): RealtimeClientConnection[] {
  const open: RealtimeClientConnection[] = [];
  for (const connection of sessionWatchers.get(appSessionId) ?? []) {
    if (connection.readyState === WS_OPEN_STATE) {
      open.push(connection);
    } else {
      removeSessionWatcher(appSessionId, connection);
    }
  }
  return open;
}

/**
 * Answers whether a completed run must stay registered a while longer. Set by
 * the composition root to the provider runtimes' background-work check: a
 * session whose turn ended but whose agents, workflows or commands are still
 * running keeps sending live events through this run's writer, and a tab that
 * subscribes meanwhile needs the run to attach to.
 */
let retainCompletedRun: (appSessionId: string) => boolean = () => false;

/**
 * Mirage (Х3, Б6): told about every run whose terminal `complete` just went
 * out, unless the run was aborted. Set by the scheduled-messages dispatcher so
 * a queued turn goes the moment its session's turn ends instead of on the
 * next poll. A Stop is not a turn ending: the stopped process may still be
 * winding down, so the queue waits for the regular poll there.
 */
let onRunCompleted: (appSessionId: string) => void = () => {};

/**
 * Mirage: observers of every live event a run puts on the wire, after its
 * `sessionId` was remapped to the app id. The Artifacts module watches for
 * `Artifact` results here to keep a copy of each publish. Called
 * synchronously and in order (a `tool_use` is seen before its result), so a
 * listener must only record and defer — never block or throw into the stream.
 */
const liveEventListeners = new Set<(appSessionId: string, event: NormalizedMessage) => void>();

function notifyLiveEventListeners(appSessionId: string, event: NormalizedMessage): void {
  for (const listener of liveEventListeners) {
    try {
      listener(appSessionId, event);
    } catch (error) {
      console.error('[ChatRunRegistry] Live event listener failed', {
        appSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Schedules one run's eviction. The timer is bound to the run it was armed
 * for: a later run can take the session's slot while this one's retention —
 * re-armed for as long as the guard holds — is still pending, and firing on
 * the slot alone would evict that newer run early.
 */
function evictRunLater(run: ChatRun): void {
  const timer = setTimeout(() => {
    if (runs.get(run.appSessionId) !== run || run.status !== 'completed') {
      return;
    }
    if (retainCompletedRun(run.appSessionId)) {
      evictRunLater(run);
      return;
    }
    runs.delete(run.appSessionId);
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  // Mirage: except the one `reportStopped` sends for a turn after the run.
  const lateStop = lateStopReports.has(run);
  if (message.kind === 'complete' && run.status === 'completed' && !lateStop) {
    return null;
  }

  run.lastSeq += 1;
  lastSeqBySession.set(run.appSessionId, run.lastSeq);

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    if (!lateStop) {
      run.status = 'completed';
      run.completedAt = Date.now();
      evictRunLater(run);
    }
  }

  if (message.kind === 'complete' && message.aborted !== true) {
    // After the frame is out and the caller's stack has unwound, so the
    // listener sees the session idle and can start its next run.
    const appSessionId = run.appSessionId;
    setImmediate(() => {
      try {
        onRunCompleted(appSessionId);
      } catch (error) {
        console.error('[ChatRunRegistry] Run-completed listener failed', {
          appSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  notifyLiveEventListeners(run.appSessionId, outbound);
  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastSessionUpserted(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /** Installs the check that keeps a completed run registered while its session still has background work. */
  setRetentionGuard(guard: (appSessionId: string) => boolean): void {
    retainCompletedRun = guard;
  },

  /** Mirage (Х3): installs the listener told when a run's terminal (non-aborted) `complete` went out. */
  setRunCompletedListener(listener: (appSessionId: string) => void): void {
    onRunCompleted = listener;
  },

  /**
   * Mirage: subscribes to every live event of every run (see
   * `liveEventListeners`). Returns the unsubscribe function.
   */
  addLiveEventListener(listener: (appSessionId: string, event: NormalizedMessage) => void): () => void {
    liveEventListeners.add(listener);
    return () => {
      liveEventListeners.delete(listener);
    };
  },

  /**
   * Mirage: sends one extra event into a session's run, so it gets a `seq`, is
   * replayed on reconnect and reaches every tab watching the session. Returns
   * `false` when the session has no registered run (nothing live to join).
   */
  publishToRun(appSessionId: string, event: NormalizedMessage): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }
    run.writer.send(event);
    return true;
  },

  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /**
     * The socket that asked for this run, or `null` for one nobody is watching
     * — a scheduled message fires with no browser attached. The writer's event
     * buffer still records everything, so a client that subscribes later
     * replays the run from its start.
     */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      // Continues the session's numbering instead of restarting at 0, so a
      // client's `lastSeq` from an earlier run never hides this run's events.
      lastSeq: lastSeqBySession.get(input.appSessionId) ?? existing?.lastSeq ?? 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    // Every tab that has the session open hears the run from its first
    // event, whoever started it — the server included.
    for (const watcher of readOpenWatchers(input.appSessionId)) {
      run.writer.updateWebSocket(watcher);
    }
    if (input.connection) {
      addSessionWatcher(input.appSessionId, input.connection);
    }

    runs.set(input.appSessionId, run);
    return run;
  },

  /**
   * Mirage: makes `sessionIds` the sessions a socket has open, replacing what
   * it watched before (a tab subscribes to the session it switches to). The
   * chat websocket calls it on every `chat.subscribe`.
   */
  watchSessions(connection: RealtimeClientConnection, sessionIds: string[]): void {
    const next = new Set(sessionIds);
    for (const previous of [...(watchedSessionsByConnection.get(connection) ?? [])]) {
      if (!next.has(previous)) {
        removeSessionWatcher(previous, connection);
      }
    }
    for (const sessionId of next) {
      addSessionWatcher(sessionId, connection);
    }
  },

  /** Mirage: forgets a closed socket everywhere it watched. Called by the chat websocket on `close`. */
  forgetConnection(connection: RealtimeClientConnection): void {
    for (const sessionId of [...(watchedSessionsByConnection.get(connection) ?? [])]) {
      removeSessionWatcher(sessionId, connection);
    }
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  /**
   * Adds a websocket connection to a run's live audience.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   *
   * Subscribing does not take the stream away from sockets that were already
   * watching — a session open in two places stays live in both, and the
   * refreshed tab's abandoned socket is dropped when the next event finds it
   * closed. Replay stays per-connection because each client sends its own
   * `lastSeq` with `chat.subscribe`.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Mirage: tells every tab watching the session that its turn was stopped —
   * an aborted `complete` through the session's run, even when that run
   * already completed: the turn the CLI runs on its own after the client's
   * turn (a background task reporting back) streams through the completed
   * run's writer, and a Stop of it needs its terminal event the same way.
   * Returns false when the session has no registered run at all.
   */
  reportStopped(appSessionId: string): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }
    if (run.status === 'running') {
      run.writer.sendComplete({ exitCode: 0, aborted: true });
      return true;
    }
    lateStopReports.add(run);
    try {
      run.writer.sendComplete({ exitCode: 0, aborted: true });
    } finally {
      lateStopReports.delete(run);
    }
    return true;
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
    sessionWatchers.clear();
    watchedSessionsByConnection.clear();
    lastSeqBySession.clear();
  },
};
