import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

//----------------- HTTP RESPONSE SHAPES ------------
/**
 * Canonical success envelope used by backend APIs that return a structured payload.
 *
 * Use this for route handlers that need a stable `success/data` shape so frontend
 * consumers can parse responses consistently across endpoints.
 */
export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

/**
 * Generic plain-object record used when parsing loosely typed JSON payloads.
 *
 * Use this only after runtime shape checks, not as a replacement for validated
 * domain models.
 */
export type AnyRecord = Record<string, any>;

// ---------------------------
//----------------- WEBSOCKET TRANSPORT TYPES ------------
/**
 * Minimal websocket client contract used by backend broadcaster services.
 *
 * Any transport object added to `connectedClients` must implement these two
 * members so shared services can safely send JSON strings and check whether the
 * socket is still open before broadcasting.
 */
export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
};

/**
 * Authenticated user payload attached to websocket upgrade requests.
 *
 * Platform and OSS auth flows currently use either `id` or `userId`; both are
 * represented here so websocket handlers can resolve a stable writer user id.
 */
export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

/**
 * HTTP upgrade request shape after websocket authentication succeeds.
 *
 * `verifyClient` populates `request.user` with the authenticated payload, and
 * downstream websocket handlers rely on this extended request type.
 */
export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

// ---------------------------
//----------------- PROVIDER MESSAGE MODEL ------------
/**
 * Providers supported by the unified server runtime.
 *
 * Use this as the source of truth whenever a function or payload needs to identify
 * a specific LLM integration.
 */
export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';

/**
 * One selectable model row in a provider model catalog.
 */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  /** Stable SQLite row id used only by model-management actions. */
  recordId?: number;
  /** True for user-created rows; false for immutable CloudCLI defaults. */
  isCustom?: boolean;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

/**
 * Provider model catalog returned by `GET /api/providers/:provider/models`.
 */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
  /**
   * Reasoning-effort levels a custom entry of this catalog may declare, weakest
   * first; empty for providers without effort support. The Providers service
   * sets it on merged catalogs from the capability matrix, so the model
   * library offers the same levels on every machine. Adapter catalogs omit it.
   */
  EFFORT_LEVELS?: string[];
  /**
   * The user's "use only my models" flag for this provider, set by the
   * Providers service on merged catalogs. While it is true and at least one
   * custom model exists, `OPTIONS` holds only custom models and `DEFAULT` is
   * the first of them; with no custom models the built-ins are listed anyway.
   * Adapter catalogs omit it.
   */
  CUSTOM_MODELS_ONLY?: boolean;
};

/**
 * One persisted custom-model row in the provider model library.
 *
 * Provider modules use this shape at the database boundary. Predefined models
 * never use this type because they remain source-controlled in provider
 * adapters. `modelId` is sent to the provider runtime, while `model` is the
 * user-supplied display name shown in pickers.
 */
export type CustomProviderModelRecord = {
  recordId: number;
  provider: LLMProvider;
  modelId: string;
  model: string;
  sortOrder: number;
  /** NULL for rows that never declared effort levels, including pre-existing rows. */
  effort: CustomProviderModelEffort | null;
};

/**
 * Reasoning-effort levels a user declared for one custom model.
 *
 * `values` holds unique, non-empty level ids drawn from the levels the
 * provider's predefined models declare, and is never empty (an empty
 * declaration is stored as NULL). `default`, when present, is one of `values`
 * and documents the level the provider applies when the composer sends
 * `Default`, mirroring `ProviderModelOption['effort'].default`.
 */
export type CustomProviderModelEffort = {
  values: string[];
  default?: string;
};

/**
 * User-editable values accepted when creating or changing a custom model.
 *
 * `id` must be the exact provider-facing model identifier and cannot contain
 * whitespace. `model` is a concise display name. The provider is supplied by
 * the route path so a row can never be moved across providers accidentally.
 */
export type CustomProviderModelInput = {
  id: string;
  model: string;
  /**
   * Optional reasoning-effort declaration. `undefined` leaves stored metadata
   * untouched on update (and stores none on create) so clients that predate
   * effort metadata keep working; `null` clears it.
   */
  effort?: CustomProviderModelEffort | null;
};

// ---------------------------
//----------------- PROVIDER ACTIVE MODEL TYPES ------------
/**
 * Provider-neutral result for the model that is actively driving a session or
 * provider runtime at the time of lookup.
 *
 * `model` must always be populated. Provider adapters should use the
 * provider-specific lookup method requested by the caller, and only fall back
 * to the provider catalog `DEFAULT` value when the active model cannot be read.
 */
export type ProviderCurrentActiveModel = {
  model: string;
};

/**
 * Where a resolved session model came from.
 *
 * `session` means the app has recorded a model for this session (the user
 * picked one, or the session has been sent on at least once) and that value is
 * authoritative. `provider` means the session predates any app-recorded model
 * and the value was read back from the provider's own session state — the case
 * for sessions started directly in a provider CLI. `default` means neither was
 * available and the catalog default is standing in.
 *
 * Routes surface this so the frontend can tell a real selection apart from a
 * placeholder without re-deriving the precedence chain.
 */
export type ProviderSessionModelSource = 'session' | 'provider' | 'default';

/**
 * The model one session runs with, its persisted reasoning effort when one has
 * been recorded, and where the model answer came from.
 *
 * Returned by `providerModelsService.resolveSessionModel` and used by the
 * `/models`, `/cost` and `/status` commands, the active-model route, and the
 * composer's model picker so every surface agrees on one answer.
 */
export type ProviderSessionModel = {
  provider: LLMProvider;
  sessionId: string | null;
  model: string;
  /** NULL means this session has not recorded an effort choice yet. */
  effort: string | null;
  source: ProviderSessionModelSource;
};

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 */
export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_resolved'
  | 'permission_cancelled'
  | 'session_created'
  | 'history_truncated'
  // Mirage (Х1): a message folded into the running turn (`chat.steer`). Carries
  // `content`, `at` and the client's `steerId` when it sent one; sent through
  // the run's writer so every tab and a replay see it.
  | 'chat_steered'
  // Mirage: a steered message missed the turn it was written into and ran as a turn of its
  // own (history shows it as a plain message). Carries the client's `steerId`.
  | 'chat_steer_new_turn'
  // Mirage: a queued or scheduled message was just sent as a new turn by the
  // server (no tab sent it). Carries the user's `content`, `attachments`, `at`
  // and `origin` ('queue' | 'schedule'); it opens the run's stream, so every
  // tab watching the session shows the message and the turn at once.
  | 'turn_dispatched'
  // Mirage: the turn was stopped by the user. History marks where; the client
  // adds the same mark live when a turn ends with `aborted`.
  | 'turn_stopped'
  | 'task_notification'
  | 'task_status'
  // Mirage: the API call failed and Claude Code will retry it (the SDK's live
  // `system/api_retry`). Carries `apiRetry`; never in the transcript, so the
  // client shows «Claude не ответил · повторю через N с» only while it retries.
  | 'api_retry'
  // Mirage: an Artifact was published during the live turn. Carries
  // `artifact` (ArtifactSummary of the new version) and `toolId`; sent after
  // the panel stored its copy, so the client can open it beside the chat.
  | 'artifact_published';

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas,
 * project loading progress, protocol failures) that are not produced by any
 * provider adapter. Together with `MessageKind` they form the complete set of
 * `kind` values a websocket client can receive, so the frontend only ever
 * needs one kind-based switch.
 */
export type GatewayEventKind =
  | 'chat_subscribed'
  | 'session_upserted'
  | 'loading_progress'
  | 'protocol_error';

/**
 * Complete set of `kind` values emitted to websocket clients.
 *
 * Every server-to-client websocket frame carries a `kind` from this union.
 * Provider runtimes emit `MessageKind` values; gateway services emit
 * `GatewayEventKind` values.
 */
export type ServerEventKind = MessageKind | GatewayEventKind;

/** The owning project as it appears inside a `session_upserted` delta. */
export type SessionUpsertedProject = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
};

/**
 * The `session_upserted` sidebar delta, built only by
 * `modules/websocket/services/session-upsert-broadcast.service.ts`.
 *
 * Typed rather than assembled as an untyped object literal because the payload
 * used to be built in two places and silently drifted apart: one copy set
 * `providerSessionId` and the other did not, and nothing could detect it.
 *
 * `providerSessionId` is how a client recognises that a row it is currently
 * showing has been merged into its canonical app-session row, so it is always
 * present — `null` only while the provider has not reported an id yet.
 */
export type SessionUpsertedEvent = {
  kind: 'session_upserted';
  sessionId: string;
  providerSessionId: string | null;
  provider: LLMProvider;
  session: {
    id: string;
    summary: string;
    messageCount: number;
    lastActivity: string;
  };
  project: SessionUpsertedProject | null;
  timestamp: string;
};

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
/**
 * A compaction, as the transcript records it.
 *
 * `running` is the status the CLI sends when it starts compacting, `done` the
 * boundary it sends when it has, `failed` a compaction that did not finish.
 * The token counts and duration only come with a boundary.
 */
export type CompactionInfo = {
  phase: 'running' | 'done' | 'failed';
  /** Whether the user asked for it or the context window did. */
  trigger?: 'manual' | 'auto';
  /** Tokens the conversation held before and after, when the boundary reports them. */
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string | null;
};

/**
 * Mirage: one automatic retry of a failed API call, as the SDK announces it
 * (`system/api_retry`). `errorStatus` is the HTTP status (529, 429, 500…) or
 * null when no response arrived; `retryDelayMs` is the pause before the retry.
 */
export type ApiRetryInfo = {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  /** The SDK's error category (`rate_limit`, `server_error`…), when given. */
  error: string | null;
};

export type NormalizedMessage = {
  id: string;
  /**
   * The provider's own identifier for the transcript row this message came
   * from, when the provider has stable per-row identity (today: Claude's
   * `uuid`). It is what "edit this message" and "fork from here" address, so it
   * has to survive a reload — never a value this app synthesized.
   */
  transcriptAnchorId?: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Monotonic per-run sequence number assigned by the chat run registry when a
   * live event is forwarded to the websocket. History messages loaded over
   * REST do not carry it. Clients use it with `chat.subscribe` to replay only
   * the live events they missed across websocket reconnects.
   */
  seq?: number;
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * The model that produced this assistant message, as the provider reported
   * it on the transcript row (today: Claude's `message.model`, e.g.
   * `claude-opus-5`). Absent on user turns — no provider records which model a
   * request went out with — and absent when the provider named a placeholder
   * such as `<synthetic>`, so a locally-fabricated notice is never labelled
   * with a model it did not run on.
   */
  model?: string;
  /**
   * Optional display-oriented metadata used by providers that need to expose
   * richer transcript artifacts without introducing a brand-new message kind.
   *
   * Current Claude usage:
   * - local slash commands expose parsed command fields
   * - compact summaries are flagged so the UI can treat them differently later
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /** Set on the row that stands in for a compaction, so the UI can draw it as one. */
  compact?: CompactionInfo;
  /** Mirage: set on `api_retry` — the failed call and the coming retry. */
  apiRetry?: ApiRetryInfo;
  images?: unknown;
  /** Non-image files attached to a user turn after provider history normalization. */
  files?: unknown;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: {
    content?: string;
    isError?: boolean;
    toolUseResult?: unknown;
  };
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  status?: string;
  summary?: string;
  tokenBudget?: unknown;
  /**
   * Timeline of everything a subagent did, attached to the `tool_use` that
   * spawned it. Present for Claude `Agent`/`Task` calls and Codex
   * `spawn_agent` calls; absent for every other tool.
   */
  subagentTools?: SubagentActivity[];
  /** Identity and lifecycle of the subagent this `tool_use` spawned. */
  subagent?: SubagentInfo;
  /** The workflow run this `tool_use` launched, read from its journal on disk. */
  workflow?: WorkflowInfo;
  /** Stored memory the reply drew on, when the provider reports it. */
  memoryCitations?: MemoryCitation[];
  toolUseResult?: unknown;
  /**
   * Mirage: the Artifact this row is about. Set on the `Artifact` tool's
   * `tool_use` (history, once its result is attached) and `tool_result` (live)
   * rows, and on `artifact_published` (there a full `ArtifactSummary`).
   */
  artifact?: ArtifactPublication;
  sequence?: number;
  rowid?: number;
  /**
   * `task_status` fields: one lifecycle event of a background task the live
   * run is tracking. `taskId` is the provider's task handle; `toolUseId` names
   * the call that launched it and is absent on `updated`, which the SDK keys by
   * task id alone. `status` and `summary` above carry the event's own.
   */
  event?: 'started' | 'progress' | 'updated' | 'notification';
  taskId?: string;
  toolUseId?: string;
  taskType?: string;
  workflowName?: string;
  description?: string;
  usage?: TaskUsage;
  outputFile?: string;
  /**
   * Mirage: whether the task runs in the background. `false` on the start of
   * a foreground command the turn blocks on (the SDK reports those too);
   * `true` on the start of background work, or on an `updated` patch that
   * moved a foreground task to the background. Absent when the SDK did not say.
   */
  backgrounded?: boolean;
  /** A workflow's `progress` only: where each agent the run spawned stands. */
  agents?: WorkflowAgentProgress[];
  [key: string]: unknown;
};

/**
 * What a background task has spent so far, as the CLI reports it on
 * `task_progress` and `task_notification`.
 */
export type TaskUsage = {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
};

/**
 * One background task a live session still has outstanding — a spawned
 * agent, a workflow run or a backgrounded command — as the runtime tracks it
 * from the stream's `task_started` until the event that settles it.
 *
 * `taskId` is the handle a stop request names; `toolUseId` is the call that
 * launched it, which is how the client pairs the task with its card.
 * `startedAt` is the server clock at `task_started`, so a session whose turn
 * has ended can still report how long its work has been going.
 */
export type BackgroundTaskSummary = {
  taskId: string;
  toolUseId: string;
  taskType: string;
  description: string;
  workflowName?: string;
  startedAt: number;
  /**
   * The task was launched by a subagent or workflow agent, not by the
   * session's own turn: its `toolUseId` names a call in that agent's
   * transcript, so no card in this session's transcript matches it. Listed so
   * it can still be stopped; not counted as the session's own work.
   */
  nested?: boolean;
};

/**
 * Where one agent of a running workflow stands, as the SDK reports it on the
 * run's `task_progress` events.
 *
 * An entry the script has queued but not yet started has no `agentId` and is
 * identified by `index` alone; once the agent runs, `agentId` names the
 * transcript it writes. `lastToolName` and `lastToolSummary` are the agent's
 * own latest tool call — unlike the event's task-level `last_tool_name`, which
 * for a workflow is the current agent's label.
 */
export type WorkflowAgentProgress = {
  index: number;
  label?: string;
  /** The title of the script phase the agent runs under, when it has one. */
  phase?: string;
  agentId?: string;
  model?: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  startedAt?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  resultPreview?: string;
};

/**
 * One workflow agent's recorded timeline, read from its transcript on demand
 * when the card is opened — the SDK never streams an agent's own rows to the
 * parent session, so this is the only way to see what it did.
 *
 * `activityCount` is the full length of the timeline; `activity` is capped
 * for transport like a subagent's `subagentTools`.
 */
export type WorkflowAgentActivity = {
  agent: {
    id: string;
    label?: string;
    model?: string;
    status: 'running' | 'completed' | 'failed' | 'stopped';
  };
  activity: SubagentActivity[];
  activityCount: number;
};

/**
 * One agent a workflow run spawned, as its journal records it.
 *
 * `label` and `phase` are whatever the script passed when it spawned the
 * agent; older scripts passed neither. An agent with a `started` record and no
 * `result` or `failed` one is still running as far as the journal knows.
 */
export type WorkflowAgentInfo = {
  id: string;
  label?: string;
  phase?: string;
  /** `stopped` is an agent the journal never settled although the run itself has — abandoned by a stop or a resume that re-ran the step. */
  status: 'running' | 'completed' | 'failed' | 'stopped';
};

/**
 * A `Workflow` tool call's run, attached to the `tool_use` that launched it.
 *
 * `status` follows the same rule as a background agent's: the task
 * notification's word when one exists, else `running` only while the process
 * that launched it is still up, else `stopped`. The agent list and counts come
 * from `<transcriptDir>/journal.jsonl`; both are empty when the run left no
 * journal behind (a fork copies only the parent's transcript).
 */
export type WorkflowInfo = {
  runId: string;
  name: string;
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  agents: WorkflowAgentInfo[];
  agentCounts: { total: number; completed: number; failed: number; running: number; stopped: number };
  scriptPath?: string;
};

/**
 * One stored memory an assistant reply drew on.
 *
 * Codex appends these to a reply that used its memory files, naming the file
 * and line range it read plus a short note on what it took from there. The
 * transcript shows them as a footnote so a memory-derived claim is traceable
 * rather than arriving as an unattributed assertion.
 */
export type MemoryCitation = {
  /** File and line range that was read, e.g. `MEMORY.md:137-142`. */
  source: string;
  /** What the reply took from that range, when the provider states it. */
  note?: string;
};

/**
 * One entry in a subagent's recorded timeline.
 *
 * Providers store a subagent's work in a separate transcript (Claude:
 * `<session>/subagents/agent-<id>.jsonl`; Codex: a sibling rollout keyed by
 * `agent_thread_id`). Both are flattened into this shape so the transcript can
 * replay a subagent's run with the same renderers the main thread uses.
 *
 * `kind` decides which fields matter: `tool` uses the tool fields, `text` and
 * `thinking` use `content`. Consumers must not assume tool fields exist on the
 * text kinds.
 */
export type SubagentActivity = {
  kind: 'tool' | 'text' | 'thinking';
  timestamp?: string;
  /** Tool-call identity; only set when `kind` is `tool`. */
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: { content?: string; isError?: boolean } | null;
  /** Message body; only set when `kind` is `text` or `thinking`. */
  content?: string;
};

/**
 * Identity and lifecycle of one spawned subagent, normalized across providers.
 *
 * `status` is `running` until the call that spawned the agent resolves. After
 * that it is whatever the provider reported — Claude's task notification
 * carries one — and `completed` when the provider reported nothing. A failed
 * tool call *inside* the agent is not a failed agent, so it is never inferred
 * from the transcript. A background agent whose session process ended before
 * it reported is `stopped`: no outcome exists and none is coming.
 */
export type SubagentInfo = {
  /** Provider-native agent id — Claude `agentId`, Codex `agent_thread_id`. */
  id: string;
  /** Human-facing label: Claude's agent type, or Codex's assigned nickname. */
  name?: string;
  /** Agent type/preset when the provider records one (Claude `agentType`). */
  type?: string;
  /** One-line task summary shown in the collapsed header. */
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /** Model the subagent ran on, when the provider records it. */
  model?: string;
  /**
   * How many activities the agent actually recorded. It exceeds
   * `subagentTools.length` when a long run was truncated for transport, which
   * lets the UI say so instead of silently showing a partial timeline.
   */
  activityCount?: number;
};

/**
 * Output gateway shared by WebSocket and SSE provider runs.
 *
 * Runtime adapters only depend on this structural surface, which keeps them
 * independent from the transport that ultimately delivers normalized events.
 */
export type ProviderRuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: string | number | null;
  isWebSocketWriter?: boolean;
};

export type ProviderPermissionDecision = {
  allow: boolean;
  updatedInput?: unknown;
  message?: string;
  rememberEntry?: unknown;
};

export type ProviderRuntimePermissionGateway = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void;
  listPending(sessionId: string): unknown[];
};

/**
 * Provider-scoped application capabilities supplied to a runtime for one run.
 *
 * Keeping these lookups outside concrete SDK/CLI adapters prevents the
 * adapters from importing services that resolve back through providerRegistry.
 */
export type ProviderRuntimeContext = {
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels(): Promise<ProviderModelsDefinition>;
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  isProviderInstalled(): Promise<boolean>;
  /**
   * Builds the SDK query for a run. Production leaves this unset and the
   * runtime uses the SDK's own; tests supply a scripted stream so the hold
   * and background-work paths can be driven without a CLI process.
   */
  createQuery?: (input: { prompt: AsyncIterable<unknown>; options: AnyRecord }) => AsyncIterable<unknown> & {
    interrupt(): Promise<void>;
    stopTask?(taskId: string): Promise<void>;
  };
};

export type ProviderRunFunction = (
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
) => Promise<unknown>;

/**
 * Shared options used to fetch historical provider messages.
 *
 * Consumers should pass provider-specific lookup hints (`projectPath`) only
 * when the selected provider requires them.
 *
 * `providerSessionId` is the provider-native session id from the sessions
 * index (transcript file name / provider database key). Provider adapters
 * must use it — never the app-facing session id they were called with — when
 * matching transcript rows on disk, because app-created sessions use an
 * app-allocated id that the provider has never seen.
 */
export type FetchHistoryOptions = {
  projectPath?: string;
  limit?: number | null;
  offset?: number;
  providerSessionId?: string;
};

/**
 * Standardized response payload returned from provider history readers.
 *
 * Use this as the contract for APIs that return paginated conversation history.
 */
export type FetchHistoryResult = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

// ---------------------------
//----------------- PROVIDER SKILL TYPES ------------
/**
 * Scope where a provider skill definition was discovered.
 *
 * Provider skill adapters should use this to describe the origin of each
 * skill markdown file without leaking provider-specific folder names into route
 * contracts. `repo` is used for Codex repository lookup locations, while
 * `project` is used for providers that treat workspace-local skills as project
 * scoped.
 */
export type ProviderSkillScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/**
 * Shared input accepted by provider skill listing operations.
 *
 * Routes pass `workspacePath` when a caller wants project/repository skills for
 * a specific folder. Providers should fall back to the backend process cwd when
 * this option is omitted.
 */
export type ProviderSkillListOptions = {
  workspacePath?: string;
};

/**
 * One supporting file bundled with an uploaded provider skill.
 *
 * `relativePath` is resolved below the installed skill directory and must never
 * be absolute or contain traversal segments. Text files may use `utf8`; binary
 * scripts and assets should use `base64` so JSON transport does not corrupt
 * their bytes.
 */
export type ProviderSkillCreateFile = {
  relativePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/**
 * One skill markdown payload submitted for provider-managed installation.
 *
 * `content` is the raw markdown body that will be written to `SKILL.md`.
 * `directoryName` lets callers control the target folder name explicitly when
 * they want stable filesystem paths that differ from the markdown front matter
 * `name` field. `fileName` is optional upload metadata used only as a final
 * fallback when no directory name or front matter name is present. `files`
 * carries scripts, references, and other files from a complete skill folder.
 */
export type ProviderSkillCreateEntry = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: ProviderSkillCreateFile[];
};

/**
 * Shared input accepted by provider skill creation operations.
 *
 * The service layer batches multiple skill definitions in one request. Each
 * entry can contain only markdown or a complete skill folder.
 */
export type ProviderSkillCreateInput = {
  entries: ProviderSkillCreateEntry[];
};

export type ProviderSkillRemoveInput = {
  directoryName: string;
};

/**
 * Normalized skill record returned by provider skill adapters.
 *
 * The `command` value is the exact invocation text the selected provider expects
 * for this skill. Claude plugin skills use a namespaced command such as
 * `/plugin-name:skill-name`, while Codex skills use the `$skill-name` form.
 * `sourcePath` points to the skill markdown file that produced the record so
 * callers can distinguish duplicate skill names across scopes.
 */
export type ProviderSkill = {
  provider: LLMProvider;
  name: string;
  description: string;
  command: string;
  scope: ProviderSkillScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
};

/**
 * Internal source descriptor consumed by shared provider skill discovery logic.
 *
 * Concrete provider adapters build these records from their native lookup rules.
 * The shared skills provider then scans `rootDir` for child skill markdown files
 * and uses `commandForSkill` or `commandPrefix` to produce the provider-specific
 * invocation command. Set `recursive` only when a provider stores skills under
 * arbitrary nested folders below the source root.
 */
export type ProviderSkillSource = {
  scope: ProviderSkillScope;
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
  commandForSkill?: (skillName: string) => string;
  pluginName?: string;
  pluginId?: string;
};

// ---------------------------
//----------------- SHARED ERROR TYPES ------------
/**
 * Optional metadata used when constructing application-level errors.
 *
 * `statusCode` should reflect the HTTP response status, while `code` identifies
 * the stable machine-readable error category.
 */
export type AppErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: unknown;
};

// ---------------------------
//----------------- MCP TYPES ------------
/**
 * Scope where an MCP server definition is stored and resolved.
 *
 * `user` is global for a user account, `local` is provider-local, and `project`
 * is tied to a specific project path.
 */
export type McpScope = 'user' | 'local' | 'project';

/**
 * Transport protocol used by an MCP server definition.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Normalized MCP server model exposed to frontend and route handlers.
 *
 * Provider adapters should map provider-native config to this structure before
 * returning results.
 */
export type ProviderMcpServer = {
  provider: LLMProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

/**
 * Payload for create/update MCP server operations.
 *
 * Routes and services should accept this type, validate it, and then persist it
 * through provider-specific MCP repositories.
 */
export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

// ---------------------------
//----------------- PROVIDER AUTH TYPES ------------
/**
 * Records that an API-key style credential is taking precedence over a
 * still-valid subscription login in `~/.claude/.credentials.json`.
 *
 * Claude Code always prefers `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` over
 * the OAuth login written by `claude /login`, so when both exist every request
 * is billed to the key (pay-as-you-go) rather than the subscription — usually
 * without the user realising it. The Claude auth provider fills this in so the
 * settings UI can say which variable won and where it was found; the fix
 * differs per source (unset the variable and restart the server for
 * `process_env`, edit the `env` block of `~/.claude/settings.json` for
 * `settings_file`). It is never set when the login in the credentials file is
 * missing or expired, because then nothing is being bypassed.
 */
export type ProviderAuthSubscriptionOverride = {
  /** The environment variable Claude Code is using instead of the login. */
  variable: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';
  /** Where that variable was found: the server process env or the settings.json env block. */
  source: 'process_env' | 'settings_file';
  /** Email recorded in the credentials file for the bypassed login, when known. */
  subscriptionEmail: string | null;
};

/**
 * Authentication status result returned by provider health checks.
 *
 * This shape is consumed by settings/status endpoints to report installation and
 * credential state for each provider.
 */
export type ProviderAuthStatus = {
  installed: boolean;
  provider: LLMProvider;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
  /**
   * Present only when `method` is `api_key` and a valid subscription login is
   * being bypassed; see ProviderAuthSubscriptionOverride. Omitted otherwise so
   * existing consumers that never look for it are unaffected.
   */
  subscriptionOverride?: ProviderAuthSubscriptionOverride;
};

// ---------------------------
//----------------- SHARED DATABASE CREDENTIAL TYPES ------------
/**
 * Safe credential view returned by credential listing APIs.
 *
 * This intentionally excludes the raw credential secret while still exposing
 * metadata needed for UI rendering and management operations.
 */
export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

/**
 * Result returned after creating a credential record.
 *
 * Use this return shape when callers need the created id and display metadata,
 * but must never receive the stored secret value.
 */
export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};

// ---------------------------
//----------------- CHAT DRAFT QUEUE TYPES ------------
/**
 * A chat message queued to be sent when its session is next idle, in the shape
 * the composer submits it and `session_drafts.queued_message` stores it.
 *
 * `content` is the message text, `attachments` the JSON-safe descriptors
 * returned by POST /api/assets/files, and `options` the composer's send options
 * (model, effort, permission mode, ...) captured when it was queued. A session
 * has at most one: a message queued while another is waiting is merged into it
 * by the drafts repository. The User module accepts it, the Database module
 * stores and merges it, and the Scheduled Messages dispatcher sends it (read
 * through `readQueuedChatMessage`).
 */
export type QueuedChatMessage = {
  content: string;
  options?: Record<string, unknown>;
  attachments: unknown[];
};

// ---------------------------
//----------------- PROJECT PERSISTENCE TYPES ------------
/**
 * Canonical project row shape returned by the projects repository.
 *
 * Use this type whenever backend services need to pass around one database
 * project record without leaking raw SQL row typing across modules.
 */
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
};

/**
 * Result category returned by `projectsDb.createProjectPath`.
 *
 * `created` means a fresh row was inserted, `reactivated_archived` means an
 * existing archived path was accepted and updated, and `active_conflict` means
 * an already-active path blocked project creation.
 */
export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

/**
 * Structured result returned by project-path upsert operations.
 *
 * Services should use this result to decide whether a request succeeded,
 * should return a conflict, or needs follow-up retrieval of row metadata.
 */
export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

/**
 * Machine-readable reason a workspace path was refused (Mirage, Б18).
 *
 * Shared by `validateWorkspacePath`, the project-creation services and the
 * Kabina "New project" wizard, which picks its hint by this code.
 */
export type WorkspacePathRejectionCode =
  | 'WORKSPACE_PATH_REQUIRED'
  | 'WORKSPACE_PATH_CONTROL_CHARACTERS'
  | 'WORKSPACE_PATH_RELATIVE'
  | 'WORKSPACE_PATH_IS_FILESYSTEM_ROOT'
  | 'WORKSPACE_PATH_SYSTEM_DIRECTORY'
  | 'WORKSPACE_PATH_OUTSIDE_ROOT'
  | 'WORKSPACE_PATH_IS_WORKSPACES_ROOT'
  | 'WORKSPACE_PATH_HIDDEN_DIRECTORY'
  | 'WORKSPACE_PATH_SYMLINK_OUTSIDE_ROOT'
  | 'WORKSPACE_PATH_CHECK_FAILED';

/**
 * Validation result for user-supplied workspace/project paths.
 *
 * `resolvedPath` is present only when validation succeeds. On failure `error`
 * keeps the upstream English diagnostic, while Mirage adds `code`, a short
 * Russian `title` and a human `reason` (the wording of the DarkProjects
 * wizard) that the API returns to the user as-is.
 */
export type WorkspacePathValidationResult = {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
  code?: WorkspacePathRejectionCode;
  title?: string;
  reason?: string;
};

/**
 * Options of `validateWorkspacePath`.
 *
 * `allowWorkspacesRoot` lets the workspaces root itself pass — the folder
 * browser lists it — while project creation keeps it refused, because a
 * project spanning the whole home folder would expose keys and settings.
 */
export type WorkspacePathValidationOptions = {
  allowWorkspacesRoot?: boolean;
};

// ---------------------------
//----------------- GIT COMMAND EXECUTION AND WORKTREE MANAGEMENT ------------
/**
 * Captured output of one completed `git` invocation.
 *
 * Returned by `GitCommandRunner` and `GitProcessRunner` implementations so the
 * git and worktree services can read both streams without caring about
 * process plumbing.
 */
export type GitCommandResult = {
  stdout: string;
  stderr: string;
};

/**
 * Executes `git <args>` inside `cwd` and resolves with the captured output.
 *
 * All worktree services receive their git access through this contract so
 * tests can inject a fake runner instead of spawning real processes. The
 * promise must reject (with `stderr` attached when available) on a non-zero
 * exit code.
 */
export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

/**
 * Executes `command args...` inside `options.cwd` and resolves with the captured output.
 *
 * This is the `spawnAsync` shape the Git routes module injects into its typed
 * services (branch deletion, branch compare) so their tests can substitute a
 * fake runner. Like `GitCommandRunner`, the promise must reject on a non-zero
 * exit code, with `stderr` attached to the error when available.
 */
export type GitProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

/**
 * One entry parsed from `git worktree list --porcelain`.
 *
 * This is the raw repository-level view (path/HEAD/branch/flags) before any
 * enrichment with project links or ahead/behind counts. `branch` is null for
 * detached-HEAD worktrees.
 */
export type WorktreePorcelainEntry = {
  path: string;
  headSha: string | null;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
};

/**
 * Fully enriched worktree row served to the UI.
 *
 * Extends the porcelain entry with everything the Worktrees panel renders:
 * dirty-file count, ahead/behind relative to the base branch (the branch
 * checked out in the main worktree), last-commit metadata, and the CloudCLI
 * project row linked to the worktree directory (if one was registered).
 */
export type WorktreeDescriptor = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
  changedFileCount: number;
  ahead: number;
  behind: number;
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  linkedProjectId: string | null;
  linkedProjectArchived: boolean;
};

/**
 * Response payload of `GET /api/worktrees`.
 *
 * `baseBranch` is the branch checked out in the main worktree — the merge
 * target offered by the UI. `worktrees` always lists the main worktree first.
 */
export type WorktreeListResult = {
  repositoryRoot: string;
  baseBranch: string | null;
  worktrees: WorktreeDescriptor[];
};

// ---------------------------
//----------------- WORKTREE SERVICE INPUTS AND RESULTS ------------
/**
 * Input accepted by the worktree-listing workflow.
 *
 * `projectPath` may point at the main checkout or any linked worktree. The
 * service uses Git to resolve the complete repository-level worktree list.
 */
export type ListWorktreesInput = {
  projectPath: string;
};

/**
 * Input accepted when creating a linked Git worktree.
 *
 * `branch` is checked out when it already exists, otherwise it is created from
 * `baseBranch`. When `baseBranch` is omitted, the main worktree branch is used.
 */
export type CreateWorktreeInput = {
  projectPath: string;
  branch: string;
  baseBranch?: string | null;
};

/**
 * Result of successfully creating a linked Git worktree.
 *
 * `createdBranch` distinguishes a new branch from an existing branch checkout,
 * allowing API clients to accurately describe what Git changed.
 */
export type CreateWorktreeResult = {
  worktreePath: string;
  branch: string;
  createdBranch: boolean;
};

/**
 * Result of atomically creating and registering a worktree for project use.
 *
 * The Worktrees application service compensates the Git creation if project
 * registration fails, so routes only receive this shape after both steps pass.
 */
export type CreateAndOpenWorktreeResult = CreateWorktreeResult & {
  project: WorktreeProjectView;
};

/**
 * Input accepted when registering an existing worktree as a CloudCLI project.
 *
 * The service verifies that `worktreePath` belongs to the repository containing
 * `projectPath` before it creates or restores any project record.
 */
export type OpenWorktreeInput = {
  projectPath: string;
  worktreePath: string;
};

/**
 * Project view returned after a worktree is opened in CloudCLI.
 *
 * This deliberately mirrors the project-selection payload used by the Projects
 * module so the frontend can switch to the worktree without another lookup.
 */
export type WorktreeProjectView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
  sessions: [];
  sessionMeta: { hasMore: false; total: 0 };
};

/**
 * Input accepted when removing a linked Git worktree.
 *
 * `force` permits removal with local changes. `deleteBranch` requests
 * best-effort branch cleanup after the worktree directory is removed.
 */
export type RemoveWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  force?: boolean;
  deleteBranch?: boolean;
};

/**
 * Result of removing a linked Git worktree.
 *
 * `archivalError` reports best-effort project archival failure after Git has
 * already removed the worktree, allowing callers to represent partial success.
 */
export type RemoveWorktreeResult = {
  removedPath: string;
  branch: string | null;
  branchDeleted: boolean;
  archivedProjectId: string | null;
  archivalError: string | null;
};

/**
 * Input accepted when merging a linked worktree into the main worktree branch.
 *
 * The service verifies both worktrees are clean, supports squash and regular
 * merges, and may remove the source worktree after a successful merge.
 */
export type MergeWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  squash?: boolean;
  message?: string | null;
  removeAfterMerge?: boolean;
};

/**
 * Result of a completed worktree merge.
 *
 * `removedWorktree` is populated only when post-merge removal succeeds.
 * `cleanupError` reports failed optional removal without misrepresenting the
 * already-completed merge as a failure.
 */
export type MergeWorktreeResult = {
  mergedBranch: string;
  targetBranch: string;
  squash: boolean;
  removedWorktree: RemoveWorktreeResult | null;
  cleanupError: string | null;
};

// ---------------------------
//----------------- WORKTREE MODULE DEPENDENCY CONTRACTS ------------
/**
 * Filesystem capability required by the Worktrees module.
 *
 * Production wiring checks the real filesystem; unit tests provide a small
 * deterministic fake so worktree creation never touches developer directories.
 */
export type WorktreeFileSystem = {
  pathExists(candidatePath: string): Promise<boolean>;
};

/**
 * Project-management boundary consumed by Worktrees workflows.
 *
 * The Worktrees module uses this contract instead of importing Database or
 * Projects internals. Production adapters delegate through those modules'
 * `index.ts` barrels, while unit tests supply in-memory functions.
 */
export type WorktreeProjectGateway = {
  getProjectPathById(projectId: string): string | null;
  getProjectByPath(projectPath: string): ProjectRepositoryRow | null;
  createProject(input: {
    projectPath: string;
    customName: string;
  }): Promise<{
    outcome: 'created' | 'reactivated_archived';
    project: { projectId: string };
  }>;
  restoreProject(projectId: string): void | Promise<void>;
  archiveProject(projectId: string): void | Promise<void>;
};

/**
 * Complete application-service surface used by the Worktrees HTTP router.
 *
 * Routes parse transport values and call these functions; they do not import
 * repositories, filesystem adapters, Git runners, or individual service files.
 */
export type WorktreeServices = {
  resolveProjectPath(projectId: string): string;
  list(input: ListWorktreesInput): Promise<WorktreeListResult>;
  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult>;
  createAndOpen(input: CreateWorktreeInput): Promise<CreateAndOpenWorktreeResult>;
  open(input: OpenWorktreeInput): Promise<WorktreeProjectView>;
  merge(input: MergeWorktreeInput): Promise<MergeWorktreeResult>;
  remove(input: RemoveWorktreeInput): Promise<RemoveWorktreeResult>;
};

// ---------------------------
//----------------- FILE TREE MODULE CONTRACTS ------------
/**
 * One filesystem item returned by the File Tree API.
 *
 * The service populates metadata without following symlinks and recursively
 * attaches `children` only while the requested depth permits traversal. The
 * frontend uses the absolute `path` as the stable identifier for editor and
 * file-operation requests.
 */
export type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink?: boolean;
  children?: FileTreeNode[];
  /**
   * Mirage: the folder holds more than the listing shows — the tree hit the
   * server's entry budget here (its `children` are cut short or absent).
   */
  childrenTruncated?: boolean;
};

/**
 * A project's file tree as `listProjectFiles` returns it: everything that fit
 * into the server's entry budget (`limit`), breadth-first, and whether anything
 * was left out. The route sends `tree` and reports `truncated` in the
 * `X-File-Tree-Truncated` header (with `X-File-Tree-Limit`).
 */
export type FileTreeListing = {
  tree: FileTreeNode[];
  truncated: boolean;
  limit: number;
};

/**
 * Minimal directory-entry shape required during File Tree traversal.
 *
 * Production adapts Node `Dirent` objects to this structural contract. Tests
 * provide small handwritten entries and therefore never read real directories.
 */
export type FileTreeDirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

/**
 * Minimal file-stat shape used for tree metadata and delete decisions.
 *
 * The numeric mode is converted to octal and rwx strings for the UI. `lstat`
 * supplies symlink state while `stat` is used when deciding file versus folder
 * deletion behavior.
 */
export type FileTreeStats = {
  size: number;
  mtime: Date;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Complete filesystem capability injected into File Tree services.
 *
 * The production composition root delegates these operations to Node's fs
 * APIs. Unit tests provide deterministic path-keyed fakes so service tests
 * cannot inspect, write, rename, or delete developer files.
 */
export type FileTreeFileSystem = {
  access(candidatePath: string): Promise<void>;
  stat(candidatePath: string): Promise<FileTreeStats>;
  lstat(candidatePath: string): Promise<FileTreeStats>;
  // Streamed rather than returned as an array so a directory with millions of
  // children is abandoned at the entry limit instead of being materialized.
  openDirectory(directoryPath: string): AsyncIterable<FileTreeDirectoryEntry>;
  realpath(candidatePath: string): Promise<string>;
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  makeDirectory(directoryPath: string, recursive: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  removeDirectory(directoryPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  // Mirage: fails with EEXIST rather than replace an existing destination.
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  createReadStream(filePath: string): Readable;
};

/**
 * Project lookup boundary consumed by File Tree workflows.
 *
 * File Tree services resolve DB-assigned project ids through this contract and
 * never import the Database module or its repositories directly.
 */
export type FileTreeProjectGateway = {
  getProjectPathById(projectId: string): string | null | Promise<string | null>;
};

/**
 * Workspace validation boundary used by filesystem browsing and folder creation.
 *
 * The injected validator enforces the configured workspace root and resolves
 * symlinks before the File Tree service exposes or mutates paths.
 */
export type FileTreeWorkspaceGateway = {
  rootPath: string;
  validatePath(candidatePath: string): Promise<WorkspacePathValidationResult>;
  /**
   * Resolves a path readable outside the workspace root — the system temp
   * directory and the Claude projects directory — or `null` when it is not
   * one. Read-only: the write policy is `validatePath` and it does not consult
   * this.
   */
  resolveReadOnlyRootPath(candidatePath: string): Promise<string | null>;
};

/**
 * Uploaded-file record passed from the Multer transport adapter into the File
 * Tree service.
 *
 * Transport-specific field names are normalized so upload workflows do not
 * depend on Express or Multer types.
 */
export type FileTreeUploadedFile = {
  originalName: string;
  temporaryPath: string;
  size: number;
  mimeType: string;
};

/**
 * Logger boundary for expected File Tree diagnostics.
 *
 * Production delegates to the server console. Unit tests use no-op or captured
 * loggers and never patch the global console singleton.
 */
export type FileTreeLogger = {
  error(message: string, error?: unknown): void;
};

/**
 * Required production dependencies for the File Tree application service.
 *
 * Filesystem, project lookup, workspace policy, MIME detection, concurrency,
 * and logging are all explicit so service construction has no hidden process,
 * repository, or machine-wide defaults.
 */
export type FileTreeServiceDependencies = {
  fileSystem: FileTreeFileSystem;
  projects: FileTreeProjectGateway;
  workspace: FileTreeWorkspaceGateway;
  resolveMimeType(filePath: string): string;
  fileSystemConcurrency: number;
  logger: FileTreeLogger;
};

/**
 * Complete File Tree application-service surface consumed by HTTP routes.
 *
 * Routes parse transport inputs and call these methods; they never resolve
 * project repositories, validate filesystem ownership, or perform filesystem
 * mutations themselves.
 */
export type FileTreeServices = {
  browseWorkspace(inputPath: string | null): Promise<{
    path: string;
    suggestions: Array<{ path: string; name: string; type: 'directory' }>;
  }>;
  createWorkspaceFolder(folderPath: string): Promise<{ success: true; path: string }>;
  readTextFile(projectId: string, filePath: string): Promise<{ content: string; path: string }>;
  openFile(projectId: string, filePath: string): Promise<{ contentType: string; stream: Readable }>;
  saveTextFile(projectId: string, filePath: string, content: string): Promise<{
    success: true;
    path: string;
    message: string;
  }>;
  listProjectFiles(
    projectId: string,
    options?: { respectGitignore: boolean },
  ): Promise<FileTreeListing>;
  createEntry(input: {
    projectId: string;
    parentPath: string;
    type: 'file' | 'directory';
    name: string;
  }): Promise<{ success: true; path: string; name: string; type: 'file' | 'directory'; message: string }>;
  renameEntry(input: { projectId: string; oldPath: string; newName: string }): Promise<{
    success: true;
    oldPath: string;
    newPath: string;
    newName: string;
    message: string;
  }>;
  deleteEntry(input: { projectId: string; targetPath: string }): Promise<{
    success: true;
    path: string;
    type: 'file' | 'directory';
    message: string;
  }>;
  storeUploadedFiles(input: {
    projectId: string;
    targetPath: string;
    relativePaths: string[];
    requestedFileCount: number;
    files: FileTreeUploadedFile[];
  }): Promise<{
    success: true;
    files: Array<{ name: string; path: string; size: number; mimeType: string }>;
    uploadedCount: number;
    requestedFileCount: number;
    targetPath: string;
    message: string;
  }>;
};

// ---------------------------
//----------------- VOICE MODULE CONTRACTS ------------
/**
 * Per-request voice settings parsed from authenticated HTTP headers.
 *
 * The Voice routes create this value from the optional `x-voice-*` headers and
 * pass it to the Voice service. Empty values mean "use the server-configured
 * default"; the backend base URL is intentionally absent because clients must
 * never control the server's outbound destination.
 */
export type VoiceRequestOverrides = {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
};

/**
 * Uploaded audio accepted by the Voice transcription service.
 *
 * Routes translate Multer's transport-specific file object into this minimal
 * shape so the service does not depend on Express or Multer types.
 */
export type VoiceAudioUpload = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

/**
 * Successful speech payload returned by the Voice service.
 *
 * The route copies `contentType` to the client response and pipes `body`
 * without buffering the complete synthesized audio in application memory.
 */
export type VoiceSpeechPayload = {
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * Explicit service result used by Voice routes instead of transport-aware
 * exceptions.
 *
 * Services return `ok: false` with the exact client status/message for expected
 * backend, validation, and timeout failures. Routes only translate the result
 * into HTTP output, while unexpected programming errors still reject normally.
 */
export type VoiceServiceResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Complete application-service surface consumed by the Voice HTTP router.
 *
 * The composition root supplies a concrete implementation with environment
 * configuration and an injected outbound HTTP adapter. Unit tests use the same
 * contract with handwritten fetch fakes and never patch global state.
 */
export type VoiceService = {
  getHealth(): { configured: boolean };
  transcribe(input: {
    audio: VoiceAudioUpload;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<{ text: string }>>;
  synthesizeSpeech(input: {
    text: string;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<VoiceSpeechPayload>>;
};

// ---------------------------
//----------------- CLI MODULE CONTRACTS ------------
/**
 * Output boundary used by the CLI and Sandbox services.
 *
 * Production wiring delegates to the real console. Unit tests collect these
 * calls in arrays, which keeps command assertions deterministic and avoids
 * monkey-patching the global console singleton.
 */
export type CliOutput = {
  log(message?: string): void;
  error(message?: string): void;
};

/**
 * Minimal synchronous filesystem surface shared by CLI status reporting and
 * sandbox workspace validation.
 *
 * The production composition root adapts Node's filesystem module. Tests supply
 * path-keyed fakes, so service tests never inspect or modify the real machine.
 */
export type CliFileSystem = {
  pathExists(filePath: string): boolean;
  getFileStats(filePath: string): { size: number; modifiedAt: Date };
};

/**
 * Mutable environment view owned by the CLI application.
 *
 * CLI options update this object before the server starts. Production passes
 * `process.env`; tests pass a plain record to verify option precedence without
 * changing process-wide environment state.
 */
export type CliEnvironment = Record<string, string | undefined>;

/**
 * Package metadata displayed by CLI help, status, version, and update commands.
 *
 * The composition root reads this once from the application package file and
 * injects only the fields the service needs.
 */
export type CliPackageMetadata = {
  version: string;
  homepage?: string;
  bugsUrl?: string;
};

/**
 * Executable CLI application returned by the CLI composition root.
 *
 * The thin executable entrypoint passes `process.argv` arguments to `run` and
 * copies the returned code to `process.exitCode`. Tests invoke the same method
 * directly with isolated dependencies.
 */
export type CliApplication = {
  run(argumentsList: string[]): Promise<number>;
};

/**
 * Sandbox command service consumed by the top-level CLI command dispatcher.
 *
 * Keeping this behind one required dependency lets CLI tests use a tiny fake,
 * while focused Sandbox tests exercise subprocess and filesystem behavior with
 * their own handwritten adapters.
 */
export type SandboxCommandService = {
  execute(argumentsList: string[]): Promise<number>;
};

/**
 * What `mirage passwd` was asked to do, after the top-level CLI parsed its
 * arguments: the database file (DATABASE_PATH, `--database-path` or the default
 * one in the data folder), an optional username (needed only when the panel has
 * several users) and whether the new password comes from stdin instead of a prompt.
 */
export type PasswordResetCommandRequest = {
  databasePath: string;
  username: string | null;
  passwordFromStdin: boolean;
};

/**
 * Password reset command consumed by the top-level CLI command dispatcher.
 *
 * The CLI composition root wires it to the database and bcrypt; CLI tests pass a
 * fake that records the request. Resolves to the process exit code.
 */
export type PasswordResetCommandService = {
  execute(request: PasswordResetCommandRequest): Promise<number>;
};

// ---------------------------
//----------------- ARTIFACTS MODULE CONTRACTS ------------

/**
 * How the panel can show an Artifact locally.
 *
 * - `page`: a self-contained HTML page (plus the supporting files it was
 *   published with) — rendered in a sandboxed iframe.
 * - `markdown`: a published `.md` file — rendered by a small wrapper page.
 * - `typed`: an Artifact built from a claude.ai Artifact type (Design canvas,
 *   Slides, Docs…). Its page lives on claude.ai and cannot be rebuilt here, so
 *   the panel shows a card with the screens and an "Open on claude.ai" link.
 */
export type ArtifactKind = 'page' | 'markdown' | 'typed';

/**
 * The structured part of one successful `Artifact` publish, read from the
 * `toolUseResult` Claude Code stores beside the tool result (transcript key
 * `toolUseResult`, live SDK key `tool_use_result`).
 *
 * Built by `readArtifactPublication` (shared utils). The Claude provider
 * attaches it to the `Artifact` tool's rows as `NormalizedMessage.artifact`,
 * so the chat card "Open beside" needs no provider-specific parsing; the
 * Artifacts module uses it to index sessions. `seq` is the claude.ai version
 * number (1, 2, …) and `version` its version id (`<unix>-<hex>`); `localPath`
 * is the file that was published, which may since have been deleted
 * (scratchpads under `/tmp` are temporary).
 */
export type ArtifactPublication = {
  artifactId: string;
  url: string;
  title: string;
  version: string;
  seq: number | null;
  updated: boolean;
  icon: string | null;
  localPath: string | null;
};

/**
 * Everything the Artifacts module knows about one publish: the structured
 * result plus what the `Artifact` tool call itself named.
 *
 * Shared by the transcript reader (which builds it) and the artifact store
 * (which copies the named files). `supportingFiles` are absolute source paths
 * keyed by the path they are published at; nothing here is ever taken from an
 * HTTP request. `ownFiles` is the "Its own files now" list from the result text
 * of a typed Artifact (e.g. `project/Main.dc.html`).
 */
export type ArtifactPublishRecord = ArtifactPublication & {
  toolUseId: string;
  publishedAt: string | null;
  kind: ArtifactKind;
  label: string | null;
  description: string | null;
  entrySourcePath: string | null;
  sourceRoot: string | null;
  supportingFiles: Array<{ publishedPath: string; sourcePath: string }>;
  ownFiles: string[];
};

/**
 * `manifest.json` of one stored Artifact version under
 * `<store>/<artifactId>/<versionDir>/` (files in `files/<publishedPath>`).
 *
 * Written by the artifact store when a version is captured and read by the
 * Artifacts service to list stored versions and serve the frame. `entryPath`
 * is the published path of the main file, `null` when it could not be copied
 * (the card then says the local copy is missing). `modifiedAfterPublish` is set
 * when a backfill found the source changed after the publish time — the copy
 * may then be newer than what claude.ai holds for this version.
 */
export type ArtifactStoredManifest = {
  artifactId: string;
  versionDir: string;
  version: string;
  seq: number | null;
  kind: ArtifactKind;
  title: string;
  url: string;
  icon: string | null;
  label: string | null;
  publishedAt: string | null;
  entryPath: string | null;
  files: string[];
  skipped: Array<{ path: string; reason: string }>;
  ownFiles: string[];
  capturedAt: string;
  origin: 'live' | 'backfill';
  modifiedAfterPublish: boolean;
};

/** One version of an Artifact in `GET /api/sessions/:sessionId/artifacts` (newest first). */
export type ArtifactVersionSummary = {
  version: string;
  seq: number | null;
  publishedAt: string | null;
  label: string | null;
  /** A copy of this version is kept in the panel store and can be shown even if the source is gone. */
  stored: boolean;
};

/**
 * One Artifact of a session as the panel lists it: its newest version's data,
 * collapsed from every publish by `artifactId`.
 *
 * Returned by `GET /api/sessions/:sessionId/artifacts` and carried by the
 * `artifact_published` websocket event (there `versions` holds only the new
 * version — refetch the list for the full history). `screens` are the
 * `*.dc.html` screens of a typed Artifact (empty otherwise).
 */
export type ArtifactSummary = ArtifactPublication & {
  kind: ArtifactKind;
  publishedAt: string | null;
  description: string | null;
  label: string | null;
  localPathExists: boolean;
  stored: boolean;
  versionsCount: number;
  versions: ArtifactVersionSummary[];
  screens: string[];
  ownFiles: string[];
};

/** Response of `GET /api/sessions/:sessionId/artifacts`. Artifacts newest first. */
export type SessionArtifactsResponse = {
  sessionId: string;
  artifacts: ArtifactSummary[];
};

/**
 * Response of `GET /api/artifacts/:artifactId/view?format=json`: the
 * short-lived frame URL to put into `<iframe sandbox="allow-scripts">`.
 * The URL carries a ticket valid for this one Artifact version only, so the
 * panel's own token never reaches the (untrusted) Artifact page.
 */
export type ArtifactViewTicket = {
  url: string;
  artifactId: string;
  version: string;
  seq: number | null;
  kind: ArtifactKind;
  expiresAt: string;
};

/** One response body of the public, ticket-guarded artifact frame route. */
export type ArtifactFrameResponse = {
  body: Buffer;
  contentType: string;
  /** The entry document (no-store, ticket in its URL) as opposed to a supporting file. */
  isDocument: boolean;
};

/**
 * Services behind the Artifacts routes. Implemented by the Artifacts
 * composition root; route tests pass fakes. Each returns `null` for "not
 * found" (unknown session, artifact, version, file or an invalid ticket).
 */
export type ArtifactsRouteServices = {
  listSessionArtifacts(sessionId: string): Promise<SessionArtifactsResponse | null>;
  createViewTicket(input: {
    artifactId: string;
    version: string | null;
    sessionId: string | null;
  }): Promise<ArtifactViewTicket | null>;
  renderFrame(input: {
    artifactId: string;
    ticket: string;
    filePath: string;
  }): Promise<ArtifactFrameResponse | null>;
}


//----------------- COMMAND CATALOG CONTRACTS ------------
/**
 * Group identifier of one entry in the slash-command catalog.
 *
 * Seven built-in groups mirror the "Меню «/»" screen; `mine` collects the user's own
 * commands (`.claude/commands`) and skills. Consumed by the Commands Catalog service
 * (producer) and the Search service (command results), and by the frontend menu.
 */
export type CommandCatalogGroupId =
  | 'session'
  | 'context'
  | 'model'
  | 'agents'
  | 'tools'
  | 'project'
  | 'account'
  | 'mine';

/**
 * One slash command shown in the "/" menu and in global search.
 *
 * `execution` tells the UI how to run it: `sdk` sends the text to the Claude SDK as is,
 * `panel` triggers the panel action named in `panelAction`, `custom` expands a markdown
 * command file through `POST /api/commands/execute`, `skill` sends `/<name>` to the SDK.
 * `source` says where the entry was found. `path` is set only for file-backed entries.
 */
export type CommandCatalogEntry = {
  id: string;
  /** Slash name with the leading slash, e.g. `/compact`. */
  name: string;
  /** Argument hint, e.g. `[инструкция]`; empty string when the command takes none. */
  args: string;
  /** Russian description. */
  description: string;
  group: CommandCatalogGroupId;
  groupLabel: string;
  /** Keyboard shortcut as displayed to the user, or null. */
  shortcut: string | null;
  execution: 'sdk' | 'panel' | 'custom' | 'skill';
  /** Panel action id for `execution: 'panel'`, otherwise null. */
  panelAction: string | null;
  source: 'builtin' | 'project' | 'user' | 'skill' | 'plugin';
  path: string | null;
};

/**
 * Response of `GET /api/commands/catalog`: entries grouped in menu order plus the flat
 * list. `groups` always contains every group (possibly empty) in a stable order.
 */
export type CommandCatalogResponse = {
  groups: Array<{ id: CommandCatalogGroupId; label: string; commands: CommandCatalogEntry[] }>;
  commands: CommandCatalogEntry[];
  count: number;
};

// ---------------------------

//----------------- GLOBAL SEARCH CONTRACTS ------------
/**
 * Result category of `GET /api/search`. Used by the Search service and the "⌘K" screen.
 */
export type SearchResultType = 'project' | 'session' | 'file' | 'command' | 'action';

/**
 * A text fragment of a dialog message around the match. `matchStart`/`matchEnd` are
 * UTF-16 offsets into `text` (end exclusive) so the UI can highlight without re-searching.
 */
export type SearchSnippet = {
  text: string;
  matchStart: number;
  matchEnd: number;
};

/**
 * One search hit. Fields beyond `type`, `id`, `title` and `score` are filled only for
 * the types that need them: sessions carry `sessionId`, `snippet`, `role`, `timestamp`;
 * files carry `path`; commands carry `commandName`; actions carry `actionId`.
 * `score` is the ranking value (higher first) and is exposed for debugging only.
 */
export type SearchResultItem = {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle: string | null;
  projectId: string | null;
  projectName: string | null;
  /** Absolute path for projects and files. */
  path: string | null;
  sessionId: string | null;
  provider: string | null;
  snippet: SearchSnippet | null;
  role: 'user' | 'assistant' | null;
  /** ISO time of the message (sessions) or of the last project activity. */
  timestamp: string | null;
  /**
   * Sessions: ISO time of the session's last activity — the one date a dialog is
   * shown with everywhere (chat list, search row and preview). Null for other types.
   */
  lastActivity: string | null;
  commandName: string | null;
  actionId: string | null;
  score: number;
};

/**
 * Response of `GET /api/search`. Every requested type has a group; `count` is the number
 * of matches found before the per-group `limit` was applied, `truncated` is true when
 * the time budget cut a scan short so the counter may be a lower bound.
 */
export type SearchResponse = {
  query: string;
  tookMs: number;
  total: number;
  truncated: boolean;
  groups: Array<{
    type: SearchResultType;
    label: string;
    count: number;
    items: SearchResultItem[];
  }>;
};

// ---------------------------

//----------------- VOICE INTENT CONTRACTS ------------
/**
 * A possible addressee of a voice action (a project the task or message can go to).
 */
export type VoiceIntentRecipient = {
  projectId: string;
  projectName: string;
};

/**
 * One interpreted action from a dictated phrase, rendered as an "Понял" card.
 *
 * - `calendar_event`: `start`/`end` are ISO strings with offset or null when the time was
 *   not understood; `whenText` is the phrase as spoken; `who` lists people mentioned.
 * - `project_task`: a task for Claude in a project; `recipient` is the chosen project or
 *   null, `candidates` are the alternatives to pick from.
 * - `message`: plain text for the current dialog.
 * `confidence` is 0..1; `summary` is a short Russian card title.
 */
export type VoiceIntentAction =
  | {
      id: string;
      kind: 'calendar_event';
      summary: string;
      confidence: number;
      title: string;
      eventType: 'meeting' | 'call' | 'task' | 'reminder' | 'other';
      start: string | null;
      end: string | null;
      whenText: string | null;
      who: string[];
    }
  | {
      id: string;
      kind: 'project_task';
      summary: string;
      confidence: number;
      text: string;
      recipient: VoiceIntentRecipient | null;
      candidates: VoiceIntentRecipient[];
    }
  | {
      id: string;
      kind: 'message';
      summary: string;
      confidence: number;
      text: string;
    };

/**
 * Response of `POST /api/voice/intent`. `source` is `claude` when the model produced the
 * parse and `rules` when the rule-based fallback did. `recipients` lists every project the
 * user may pick as the addressee.
 */
export type VoiceIntentResponse = {
  text: string;
  source: 'claude' | 'rules';
  actions: VoiceIntentAction[];
  recipients: VoiceIntentRecipient[];
};

// ---------------------------

//----------------- SEARCH SOURCE CONTRACTS ------------
/**
 * One chat message that contains the search text, extracted from a Claude JSONL transcript
 * by the ripgrep adapter and consumed by the Search service. `text` is the full plain text
 * of the message (the service cuts the snippet); `cwd` is the working directory recorded
 * in the transcript line and is used to find the project when the session is unknown to
 * the database.
 */
export type SearchDialogHit = {
  providerSessionId: string;
  filePath: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
  cwd: string | null;
};

//----------------- MIRAGE: PROVIDER RUNTIME EVENT TAP ------------
/**
 * One thing a provider runtime saw while it drove a session, published on the
 * providers module's runtime event tap (`providerRuntimeEvents`).
 *
 * The tap is read-only and in-process: the runtime emits after it has already
 * forwarded the event to the chat stream, so a listener can never delay or
 * change a run. Consumers (Mirage `agents-live`) fold these into their own
 * read models.
 *
 * - `run_started`: a new SDK process now serves the session (`projectPath` is
 *   the run's working directory).
 * - `sdk_message`: one raw SDK stream message (`message`, untyped on purpose —
 *   the SDK adds fields between versions) plus what the provider normalizer
 *   made of it (`normalized`), so consumers reuse the normalizer's parsing of
 *   undocumented fields such as a workflow's `workflow_progress`.
 * - `permission_requested` / `permission_settled`: a tool approval prompt was
 *   raised / answered (`outcome`), keyed by `requestId`. `toolUseId` is the
 *   tool call that asked, which tells which agent is waiting.
 * - `run_ended`: the process is gone (`reason`); everything it had running
 *   died with it.
 *
 * `sessionId` is the app session id the run is keyed by (the provider id only
 * for legacy callers that never had an app id). `runId` names the SDK process:
 * a replaced process can still wind down after its successor started, so its
 * late events must not be read as the successor's.
 */
export type ProviderRuntimeEvent =
  | {
    type: 'run_started';
    provider: LLMProvider;
    sessionId: string;
    runId: string;
    providerSessionId: string | null;
    projectPath: string | null;
    at: number;
  }
  | {
    type: 'sdk_message';
    provider: LLMProvider;
    sessionId: string;
    runId: string;
    providerSessionId: string | null;
    message: AnyRecord;
    normalized: NormalizedMessage[];
    at: number;
  }
  | {
    type: 'permission_requested';
    provider: LLMProvider;
    sessionId: string;
    runId: string;
    requestId: string;
    toolName: string;
    input: unknown;
    toolUseId: string | null;
    agentId: string | null;
    at: number;
  }
  | {
    type: 'permission_settled';
    provider: LLMProvider;
    sessionId: string;
    runId: string;
    requestId: string;
    outcome: 'allowed' | 'denied' | 'timeout' | 'cancelled';
    at: number;
  }
  | {
    type: 'run_ended';
    provider: LLMProvider;
    sessionId: string;
    runId: string;
    reason: 'completed' | 'aborted' | 'error' | 'superseded';
    error?: string;
    at: number;
  };

/**
 * Listener registered on the runtime event tap. It runs synchronously inside
 * the runtime's stream loop, so it must be quick; a throwing listener is
 * caught and logged, never surfaced to the run.
 */
export type ProviderRuntimeEventListener = (event: ProviderRuntimeEvent) => void;

// ---------------------------
//----------------- MIRAGE: LIVE AGENTS CONTRACT (GET /api/agents/live, ws agents.*) ------------
/**
 * What one agent is doing right now, as the «Агенты» screen colours it.
 *
 * - `pending`  — announced (its Agent/Task call was made) but not started yet,
 *                or a queued workflow agent;
 * - `thinking` — the model is producing its next step (turn start, after a
 *                tool result);
 * - `tool`     — a tool call is in flight (`currentAction` names it);
 * - `waiting`  — blocked on a permission prompt (`permission` is set);
 * - `paused`   — the CLI paused the task;
 * - `done` / `error` / `stopped` — terminal; `stopped` covers a user stop, a
 *                CLI kill and a process that went away under the agent.
 */
export type LiveAgentState =
  | 'pending'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'paused'
  | 'done'
  | 'error'
  | 'stopped';

/**
 * Kind of a node in a session's agent tree.
 *
 * `orchestrator` is the session's main thread (one per session, id `main`);
 * `subagent` an Agent/Task call (foreground or background); `shell` a
 * backgrounded Bash; `workflow` a Workflow run; `workflow_agent` one agent a
 * workflow spawned (child of its `workflow`); `task` any other CLI task type
 * (Monitor, MCP task, …).
 */
export type LiveAgentKind = 'orchestrator' | 'subagent' | 'shell' | 'workflow' | 'workflow_agent' | 'task';

/** One line of an agent's «последние действия». `at` is ISO time. */
export type LiveAgentAction = {
  at: string;
  /** Tool name (`Read`, `Bash`, `mcp__tilda__get_pages`…) or a pseudo-tool: `Старт`, `Ты`, `Готово`, `Ошибка`. */
  tool: string;
  /** One-line human summary: «server/index.ts», «npm test», «участки Арамиль ИЖС». */
  text: string;
  kind: 'tool' | 'start' | 'permission' | 'finish' | 'error';
  /** The tool result came back as an error. */
  failed?: boolean;
};

/** A permission prompt an agent is blocked on. Answer with `agents.permission` / POST /api/agents/permissions/:requestId. */
export type LiveAgentPermission = {
  requestId: string;
  toolName: string;
  /** Same one-line summary the action log uses («rsync dist/ → прод»). */
  summary: string;
  input: unknown;
  receivedAt: string;
};

/**
 * One agent in a session's tree. Ids are stable for the life of the agent:
 * `main` for the orchestrator, `<toolUseId>` of the launching call for
 * subagents/shells/workflows (the CLI task id is in `taskId`),
 * `<workflowNodeId>:<index>` for a workflow agent, `task:<taskId>` for a task
 * with no launching call in view.
 */
export type LiveAgentNode = {
  id: string;
  kind: LiveAgentKind;
  /** Parent node id (`main` for agents the orchestrator launched); null for the orchestrator. */
  parentId: string | null;
  /** CLI task id (the stop handle); null for the orchestrator, workflow agents and not-yet-started calls. */
  taskId: string | null;
  /** The `tool_use` id that launched it (Agent/Task/Bash/Workflow call). */
  toolUseId: string | null;
  /** CLI `parent_task_id` (SDK ≥0.3.302), when reported. */
  parentTaskId: string | null;
  /** 0 for the orchestrator, 1 for its agents, 2 for theirs… (CLI `spawn_depth` when reported, else derived). */
  spawnDepth: number;
  /** Display name: Task `description`, workflow name, workflow agent label, session title for `main`. */
  name: string;
  /** `subagent_type`, workflow phase, «оркестратор», «фоновая команда»… */
  role: string | null;
  /** Full model id last seen for it (`claude-haiku-4-5-…`); null until known. */
  model: string | null;
  /** `opus` | `sonnet` | `haiku` | `fable` | null, derived from `model`, for the coloured chip. */
  modelFamily: string | null;
  state: LiveAgentState;
  /** One line: what it does now («Read server/index.ts», «Bash npm test», «WebSearch: …»), or its last words when thinking. */
  currentAction: string | null;
  /** The task it was given (Agent `prompt` / workflow agent prompt preview), trimmed to ~600 chars. */
  task: string | null;
  /** Runs in the background (outlives the turn). */
  backgrounded: boolean;
  startedAt: string;
  /** Set once terminal. */
  endedAt: string | null;
  /** Work time as the CLI reports it, else wall time from start to end (or to the frame). */
  durationMs: number;
  /** Tokens the agent has used (CLI `total_tokens`; for `main` the current context of the main thread). */
  tokens: number | null;
  /**
   * `main` only: tokens Claude has written in the current run (sum of `output_tokens` over the
   * run's assistant messages) — the «↓ 1.2k» of the chat's turn line. Null for other nodes.
   */
  outputTokens: number | null;
  toolCalls: number;
  /** Last 10 actions, newest first. */
  recentActions: LiveAgentAction[];
  /** Latest progress summary / final result summary from the CLI. */
  summary: string | null;
  /** Error text for `error`. */
  error: string | null;
  /** Set while `waiting`. */
  permission: LiveAgentPermission | null;
  /** Whether a stop request can reach it right now (live process; a CLI task id, or `main`). */
  canStop: boolean;
};

/** A workflow run's phase strip («01 СБОР · готово»). */
export type LiveWorkflowPhase = {
  index: number;
  title: string;
  state: 'queued' | 'running' | 'waiting' | 'done' | 'failed';
  agentIds: string[];
};

/** Workflow details, one per `workflow` node of a session. */
export type LiveWorkflowInfo = {
  nodeId: string;
  name: string;
  phases: LiveWorkflowPhase[];
};

/**
 * Token and cost totals of the live process serving a session, from the SDK
 * `result` messages (cumulative for the process; restart from zero when a new
 * process takes the session).
 */
export type LiveSessionUsage = {
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Per model id, as the SDK's `modelUsage`. */
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    contextWindow: number | null;
  }>;
  /** `result` messages seen (turns, including follow-ups the CLI pushed for background work). */
  turns: number;
};

/**
 * One session on the «Агенты» screen: its orchestrator plus the flat agent
 * list (build the tree with `parentId`).
 *
 * `status`: `running` (a turn is going), `waiting` (some agent waits for a
 * permission), `background` (turn ended, background work still going),
 * `idle` (process alive, nothing running), `ended` (process gone; kept for an
 * hour so finished work stays visible), `external` (a Claude CLI outside the
 * panel works on it — no tree is known).
 */
export type LiveAgentsSession = {
  sessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  projectId: string | null;
  projectName: string;
  projectPath: string | null;
  sessionTitle: string;
  status: 'running' | 'waiting' | 'background' | 'idle' | 'ended' | 'external';
  startedAt: string;
  updatedAt: string;
  /** The `main` node (also `agents[0]`). */
  orchestrator: LiveAgentNode;
  /** Orchestrator first, then agents in start order. */
  agents: LiveAgentNode[];
  workflows: LiveWorkflowInfo[];
  /** Every prompt waiting in this session (also set on the waiting agents). */
  pendingPermissions: Array<LiveAgentPermission & { agentId: string }>;
  usage: LiveSessionUsage | null;
};

/** One row of the «ЛЕНТА» feed (last 100 events across all sessions, newest first). */
export type LiveAgentsFeedEvent = {
  /** Monotonic, unique for the server process. */
  id: number;
  at: string;
  sessionId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  kind: 'start' | 'tool' | 'waiting' | 'resolved' | 'done' | 'error' | 'stopped' | 'turn';
  /** Ready-to-show text: «Bash npm test», «ждёт разрешения: Bash rsync …», «готово». */
  text: string;
};

/** Header counters of the «Агенты» screen. */
export type LiveAgentsStats = {
  /** Agents (orchestrators included) in `thinking` / `tool` / `pending` / `paused`. */
  working: number;
  waiting: number;
  /** Agents that ended `done` in the last hour. */
  doneLastHour: number;
  /** Agents in `error` among the listed sessions. */
  errors: number;
  /** Input + output + cache-creation tokens reported in the last hour (cache reads excluded). */
  tokensLastHour: number;
  /** Distinct projects with a non-ended session. */
  activeProjects: number;
};

/** Body of GET /api/agents/live and of the `agents_snapshot` frame. */
export type LiveAgentsSnapshot = {
  generatedAt: string;
  /** Sequence of the last change folded in; a delta with seq ≤ this is stale. */
  seq: number;
  sessions: LiveAgentsSession[];
  feed: LiveAgentsFeedEvent[];
  stats: LiveAgentsStats;
};

/**
 * Body of the `agents_delta` frame: whole replacements for the sessions that
 * changed (replace by `sessionId`), sessions to drop, feed rows added since
 * the previous frame (newest first) and fresh stats. Coalesced, at most one
 * frame per ~250 ms.
 */
export type LiveAgentsDelta = {
  seq: number;
  generatedAt: string;
  sessions: LiveAgentsSession[];
  removedSessionIds: string[];
  feed: LiveAgentsFeedEvent[];
  stats: LiveAgentsStats;
};

/** Result of a stop / permission action (REST `data` and the ws `agents_action_result`). */
export type LiveAgentsActionResult = { ok: boolean; error: string | null };

/**
 * Frames the `agents-live` module sends on the chat websocket (`/ws`).
 *
 * Client → server (`type`):
 * - `agents.subscribe`    {}  → one `agents_snapshot`, then `agents_delta` frames
 * - `agents.unsubscribe`  {}
 * - `agents.stop`         { sessionId, agentId, requestKey? } — stop one agent (CLI stopTask);
 *                          `agentId: 'main'` stops the whole session like `agents.stop-session`
 * - `agents.stop-session` { sessionId, requestKey? } — stop the turn and every agent of the session
 * - `agents.permission`   { requestId, allow, message?, rememberEntry?, requestKey? }
 * Every action answers with `agents_action_result` echoing `requestKey`.
 */
export type LiveAgentsSocketFrame =
  | { kind: 'agents_snapshot'; snapshot: LiveAgentsSnapshot }
  | { kind: 'agents_delta'; delta: LiveAgentsDelta }
  | ({
    kind: 'agents_action_result';
    action: 'stop' | 'stop-session' | 'permission';
    requestKey: string | null;
  } & LiveAgentsActionResult);

// ---------------------------
//----------------- MIRAGE: SESSION CONTEXT USAGE CONTRACT (GET /api/context/:sessionId) ------------
/** One bar segment / row of the context breakdown («Сообщения 96.4k 9.6%»). */
export type SessionContextCategory = {
  /** SDK category id (`messages`, `mcp_tools`, `skills`, `free_space`, `autocompact_buffer`…), or a slug of the name. */
  id: string;
  name: string;
  tokens: number;
  /** Share of `maxTokens`, 0–100. */
  percentage: number;
  kind: 'used' | 'free' | 'buffer' | 'deferred';
  /** The CLI's colour name for the category (a theme key, not CSS); null for estimates. */
  color: string | null;
  /** Expandable rows, heaviest first: MCP servers for `mcp_tools`, skills for `skills`, agents for `custom_agents`, files for `memory_files`. */
  items: Array<{ name: string; tokens: number }>;
};

/** A file the conversation read since its last compaction (from the transcript; tokens ≈ chars / 4). */
export type SessionContextFile = {
  path: string;
  /** Directory relative to the project, with trailing `/` («data/»), or `''`. */
  dir: string;
  name: string;
  tokens: number;
};

/** Session token totals and cost. */
export type SessionUsageTotals = {
  /** Main-thread totals from the transcript, every assistant message counted once. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  assistantTurns: number;
  /** USD reported by the live process (`result.total_cost_usd`, this process only); null without one. */
  costUsd: number | null;
};

/**
 * Body of GET /api/context/:sessionId.
 *
 * `source`:
 * - `live`       — `Query.getContextUsage()` of the session's running process (`detail` says which mode answered);
 * - `transcript` — no live process: the last main-thread usage row of the transcript (`estimated: true`;
 *                  only `messages` (everything used), `autocompact_buffer` and `free_space` are known).
 * Cached for 10 s per session; `cachedAt` says when it was computed.
 */
export type SessionContextUsage = {
  sessionId: string;
  source: 'live' | 'transcript';
  estimated: boolean;
  detail: 'full' | 'summary' | null;
  model: string | null;
  totalTokens: number;
  maxTokens: number;
  /** 0–100. */
  percentage: number;
  autoCompactThreshold: number | null;
  isAutoCompactEnabled: boolean | null;
  /** `autoCompactThreshold − totalTokens`, floored at 0; null when unknown («769k до автосжатия»). */
  tokensUntilAutoCompact: number | null;
  categories: SessionContextCategory[];
  /** Heaviest MCP tools (top 15). */
  heavyMcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded: boolean | null }>;
  /** Heaviest skills (top 15). */
  heavySkills: Array<{ name: string; source: string; tokens: number }>;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  agents: Array<{ agentType: string; source: string; tokens: number }>;
  files: SessionContextFile[];
  messageBreakdown: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
  } | null;
  session: SessionUsageTotals;
  /** A `/compact` waits in the session's queue (it runs after the current turn). */
  compactQueued: boolean;
  cachedAt: string;
};

/**
 * Body of GET /api/context/:sessionId/size — how big the session's transcript
 * (Claude's `.jsonl`) is on disk. The Kabina chat shows «Большая сессия N МБ»
 * (DarkStates L4) from it. `bytes` is null when the session has no transcript
 * file yet (or it is not a Claude session); the path itself is never returned.
 */
export type SessionTranscriptSize = {
  sessionId: string;
  bytes: number | null;
  /** File modification time (ISO), null without a file. */
  modifiedAt: string | null;
};

/** Body of POST / DELETE /api/context/:sessionId/compact. */
export type SessionCompactResult = {
  /** `/compact` waits in the queue (POST) / no longer does (DELETE). */
  queued: boolean;
  /** The session was idle, so the queue was dispatched right away. */
  dispatchedNow: boolean;
};

/**
 * What the runtime answers for a live `getContextUsage` call: the SDK's
 * `SDKControlGetContextUsageResponse` as a loose record (its shape grows
 * between SDK versions) plus the detail level that produced it. Shared by the
 * providers runtime service and the context-usage module.
 */
export type LiveContextUsageReading = {
  detail: 'full' | 'summary';
  usage: AnyRecord;
};

//----------------- MIRAGE CALENDAR CONTRACTS ------------
/**
 * Kind of a calendar entry (Mirage Х24, DarkCalendar).
 *
 * `call`, `message` and `meeting` are the user's own events. `agent_task` is a
 * task for Claude — a stored event or a scheduled panel message merged in at
 * read time. `server_schedule` is a systemd timer, read-only.
 */
export type CalendarEventType = 'call' | 'message' | 'meeting' | 'agent_task' | 'server_schedule';

/**
 * Lifecycle of a stored calendar event. `no_answer` is a call that did not get
 * through; `cancelled` hides the event from the default listing.
 */
export type CalendarEventStatus = 'planned' | 'done' | 'cancelled' | 'no_answer';

/**
 * Where a calendar item comes from; only `panel` items are editable.
 * `google` is an event the user made in Google Calendar, imported by the sync:
 * shown as a call or meeting, read-only in the panel (only «Отметить сделанным»
 * and «Поручить Claude подготовить», which stay local); change it in Google.
 */
export type CalendarItemSource = 'panel' | 'scheduled_message' | 'systemd' | 'google';

/** Contact attached to a call, message or meeting. All fields are free text. */
export type CalendarContact = {
  name: string | null;
  phone: string | null;
  telegram: string | null;
};

/**
 * One entry of `GET /api/calendar/events`, the shape every calendar screen
 * renders. Recurring events arrive expanded: each occurrence is its own item
 * with `occurrenceOf` set to the stored event id and an `id` of
 * `<eventId>@<startsAt>`; actions on it go to `occurrenceOf`.
 */
export type CalendarItem = {
  id: string;
  source: CalendarItemSource;
  type: CalendarEventType;
  title: string;
  /** UTC ISO instant. */
  startsAt: string;
  /** UTC ISO instant; derived from the type's default length when not stored. */
  endsAt: string;
  projectId: string | null;
  projectName: string | null;
  contact: CalendarContact | null;
  location: string | null;
  note: string | null;
  remindBeforeMin: number | null;
  status: CalendarEventStatus;
  sessionId: string | null;
  /** RRULE subset (`FREQ=DAILY|WEEKLY|MONTHLY;INTERVAL=n;BYDAY=MO,TU;UNTIL=…`). */
  recurrence: string | null;
  occurrenceOf: string | null;
  /**
   * For an occurrence of a series: where the series puts it (UTC ISO, the
   * part after `@` in `id`). Differs from `startsAt` when only this
   * occurrence was moved («Перенести · только это»).
   */
  originalStartsAt?: string | null;
  readOnly: boolean;
  preparedAt: string | null;
  /** True for an imported all-day Google event (`startsAt` is local midnight). */
  allDay: boolean;
  /**
   * Google Calendar link: `pending` while a local change has not reached
   * Google yet, `error` when its last push failed. Null for items that never
   * go to Google (agent tasks, scheduled messages, server timers).
   */
  google: { eventId: string | null; etag: string | null; syncedAt: string | null; pending: boolean; error: string | null } | null;
  /** Set for `source: 'scheduled_message'`. */
  agent: {
    scheduledMessageId: string;
    sessionTitle: string;
    content: string;
    deliveryStatus: 'pending' | 'sent' | 'failed' | 'cancelled';
    failureReason: string | null;
  } | null;
  /** Set for `source: 'systemd'`. */
  server: {
    unit: string;
    activates: string | null;
    description: string | null;
    calendarSpec: string | null;
    lastTriggerAt: string | null;
    lastResult: string | null;
    /** Zone the spec's wall-clock times are read in (spec's own or the server's system zone). */
    timeZone: string | null;
    /** UTC offset of that zone at this firing and now, minutes; they differ across a summer-time switch. */
    utcOffsetMin: number | null;
    currentUtcOffsetMin: number | null;
  } | null;
};

/** Body of `POST /api/calendar/events` and `PATCH /api/calendar/events/:id`. */
export type CalendarEventInput = {
  type?: CalendarEventType;
  title?: string;
  startsAt?: string;
  endsAt?: string | null;
  durationMin?: number;
  projectId?: string | null;
  contact?: Partial<CalendarContact> | null;
  location?: string | null;
  note?: string | null;
  remindBeforeMin?: number | null;
  status?: CalendarEventStatus;
  sessionId?: string | null;
  recurrence?: string | null;
  google?: { eventId?: string | null; etag?: string | null } | null;
};

/**
 * Result of `POST /api/calendar/parse` — a draft the screen shows as
 * "РАСПОЗНАНО: …" and can post to `POST /api/calendar/events` unchanged.
 */
export type CalendarParseResult = {
  /** False when no date or time could be found; `draft` is then null. */
  ok: boolean;
  draft: (Required<Pick<CalendarEventInput, 'type' | 'title' | 'startsAt' | 'durationMin'>> & {
    endsAt: string;
    projectId: string | null;
    projectName: string | null;
    contact: CalendarContact | null;
    remindBeforeMin: number | null;
    recurrence: string | null;
    note: string | null;
  }) | null;
  /** What the phrase actually contained, so the screen can mark guesses. */
  recognized: { type: boolean; date: boolean; time: boolean; contact: boolean; project: boolean; recurrence: boolean };
  /** Human hints such as "телефон не указан". */
  missing: string[];
  /** One line in the DarkCalendar style: "Звонок · вт 27.10 11:00 · [имя]". */
  summary: string | null;
  timeZone: string;
};

/** Result of `POST /api/calendar/events/:id/prepare`. */
export type CalendarPrepareResult = {
  event: CalendarItem;
  projectId: string;
  sessionId: string;
  scheduledMessageId: string;
  /** When the task reaches Claude (UTC ISO); the dispatcher polls every 30 s. */
  scheduledFor: string;
  /** Kabina route of the session: `/p/<projectId>/s/<sessionId>`. */
  sessionUrl: string;
};

/**
 * `GET /api/calendar/sync-status` and `POST /api/calendar/sync` — the Google
 * Calendar badge of DarkCalendar («Google · синхронизировано 2 мин назад»).
 *
 * Panel calls, messages and meetings go to Google; scheduled messages, agent
 * tasks and server timers never do. Google events of the user come back as
 * read-only `source: 'google'` items. `state` is `off` when the sync is not
 * configured (`reason` says why), `syncing` during a run, `error` when the
 * last run failed (`lastError`, a short message without secrets).
 */
export type CalendarSyncStatus = {
  enabled: boolean;
  state: 'off' | 'idle' | 'syncing' | 'error';
  reason: string | null;
  calendarId: string | null;
  /** Google's name of the calendar (its `summary`). */
  calendarName: string | null;
  timeZone: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastFullSyncAt: string | null;
  lastError: string | null;
  /** Panel events whose change has not reached Google yet. */
  pendingPush: number;
  /** Google deletions still waiting. */
  pendingDeletes: number;
  /** Events imported from Google. */
  importedCount: number;
  pollIntervalSec: number;
  /** Set on test stands: only panel events whose title starts with it go to Google. */
  pushTitlePrefix: string | null;
};

// ---------------------------
//----------------- MIRAGE SIGN-IN SECURITY CONTRACTS ------------
/**
 * `POST /api/auth/login` (and `/register`) success. Without a second factor it
 * keeps the upstream `{ success, user, token }` shape. With TOTP on and no
 * remembered device it returns `twoFactorRequired` and a 5-minute
 * `challengeToken` for `POST /api/auth/login/2fa` instead of a token.
 */
export type AuthLoginResult =
  | { success: true; user: { id: number | bigint; username: string }; token: string; twoFactorRequired?: false;
    trustedDevice?: { deviceToken: string; expiresAt: string } }
  | { success: true; twoFactorRequired: true; challengeToken: string; methods: Array<'totp' | 'backup'>;
    user: { username: string } };

/**
 * `error.details` of refused sign-in attempts (`AUTH_INVALID_CREDENTIALS`,
 * `AUTH_INVALID_2FA_CODE`, `AUTH_LOCKED`): how many tries remain before the
 * 15-minute lock, and when locked, how long it lasts.
 */
export type AuthAttemptDetails = {
  attemptsLeft: number;
  maxAttempts: number;
  retryAfterSec: number | null;
  lockedUntil: string | null;
};

/** `GET /api/auth/2fa/status`. */
export type AuthTwoFactorStatus = {
  enabled: boolean;
  enabledAt: string | null;
  pendingSetup: boolean;
  backupCodesLeft: number;
  trustedDevices: number;
};

/** One sign-in of `GET /api/auth/sessions` (DarkSettings → «Активные входы»). */
export type AuthSessionView = {
  id: string;
  /** "MacBook · Chrome", derived from the user agent. */
  deviceLabel: string;
  deviceKind: 'phone' | 'laptop' | 'desktop' | 'unknown';
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

/** One remembered device of `GET /api/auth/trusted-devices`. */
export type AuthTrustedDeviceView = {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};

// ---------------------------
//----------------- MIRAGE SETTINGS CONTRACTS ------------
/**
 * The Kabina settings screen's safe keys (`GET/PATCH /api/mirage-settings`).
 *
 * `claude.artifacts` and `claude.workflows` live in `~/.claude/settings.json`
 * (`env.CLAUDE_CODE_ARTIFACT`, `enableWorkflows`); everything else lives in the
 * panel database. `claude.silenceCeilingMin` is also applied to the running
 * server (`CLAUDE_SESSION_IDLE_TIMEOUT_MIN`) without a restart.
 * PATCH takes any deep subset of this shape and returns the whole of it.
 */
export type MirageSettings = {
  claude: {
    permissionMode: 'default' | 'auto' | 'plan' | 'acceptEdits';
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    artifacts: boolean;
    workflows: boolean;
    silenceCeilingMin: number;
    midTurnMessage: 'inject' | 'queue';
  };
  voice: {
    language: 'ru' | 'en' | 'auto';
    engine: 'yandex' | 'whisper';
    sendOnRelease: boolean;
    speakReplies: boolean;
    hotkey: string;
  };
  notifications: {
    channels: { telegram: boolean; max: boolean; browser: boolean };
    events: { turnComplete: boolean; backgroundDone: boolean; approvalNeeded: boolean; limit80: boolean };
    quietHours: { enabled: boolean; from: string; to: string };
  };
  home: {
    widgets: Array<{ id: 'fav' | 'work' | 'cal' | 'lim' | 'leads' | 'server' | 'deploy'; enabled: boolean }>;
  };
  appearance: {
    theme: 'cabin' | 'light';
    density: 'normal' | 'compact';
  };
  /** «Как тебя называть» (Аккаунт): the home greeting's name; '' — from the login when it is a Russian name. */
  profile: { displayName: string };
};

/** `GET/PATCH /api/mirage-settings` response. */
export type MirageSettingsView = {
  settings: MirageSettings;
  /** Where the two settings.json keys were read from, and whether it is writable. */
  claudeSettings: { path: string; exists: boolean; readable: boolean; error: string | null };
  /** When the panel database copy was last saved (UTC ISO), null if never. */
  savedAt: string | null;
  /**
   * The server process: its user's home folder (what `~` means in paths the panel
   * shows) and whether it runs as root (Claude Code refuses Bypass permissions then).
   */
  server: { homeDir: string; isRoot: boolean };
};

// ---------------------------
//----------------- MIRAGE: TELEGRAM BOT (NOTIFICATIONS) ------------
/**
 * One inline keyboard button of a bot message: either a callback button
 * (`callbackData`, ≤ 64 bytes, answered through `callback_query`) or a link
 * button (`url`). Rows of these make an inline keyboard.
 */
export type TelegramInlineButton = { text: string; callbackData?: string; url?: string };

/** A Telegram chat as the Bot API reports it (only the fields the panel reads). */
export type TelegramChat = {
  id: number;
  type: string;
  username?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
};

/**
 * One update from `getUpdates`, narrowed to what the bot handles: a text
 * message (`/start <code>`) or an inline button press. Every other update kind
 * is acknowledged (its id advances the offset) and ignored.
 */
export type TelegramUpdate = {
  update_id: number;
  message?: { message_id: number; chat: TelegramChat; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { message_id: number; chat: TelegramChat };
  };
};

/**
 * The Bot API calls the panel makes, bound to one bot token. The token stays
 * inside the implementation: it is never part of a result, an error message
 * or a log line. Failures throw `Error`s whose message is the Bot API's own
 * `description` (or a generic network message).
 *
 * Implemented by the notifications module's `createTelegramBotApi`; tests
 * substitute `fetch` underneath it.
 */
export type TelegramBotApi = {
  getMe(): Promise<{ username: string | null }>;
  sendMessage(chatId: string, text: string, keyboard?: TelegramInlineButton[][]): Promise<{ messageId: number }>;
  /** Replaces a sent message's text; `keyboard` omitted removes its buttons. */
  editMessageText(chatId: string, messageId: number, text: string, keyboard?: TelegramInlineButton[][]): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** Long poll: resolves with the next updates from `offset` on, or `[]` after `timeoutSec`. */
  getUpdates(offset: number | null, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
};

/**
 * Where the bot writes: a chat linked through `/start <code>` (`bot`) or, when
 * none is linked, the optional `MIRAGE_TELEGRAM_CHAT_ID` fallback (`env`).
 * Shared by the Telegram link service (which resolves it) and the notifier
 * (which sends to it and accepts button presses only from it).
 */
export type TelegramTargetChat = {
  chatId: string;
  source: 'bot' | 'env';
  username: string | null;
  title: string | null;
  linkedAt: string | null;
};

/** `GET /api/notifications/telegram/status` response data. */
export type TelegramLinkStatus = {
  /** The bot token is present in the server environment. */
  configured: boolean;
  /** This process receives updates (`MIRAGE_TELEGRAM_POLLING=1`); linking needs it. */
  polling: boolean;
  /** From `getMe`; null until the Bot API answered once. */
  botUsername: string | null;
  linked: boolean;
  linkSource: 'bot' | 'env' | null;
  chat: { username: string | null; title: string | null } | null;
  linkedAt: string | null;
};

/** `POST /api/notifications/telegram/link` response data: a one-time code and its deep link. */
export type TelegramLinkCode = {
  code: string;
  /** `https://t.me/<bot>?start=<code>` — opening it and pressing Start links the chat. */
  url: string;
  botUsername: string;
  expiresAt: string;
};
