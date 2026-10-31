/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import { providerRuntimeEvents } from '@/modules/providers/services/provider-runtime-events.service.js';
import {
  getReportedClaudeContextWindow,
  rememberClaudeContextWindow
} from '@/modules/providers/services/provider-token-usage.service.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const activeSessions = new Map();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the map entry it shadows: cleared when the
// session is removed, and reset when a newer run takes the key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map();
// Query instances cancelled via abort-session. The abort handler already sent
// the terminal `complete` (aborted: true) to the client, so the run loop must
// not emit a second one when its generator winds down. Mirage: keyed by the
// process, not the session id — a turn that starts in a new process right
// after a Stop must not inherit (or consume) the stopped process's flag.
const abortedInstances = new WeakSet();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const DEFAULT_BG_WAIT_CEILING_MIN = 30;
// setTimeout overflows (and fires immediately) past 2^31-1 ms, about 24.8 days.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Turns the CLAUDE_SESSION_IDLE_TIMEOUT_MIN value into the background-work
 * ceiling in milliseconds. Missing or unparsable values fall back to 30
 * minutes; anything below one minute is raised to one minute, and anything
 * past what setTimeout can hold is capped there.
 *
 * Exported for the runtime's own tests (claude-sdk-env.test.ts); the runtime
 * re-reads the variable on every use (Mirage), so no restart is needed.
 * @param {string|undefined} rawMinutes - The environment value, in minutes
 * @returns {number} Ceiling in milliseconds
 */
export function resolveBackgroundWaitCeilingMs(rawMinutes) {
  const minutes = Number.parseFloat(rawMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return DEFAULT_BG_WAIT_CEILING_MIN * 60 * 1000;
  }
  return Math.min(Math.max(Math.round(minutes * 60 * 1000), 60 * 1000), MAX_TIMER_DELAY_MS);
}

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, background work releases it as soon as it reports back, and a
// new turn is written into the held process instead of replacing it (Mirage Х5). This ceiling only catches background work
// that never reports at all, so an abandoned session cannot leak a CLI process
// forever. The timer resets on every message, so it measures silence, not total time.
//
// Mirage (Б4): the ceiling is read from CLAUDE_SESSION_IDLE_TIMEOUT_MIN (minutes,
// default 30) so long-running agents can be given more room without a rebuild.
// It is read on every use, not once at load, so the Kabina settings screen
// (mirage-settings module) can change it without a server restart: new CLI
// processes and the next reset of a held process's timer pick it up.
function currentBackgroundWaitCeilingMs() {
  return resolveBackgroundWaitCeilingMs(process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MIN);
}

// How long a turn's end is held back after its `result` when a message was
// pushed into the live process while that turn ran. A `priority: 'next'`
// message that lands during the turn's last model call cannot be folded into
// it, so the CLI runs it as a turn of its own straight after the `result`
// (verified live: the follow-up turn's `system/init` arrives within
// milliseconds). Waiting this long for that turn to start keeps the client's
// run open until the steered message has actually been answered.
const STEERED_TURN_GRACE_MS = 2000;

// How long a turn continued in the live process waits for the CLI to accept
// a model, effort or permission-mode change before treating it as refused.
const LIVE_CONTROL_TIMEOUT_MS = 15000;

// Permission modes from the strictest to the most permissive. A change to a
// mode ranked the same or lower is a tightening, which a live turn must not
// run without (see applyLiveTurnOptions in queryClaudeSDK).
const PERMISSION_MODE_RANK = { plan: 0, dontAsk: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };

function permissionModeRank(mode) {
  return PERMISSION_MODE_RANK[mode] ?? PERMISSION_MODE_RANK.default;
}

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions, resolvedEffort) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Environment for the spawned CLI. Forwards all host env vars (e.g. ANTHROPIC_BASE_URL);
 * since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
 *
 * Claude Code turns the Artifact tools off for SDK-driven sessions unless
 * CLAUDE_CODE_ARTIFACT is set, so a session continued from this UI would lose them.
 * Default it on; a host value (e.g. CLAUDE_CODE_ARTIFACT=0) still wins.
 */
export function buildClaudeSdkEnv(hostEnv = process.env) {
  return {
    CLAUDE_CODE_ARTIFACT: '1',
    ...hostEnv,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(currentBackgroundWaitCeilingMs()),
  };
}

/**
 * Mirage (Б9): the CLI refuses bypassPermissions when it runs as root outside a
 * sandbox it trusts — it prints a line to stderr and exits with code 1, which
 * the panel only showed as a bare failed turn. Mirrors the CLI's own check
 * (root, no IS_SANDBOX=1, no CLAUDE_CODE_BUBBLEWRAP) so the turn can be turned
 * down with an explanation before a process is started.
 */
export const BYPASS_UNDER_ROOT_MESSAGE = 'Режим «Bypass» недоступен: панель запущена от root, а Claude Code под root не даёт '
  + 'пропускать подтверждения. Выберите Default, Auto или «Принимать правки» и отправьте сообщение ещё раз.';

export function isBypassRefusedForRoot(options = {}, hostEnv = process.env, getuid = process.getuid) {
  const { permissionMode, toolsSettings } = options;
  const asksForBypass = permissionMode === 'bypassPermissions'
    || Boolean(toolsSettings?.skipPermissions && permissionMode !== 'plan');
  if (!asksForBypass || typeof getuid !== 'function' || getuid() !== 0) {
    return false;
  }
  return hostEnv.IS_SANDBOX !== '1' && !hostEnv.CLAUDE_CODE_BUBBLEWRAP;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions = {};

  sdkOptions.env = buildClaudeSdkEnv();

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Mirage (Б8): 'default' is passed too. Left out, the CLI falls back to
  // `permissions.defaultMode` from settings.json (`auto` on our server), so
  // «Default» in the panel silently ran without a single permission prompt.
  if (permissionMode) {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 * @param {Object} liveInput - Writes further user messages into the live process
 *   (`steer`, `continueTurn`, `acceptsTurn`); see queryClaudeSDK
 */
function addSession(sessionId, queryInstance, writer = null, releaseInput = null, liveInput = null) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, which would
  // also remove the map entry the new run is about to own.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding) {
    supersededInstances.add(existing.instance);
    // Mirage: a process whose stdin is already closed (its turn ended and it
    // is winding down) cannot take the interrupt — the SDK rejects it with
    // "Query closed before response received" — and needs none.
    const inputStillOpen = existing.liveInput?.inputOpen?.() ?? true;
    if (inputStillOpen) {
      Promise.resolve()
        .then(() => existing.instance.interrupt())
        .catch((error) => {
          if (isQueryClosedError(error)) {
            return;
          }
          console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
        });
    }
    existing.releaseInput?.();
    // Whatever the superseded process had outstanding dies with it and will
    // never report, so the new run starts from an empty task set.
    backgroundWork.clear(sessionId);
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null,
    liveInput: liveInput || carried?.liveInput || null
  });
  // The history reader reports a background agent as running or stopped by
  // whether this entry exists, and the cached history does not see this map.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Lets go of the process an earlier run left holding a session open, so the
 * next turn can take the session over.
 *
 * Closing stdin is not enough on its own: the CLI's wind-down waits for the
 * background agents the process still has going — for up to the ceiling it
 * was started with (currentBackgroundWaitCeilingMs()) — so an abandoned process with an
 * agent outstanding would run next to the process that replaced it for as
 * long as the agent does, both appending to the same session file. Stop the
 * tasks first, while stdin is still open: the SDK drops control requests
 * written after stdin has ended, which is also why the interrupt a later
 * supersede sends to this process cannot do the job.
 *
 * The stops are not awaited — each request is written to the CLI before this
 * returns, and a reply is only missing when the process has already gone.
 * @param {string} sessionId - Session identifier
 */
function releaseHeldSession(sessionId) {
  const held = getSession(sessionId);
  if (!held) {
    return;
  }
  stopOutstandingTasks(sessionId, held.instance);
  held.releaseInput?.();
}

/**
 * Sends a stop for every background task the session's process still has
 * going, without waiting for the replies. Used before stdin is closed —
 * replacing a held process, or a Stop (Mirage) — because the SDK drops
 * control requests written after stdin has ended.
 * @param {string} sessionId - Session identifier
 * @param {Object} instance - The process's SDK query instance
 */
function stopOutstandingTasks(sessionId, instance) {
  for (const task of backgroundWork.outstanding(sessionId)) {
    // A stop that cannot be delivered changes nothing about what happens
    // next: the process is on its way out either way. Guard the synchronous
    // call too, so a failing stop can never skip the release that follows.
    try {
      Promise.resolve(instance?.stopTask?.(task.taskId)).catch(() => {});
    } catch {
      // Same as a rejected stop.
    }
  }
}

/**
 * Whether an SDK control request failed only because the process's input is
 * already closed — the process is on its way out, so there is nothing to stop.
 * @param {unknown} error - The rejection
 * @returns {boolean}
 */
function isQueryClosedError(error) {
  return /Query closed/i.test(String(error?.message ?? error ?? ''));
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
  // No process, no background work: anything still tracked was killed with it.
  backgroundWork.clear(sessionId);
  // See addSession: a page cached while the process was up still says
  // `running` for any agent that never reported back.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * The window a budget is measured against: the one the SDK reported for the
 * session's model when known, else the server-wide CONTEXT_WINDOW setting.
 * @param {number|null|undefined} reportedContextWindow - SDK-reported window
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(reportedContextWindow) {
  if (Number.isFinite(reportedContextWindow) && reportedContextWindow > 0) {
    return reportedContextWindow;
  }
  return parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;
}

/**
 * Reads the context window the SDK measured for the model that served a turn.
 *
 * `result.modelUsage` has one entry per model the turn billed, subagents'
 * included, so the entry has to be the main thread's model. Its key is the id
 * the CLI requested, which for a 1M variant carries a `[1m]` suffix that the
 * assistant rows' `message.model` lacks (`claude-sonnet-5-5[1m]` vs
 * `claude-sonnet-5-5`); newer CLIs also state the bare id as `canonicalModel`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {string|null} mainModel - `message.model` of the turn's main-thread assistant rows
 * @returns {number|null} The reported window, or null when there is none
 */
function readReportedContextWindow(sdkMessage, mainModel) {
  const modelUsage = sdkMessage?.type === 'result' ? sdkMessage.modelUsage : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }

  const reported = Object.entries(modelUsage).filter(
    ([, modelData]) => modelData && typeof modelData === 'object' && readNumber(modelData.contextWindow) > 0
  );
  const exactMatch = reported.find(([modelKey]) => modelKey === mainModel);
  const variantMatch = reported.find(([modelKey, modelData]) => (
    Boolean(mainModel)
    && (modelData.canonicalModel === mainModel || modelKey.replace(/\[[^\]]*\]$/, '') === mainModel)
  ));
  // A turn that billed a single model was served by it, whatever it is called.
  const entry = exactMatch ?? variantMatch ?? (reported.length === 1 ? reported[0] : null);
  return entry ? readNumber(entry[1].contextWindow) : null;
}

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage, reportedContextWindow) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage, reportedContextWindow) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage, reportedContextWindow);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage, reportedContextWindow) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage, reportedContextWindow);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = resolveContextWindow(reportedContextWindow);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// Tool calls that leave work running past the end of a turn. Bash and Agent only
// count when they are backgrounded; the rest defer or watch work by nature.
// Workflow belongs here rather than in a branch of its own: its input schema has
// no foreground option at all, so every call returns a task id immediately and
// reports back in a later turn.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'Workflow']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * Used by the providers module's tests, which pin the tool matching directly:
 * the alternative is driving a whole SDK run to observe whether stdin was held,
 * and the cost of getting this wrong is silently killed background work.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
export function startsBackgroundWork(sdkMessage) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    // A backgrounded subagent outlives the turn exactly like a backgrounded
    // Bash does, so the process has to be held open for it to report back.
    // Agents background by default — `run_in_background` is optional and only
    // an explicit `false` opts out — hence `!== false` rather than `=== true`.
    // A foreground agent must stay out of DEFERRED_WORK_TOOLS: it never pushes
    // a follow-up turn, so it would pin the process for the full ceiling.
    if (block.name === 'Agent') {
      return block.input?.run_in_background !== false;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

// `task_updated` patch statuses after which a task is gone for good. `pending`,
// `running` and `paused` are still outstanding; `killed` is what the CLI
// writes when it stops a task itself (the task notification spells it
// `stopped`).
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Tracks the background tasks each live session still has outstanding, folded
 * from the `system` task events the SDK stream already carries.
 *
 * `startsBackgroundWork` above only knows that a turn *launched* something
 * lasting; this knows what is still running and which task ids it answers to,
 * which is what the running-sessions list and a stop request need once the
 * turn's `result` has gone out and nothing else remembers the session is busy.
 *
 * Verified against a real query (SDK 0.3.165): `task_started` carries
 * `task_id`, `tool_use_id`, `task_type` and `description` for every agent,
 * workflow and backgrounded command (a foreground Bash emits nothing; from
 * 0.3.3xx it does, with `is_backgrounded: false`, and is kept out of the list);
 * `task_notification` settles a task with any status; `task_updated` carries
 * only `task_id` and a patch, and is terminal when the patch's `status` is.
 * Housekeeping tasks the CLI starts on its own have no `tool_use_id` and are
 * not tracked — nothing in the transcript could show them.
 *
 * Exported so the folding can be driven with the four event shapes directly;
 * the runtime keeps one instance keyed like `activeSessions`.
 *
 * @returns {{
 *   apply: (sessionKey: string, message: Object) => void,
 *   hasOutstanding: (sessionKey: string) => boolean,
 *   has: (sessionKey: string, taskId: string) => boolean,
 *   outstanding: (sessionKey: string) => Array<import('@/shared/types.js').BackgroundTaskSummary>,
 *   clear: (sessionKey: string) => void,
 *   list: () => Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>
 * }}
 */
export function createBackgroundWorkTracker() {
  /** @type {Map<string, Map<string, import('@/shared/types.js').BackgroundTaskSummary>>} */
  const sessions = new Map();
  /**
   * Tool-use ids the session's own turns issued. A task started for a call an
   * agent made inside its own transcript — a workflow agent's backgrounded
   * command, say — reaches this stream too, and nothing in the parent
   * transcript could show it; it is kept for stopping but flagged `nested`.
   * @type {Map<string, Set<string>>}
   */
  const ownToolUseIds = new Map();
  /**
   * Mirage: tasks started in the foreground — SDK 0.3.3xx reports a plain
   * foreground Bash with `is_backgrounded: false`, which 0.3.165 did not. The
   * turn blocks on them, so they are not background work; kept aside only so
   * a later `task_updated` that moves one to the background can list it.
   * @type {Map<string, Map<string, import('@/shared/types.js').BackgroundTaskSummary>>}
   */
  const foregroundTasks = new Map();

  const removeFrom = (store, sessionKey, taskId) => {
    const tasks = store.get(sessionKey);
    if (!tasks) {
      return;
    }
    tasks.delete(taskId);
    if (tasks.size === 0) {
      store.delete(sessionKey);
    }
  };
  const remove = (sessionKey, taskId) => {
    removeFrom(sessions, sessionKey, taskId);
    removeFrom(foregroundTasks, sessionKey, taskId);
  };
  const addTo = (store, sessionKey, task) => {
    let tasks = store.get(sessionKey);
    if (!tasks) {
      tasks = new Map();
      store.set(sessionKey, tasks);
    }
    tasks.set(task.taskId, task);
  };

  return {
    apply(sessionKey, message) {
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              let ids = ownToolUseIds.get(sessionKey);
              if (!ids) {
                ids = new Set();
                ownToolUseIds.set(sessionKey, ids);
              }
              ids.add(block.id);
            }
          }
        }
        return;
      }
      if (message?.type !== 'system' || typeof message.task_id !== 'string') {
        return;
      }
      switch (message.subtype) {
        case 'task_started': {
          if (typeof message.tool_use_id !== 'string') {
            return;
          }
          const task = {
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            taskType: message.task_type,
            description: message.description,
            startedAt: Date.now()
          };
          if (typeof message.workflow_name === 'string') {
            task.workflowName = message.workflow_name;
          }
          if (!ownToolUseIds.get(sessionKey)?.has(message.tool_use_id)) {
            task.nested = true;
          }
          addTo(message.is_backgrounded === false ? foregroundTasks : sessions, sessionKey, task);
          return;
        }
        case 'task_notification':
          remove(sessionKey, message.task_id);
          return;
        case 'task_updated': {
          if (TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
            remove(sessionKey, message.task_id);
            return;
          }
          // A foreground task the user (or the CLI) moved to the background.
          const moved = message.patch?.is_backgrounded === true
            ? foregroundTasks.get(sessionKey)?.get(message.task_id)
            : undefined;
          if (moved) {
            removeFrom(foregroundTasks, sessionKey, message.task_id);
            addTo(sessions, sessionKey, moved);
          }
          return;
        }
        default:
      }
    },

    hasOutstanding(sessionKey) {
      return sessions.has(sessionKey);
    },

    has(sessionKey, taskId) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    outstanding(sessionKey) {
      return Array.from(sessions.get(sessionKey)?.values() ?? []);
    },

    clear(sessionKey) {
      sessions.delete(sessionKey);
      foregroundTasks.delete(sessionKey);
      ownToolUseIds.delete(sessionKey);
    },

    list() {
      return Array.from(sessions, ([sessionId, tasks]) => ({
        sessionId,
        tasks: Array.from(tasks.values())
      }));
    }
  };
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.mirage/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them, then parks and
 * yields whatever is pushed later.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * Mirage (Х1, Х5): the stream is also the way into the live process. `push`
 * hands the CLI another SDKUserMessage — with `priority: 'next'` it is folded
 * into the running turn at its next step, or starts a new turn when the CLI is
 * idle — so neither steering nor a turn after a held `result` needs a new
 * process. Messages pushed before `release()` are still delivered; the CLI
 * runs input it already received even after stdin ends.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send first
 * @returns {{ stream: AsyncIterable, push: (message: Object) => boolean, isOpen: () => boolean, release: () => void }}
 *   Stream, its writer (false once released), and its closer
 */
function createHeldPromptStream(messages) {
  const pending = [...messages];
  let wake = null;
  let released = false;

  const stream = (async function* () {
    for (;;) {
      while (pending.length > 0) {
        yield pending.shift();
      }
      if (released) {
        return;
      }
      // Keeps stdin open — the CLI stays alive until release() is called.
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
  })();

  return {
    stream,
    push(message) {
      if (released) {
        return false;
      }
      pending.push(message);
      wake?.();
      return true;
    },
    isOpen: () => !released,
    release() {
      if (released) {
        return;
      }
      released = true;
      wake?.();
    }
  };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId } = options;
  // Re-assigned (like `ws`) when a later turn continues in this process.
  let { sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  let idleReleaseTimer = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // Set when the stream reports a task starting during this turn. Task events
  // are the exact word on what is still running, so when the turn produced
  // any, the tracker decides the hold; `startsBackgroundWork` is the fallback
  // for tools that emit none (Monitor, ScheduleWakeup, CronCreate, TaskCreate)
  // and for an SDK that does not report tasks at all.
  let sawTaskEventThisTurn = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // The window the SDK reported for this session's model (a resumed session
  // starts from the one its last run reported), the model the main thread's
  // assistant rows name, and the budget last published — re-sent with the
  // right total when the turn's `result` is the first to state the window.
  let reportedContextWindow = getReportedClaudeContextWindow(providerSessionId) ?? null;
  let mainThreadModel = null;
  let lastSentTokenBudget = null;
  // Mirage (Х1, Х5): live-input bookkeeping. `cliTurnActive` follows the CLI's
  // own turns (system/init … result); `inputsPushedDuringCliTurn` counts the
  // messages written into the process since the last `result` — any of those
  // can come back as a turn of its own right after the next `result` (see
  // STEERED_TURN_GRACE_MS). `resolveTurnDone` settles the promise that a turn
  // continued in this process (liveInput.continueTurn) handed its caller.
  // `unconsumedLiveUuids` holds the uuids of written-in messages no assistant
  // reply has acknowledged yet, and `livePushedSinceInit` whether anything was
  // written in since the last `system/init` — a Stop uses both to make sure
  // nothing it should cancel runs after it (see liveInput.interruptTurn).
  let cliTurnActive = false;
  // Mirage: when the CLI turn now running began — for a turn the CLI runs on
  // its own after the client's turn ended (see liveInput.ownTurnStartedAt).
  let cliTurnStartedAt = 0;
  let inputsPushedDuringCliTurn = 0;
  let steeredTurnGraceTimer = null;
  let resolveTurnDone = null;
  const unconsumedLiveUuids = new Set();
  let livePushedSinceInit = false;
  // Mirage: CLI turns counted by `system/init`, and each steered message's uuid with the
  // client's steerId and the turn it was written into. One answered by a later turn missed
  // its turn and ran as a request of its own — history shows it as a plain message, so the
  // client is told to drop the «вклинено» mark (`chat_steer_new_turn`).
  let cliTurnSerial = 0;
  const steersByUuid = new Map();
  // Mirage: the uuids of the client's prompt for the turn now running, and
  // whether a frame has named one of them back (init, reply or result carry
  // `user_message_uuids`). A resumed process may first run a turn of its own —
  // verified live for a task stopped by the last Stop: its notification, then
  // init and result naming no prompt — before the turn for the client's
  // prompt. Ending the client's turn at that result left its real turn without
  // a run, so «Стоп» could not reach it (see the `result` branch below).
  let turnPromptUuids = new Set();
  let turnPromptTaken = false;
  let promptUuidsNamedBack = false;
  let cliTurnOfItsOwnExpected = false;

  // Mirage (Б9): a Bypass turn under root would only make the CLI exit; say
  // why instead, and leave a process the session may hold untouched.
  if (isBypassRefusedForRoot(options)) {
    const replySessionId = capturedSessionId || sessionId || null;
    ws.send(createNormalizedMessage({ kind: 'error', content: BYPASS_UNDER_ROOT_MESSAGE, sessionId: replySessionId, provider: 'claude' }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: replySessionId, exitCode: 1 }));
    return;
  }

  // Mirage (Х5, Б3): while an earlier run still holds this session's process
  // open for background work, the new turn is written into that process
  // instead of replacing it, so the agents, workflows and shells it has going
  // keep running and report back. An edited message re-runs the conversation
  // from an anchor, which only a fresh process can do.
  const liveSession = sessionKey() ? getSession(sessionKey()) : null;
  if (liveSession?.liveInput && !options.resumeAnchorId && !options.resumeFromScratch) {
    let continued = null;
    try {
      continued = await liveSession.liveInput.continueTurn(command, options, ws);
    } catch (error) {
      // Reading the attachments failed before anything reached the process;
      // a fresh process would fail the same way. Report it like the main path.
      console.error('SDK query error (live turn):', error);
      ws.send(createNormalizedMessage({ kind: 'error', content: error?.message || String(error), sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        error
      });
      return;
    }
    if (continued) {
      await continued.done;
      return;
    }
  }

  // Fallback: a new turn supersedes any earlier one still holding this
  // session's process open, so held runs cannot stack up across a conversation.
  if (sessionKey()) {
    releaseHeldSession(sessionKey());
  }

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      releasePromptStream();
    }, currentBackgroundWaitCeilingMs());
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  const cancelSteeredTurnGrace = () => {
    if (steeredTurnGraceTimer) {
      clearTimeout(steeredTurnGraceTimer);
      steeredTurnGraceTimer = null;
    }
  };

  // Ends the client's turn after the CLI's `result`: reports `complete` once,
  // then decides whether the process is held for background work or let go.
  // Runs straight from the `result`, or from the steered-turn grace timer
  // when no follow-up turn started after all.
  const settleTurnEnd = () => {
    // The turn is done as far as the client is concerned.
    const abortPending = abortedInstances.has(queryInstance);
    const stillOutstanding = backgroundWork.hasOutstanding(sessionKey());
    if (!turnCompleteSent && !abortPending) {
      turnCompleteSent = true;
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: 'completed'
      });
    } else if (heldForBackgroundWork && !abortPending && !stillOutstanding) {
      // A result after the turn already reported complete means the work we
      // held the process open for has finished and pushed a follow-up turn
      // — the last of it, when nothing else is still running.
      notifyBackgroundWorkCompleted({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary
      });
    }
    // Work started during this turn, or work from an earlier turn that
    // has not settled yet (a follow-up turn reports one task in while
    // another is still going), is still running. Hold the process open
    // so it can finish and report back in a follow-up turn; the ceiling
    // is only a backstop for work that never reports.
    //
    // The release when the last task settles is this same branch on the
    // follow-up turn the CLI pushes for it, not the settling event
    // itself: closing stdin at that moment would cut the turn that
    // relays the task's result.
    //
    // When the turn reported its tasks, the tracker is the whole truth: an
    // Agent call without `run_in_background` is scored as background by
    // `startsBackgroundWork`, but the CLI runs it in the foreground and
    // it has settled before this `result` — holding for it kept a process
    // alive for the full ceiling with nothing outstanding.
    const holdForTurn = sawTaskEventThisTurn ? stillOutstanding : backgroundWorkPending || stillOutstanding;
    backgroundWorkPending = false;
    sawTaskEventThisTurn = false;
    if (holdForTurn) {
      heldForBackgroundWork = true;
      scheduleRelease();
    } else {
      // Either nothing was backgrounded, or the background work just
      // reported in — let the CLI exit now, as it always has.
      heldForBackgroundWork = false;
      releasePromptStream();
    }
    // A turn that continued in this process reports back to its caller.
    if (turnCompleteSent && resolveTurnDone) {
      resolveTurnDone();
      resolveTurnDone = null;
    }
  };

  const armSteeredTurnGrace = () => {
    cancelSteeredTurnGrace();
    steeredTurnGraceTimer = setTimeout(() => {
      steeredTurnGraceTimer = null;
      settleTurnEnd();
    }, STEERED_TURN_GRACE_MS);
    steeredTurnGraceTimer.unref?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance = null;
  // Mirage (Х27): runtime event tap bookkeeping. The key the process's events
  // are published under, set once the run has one (see emitRunStarted).
  let runStartedKey = null;
  let runError = null;
  const runId = createRequestId();
  const emitRunStarted = () => {
    if (runStartedKey || !sessionKey()) {
      return;
    }
    runStartedKey = sessionKey();
    providerRuntimeEvents.emit({
      type: 'run_started', provider: 'claude', sessionId: runStartedKey, runId,
      providerSessionId: capturedSessionId || null, projectPath: options.projectPath || options.cwd || null, at: Date.now(),
    });
  };

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    // Mirage: each carries a uuid, so the CLI can name back the turn that takes it.
    const promptMessages = (await buildPromptMessages(command, options.images, options.files, options.cwd))
      .map((message) => ({ ...message, uuid: crypto.randomUUID() }));
    turnPromptUuids = new Set(promptMessages.map((message) => message.uuid));

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      // Mirage (Х27): the «Агенты» screen shows which agent waits.
      const approvalSessionId = sessionId || capturedSessionId || null;
      if (approvalSessionId) {
        providerRuntimeEvents.emit({
          type: 'permission_requested', provider: 'claude', sessionId: approvalSessionId, runId, requestId, toolName, input,
          toolUseId: context?.toolUseID ?? null, agentId: context?.agentID ?? null, at: Date.now(),
        });
      }
      const emitApprovalSettled = (outcome) => {
        if (approvalSessionId) {
          providerRuntimeEvents.emit({ type: 'permission_settled', provider: 'claude', sessionId: approvalSessionId, runId, requestId, outcome, at: Date.now() });
        }
      };
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        emitApprovalSettled('timeout');
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        emitApprovalSettled('cancelled');
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }
      emitApprovalSettled(decision.allow ? 'allowed' : 'denied');

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // The SDK's own `query`, unless the caller supplies one (tests script the
    // stream to drive the hold logic below without a CLI process).
    const createQuery = context.createQuery ?? query;
    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = heldPrompt.release;
    try {
      queryInstance = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      releasePromptStream = heldPrompt.release;
      queryInstance = createQuery({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    }

    // A turn written into the live process cannot pass new SDK options, so
    // composer changes made since the process started go over the SDK's
    // control requests. They are awaited before the message is written in, so
    // the turn runs with them, and `sdkOptions` (which canUseTool and the next
    // comparison read) only takes a value once the CLI has accepted it. A
    // refused model or effort change is logged and the turn runs with what the
    // process had. Resolves false when a permission mode at least as strict as
    // the current one could not be applied: running the turn in this process
    // would keep a mode the user just took back, so the caller starts a fresh
    // process with the new options instead.
    const applyLiveTurnOptions = async (nextOptions) => {
      const next = mapCliOptionsToSDK({ ...nextOptions, providerSessionId, effortModels });
      const control = async (what, method, argument) => {
        if (typeof queryInstance[method] !== 'function') {
          console.warn(`[Claude SDK] Could not apply ${what} to the live session: not supported`);
          return false;
        }
        let timer = null;
        try {
          await Promise.race([
            Promise.resolve().then(() => queryInstance[method](argument)),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('no reply from the CLI')), LIVE_CONTROL_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
          return true;
        } catch (error) {
          console.warn(`[Claude SDK] Could not apply ${what} to the live session:`, error?.message || error);
          return false;
        } finally {
          clearTimeout(timer);
        }
      };

      if (typeof nextOptions.model === 'string' && nextOptions.model.trim() && next.model !== sdkOptions.model) {
        if (await control('model', 'setModel', next.model)) {
          sdkOptions.model = next.model;
        }
      }

      const nextUltracode = Boolean(next.settings?.ultracode);
      if (next.effort !== sdkOptions.effort || nextUltracode !== Boolean(sdkOptions.settings?.ultracode)) {
        // Both keys together: an effort change sent alone turns ultracode off.
        const flags = { effortLevel: next.effort ?? null, ultracode: nextUltracode };
        if (nextUltracode) {
          flags.enableWorkflows = true;
        }
        if (await control('effort', 'applyFlagSettings', flags)) {
          sdkOptions.effort = next.effort;
          sdkOptions.settings = next.settings;
        }
      }

      const currentMode = sdkOptions.permissionMode ?? 'default';
      const nextMode = next.permissionMode ?? 'default';
      // Mirage (Б8): a process started without a mode runs the settings.json
      // default, which need not be 'default' — any mode a turn names is sent.
      if (nextMode !== currentMode || (next.permissionMode && !sdkOptions.permissionMode)) {
        if (!(await control('permission mode', 'setPermissionMode', nextMode))) {
          // A looser mode that did not apply leaves the stricter one (and its
          // tool lists) in force, which is safe; a stricter one is not.
          return permissionModeRank(nextMode) > permissionModeRank(currentMode);
        }
        sdkOptions.permissionMode = next.permissionMode;
      }

      // canUseTool reads these on every call.
      sdkOptions.allowedTools = next.allowedTools;
      sdkOptions.disallowedTools = next.disallowedTools;
      return true;
    };

    // Mirage (Х1, Х5): the handle other turns use to write into this process.
    const canTakeLiveInput = () => heldPrompt.isOpen()
      && !supersededInstances.has(queryInstance)
      && !abortedInstances.has(queryInstance);
    // Every message written in carries its own uuid, so a Stop can tell from
    // the interrupt receipt whether one of ours is still waiting to run.
    const pushLive = (messages, steerId = null) => messages.every((message) => {
      const uuid = message.uuid || crypto.randomUUID();
      if (!heldPrompt.push({ ...message, uuid, priority: 'next' })) {
        return false;
      }
      unconsumedLiveUuids.add(uuid);
      if (steerId) steersByUuid.set(uuid, { steerId, turn: cliTurnSerial });
      livePushedSinceInit = true;
      return true;
    });
    // Steers and turns reach the process in the order they arrived: each one
    // reads its attachments first, and a quick second message must not
    // overtake a first one that carries images.
    let liveInputChain = Promise.resolve();
    const inArrivalOrder = (work) => {
      const run = liveInputChain.then(work);
      liveInputChain = run.catch(() => {});
      return run;
    };
    const liveInput = {
      /** True between the client's turns while the process still takes input. */
      acceptsTurn: () => canTakeLiveInput() && turnCompleteSent,

      /** False once stdin was closed and the process is winding down. */
      inputOpen: () => heldPrompt.isOpen(),

      /**
       * Mirage: when the turn the CLI is running on its own began — one it
       * pushed after the client's turn had already ended (a background task
       * reporting back, a message that missed its turn) — else null. No chat
       * run covers such a turn, yet «Стоп» must reach it.
       */
      ownTurnStartedAt: () => (turnCompleteSent && cliTurnActive ? cliTurnStartedAt || Date.now() : null),

      /**
       * Folds a message into the client's turn that is running right now: the
       * CLI picks it up at its next step without interrupting the turn. False
       * when no turn of the client's is running or the process stopped taking
       * input — the caller then queues the message as an ordinary next turn.
       */
      steer(steerCommand, steerOptions = {}) {
        return inArrivalOrder(async () => {
          if (!canTakeLiveInput() || turnCompleteSent) {
            return false;
          }
          const messages = await buildPromptMessages(steerCommand, steerOptions.images, steerOptions.files, options.cwd);
          // Re-checked: the turn may have ended while attachments were read.
          if (!canTakeLiveInput() || turnCompleteSent) {
            return false;
          }
          inputsPushedDuringCliTurn += 1;
          if (steeredTurnGraceTimer) {
            // Pushed after the `result` but before the turn was settled: the CLI
            // starts a turn for it, so give that turn time to begin.
            armSteeredTurnGrace();
          }
          return pushLive(messages, typeof steerOptions.steerId === 'string' ? steerOptions.steerId : null);
        });
      },

      /**
       * Runs the client's next turn in this process. Resolves to null when the
       * process cannot take it (a turn is still open, stdin was released, the
       * project changed, a stricter permission mode did not apply), and the
       * caller starts a fresh process instead; otherwise to `{ done }`, which
       * settles when the turn reports complete or the process ends.
       */
      continueTurn(nextCommand, nextOptions = {}, nextWriter) {
        return inArrivalOrder(async () => {
          if (!liveInput.acceptsTurn()) {
            return null;
          }
          if (nextOptions.cwd && options.cwd && path.resolve(nextOptions.cwd) !== path.resolve(options.cwd)) {
            return null;
          }
          const messages = await buildPromptMessages(nextCommand, nextOptions.images, nextOptions.files, options.cwd);
          if (!liveInput.acceptsTurn()) {
            return null;
          }
          if (!(await applyLiveTurnOptions(nextOptions))) {
            return null;
          }
          // Re-checked: the process may have let go while the CLI answered.
          if (!liveInput.acceptsTurn()) {
            return null;
          }

          // Everything from here on belongs to the new turn's run.
          ws = nextWriter;
          const entry = sessionKey() ? getSession(sessionKey()) : null;
          if (entry?.instance === queryInstance) {
            entry.writer = nextWriter;
          }
          if (capturedSessionId && typeof nextWriter?.setSessionId === 'function') {
            nextWriter.setSessionId(capturedSessionId);
          }
          if (typeof nextOptions.sessionSummary === 'string') {
            sessionSummary = nextOptions.sessionSummary;
          }
          turnCompleteSent = false;
          assistantBudgetSent = false;
          // The hold is decided again when this turn ends (settleTurnEnd);
          // until then a stopped task must not close stdin under the turn.
          heldForBackgroundWork = false;
          // A turn is running again; the idle ceiling only measures silence
          // between turns and is re-armed when this one ends.
          if (idleReleaseTimer) {
            clearTimeout(idleReleaseTimer);
            idleReleaseTimer = null;
          }
          if (cliTurnActive) {
            // A follow-up turn the CLI pushed on its own (a task reporting in) is
            // running; the message folds into it or follows it.
            inputsPushedDuringCliTurn += 1;
          }
          const done = new Promise((resolve) => { resolveTurnDone = resolve; });
          const turnMessages = messages.map((message) => ({ ...message, uuid: crypto.randomUUID() }));
          turnPromptUuids = new Set(turnMessages.map((message) => message.uuid));
          turnPromptTaken = false;
          cliTurnOfItsOwnExpected = false;
          pushLive(turnMessages);
          return { done };
        });
      },

      /**
       * Stop: interrupts the running turn and makes sure nothing written into
       * this process runs after it. The interrupt asks the CLI to cancel the
       * queued messages as well; when its receipt still lists one of ours, or
       * a CLI that sends no receipt was written to since its last turn began,
       * the process is closed — a message it already holds would otherwise
       * run as a turn of its own once the interrupt lands.
       */
      async interruptTurn() {
        const receipt = await queryInstance.interrupt({ cancelQueued: true });
        const stillQueued = Array.isArray(receipt?.still_queued) ? receipt.still_queued : null;
        for (const uuid of receipt?.cancelled ?? []) {
          unconsumedLiveUuids.delete(uuid);
        }
        const oursStillQueued = (stillQueued ?? []).some((uuid) => unconsumedLiveUuids.has(uuid));
        if (oursStillQueued || (!stillQueued && livePushedSinceInit)) {
          queryInstance.close?.();
        }
      }
    };

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, releasePromptStream, liveInput);
    }
    emitRunStarted();

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey(), queryInstance, ws, releasePromptStream, liveInput);
        emitRunStarted();

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Mirage: follow the CLI's own turns. Every turn — the client's, a
      // follow-up the CLI pushes for background work, a steered message that
      // missed the turn it was sent into — opens with system/init.
      // `inputsPushedDuringCliTurn` is not reset here: a message written in
      // just before this init may still miss the turn it opens.
      const namedUuids = Array.isArray(message.user_message_uuids)
        ? message.user_message_uuids
        : (message.user_message_uuid ? [message.user_message_uuid] : []);
      if (namedUuids.some((uuid) => turnPromptUuids.has(uuid))) {
        turnPromptTaken = true;
        promptUuidsNamedBack = true;
      }
      // A task reporting in while no CLI turn runs and the prompt is not taken
      // yet gets a turn of its own first (see `turnPromptUuids`).
      if (
        message.type === 'system'
        && message.subtype === 'task_notification'
        && !turnCompleteSent
        && !cliTurnActive
        && !turnPromptTaken
      ) {
        cliTurnOfItsOwnExpected = true;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        cliTurnStartedAt = Date.now();
        cliTurnActive = true;
        livePushedSinceInit = false;
        cliTurnSerial += 1;
        cancelSteeredTurnGrace();
      } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
        if (!cliTurnActive) cliTurnStartedAt = Date.now();
        cliTurnActive = true;
        cancelSteeredTurnGrace();
        // The reply names the written-in messages its turn has taken in.
        const consumed = Array.isArray(message.user_message_uuids)
          ? message.user_message_uuids
          : [message.user_message_uuid];
        for (const uuid of consumed) {
          unconsumedLiveUuids.delete(uuid);
          const steer = steersByUuid.get(uuid);
          if (!steer) continue;
          steersByUuid.delete(uuid);
          if (cliTurnSerial > steer.turn) {
            ws.send(createNormalizedMessage({ kind: 'chat_steer_new_turn', steerId: steer.steerId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          }
        }
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        ws.send(msg);
      }

      if (
        message.type === 'assistant'
        && !message.parent_tool_use_id
        && typeof message.message?.model === 'string'
        && message.message.model !== '<synthetic>'
      ) {
        mainThreadModel = message.message.model;
      }

      // Only a turn's `result` states the window of the model that served it.
      const turnContextWindow = readReportedContextWindow(message, mainThreadModel);
      const contextWindowChanged = Boolean(turnContextWindow) && turnContextWindow !== reportedContextWindow;
      if (turnContextWindow) {
        reportedContextWindow = turnContextWindow;
        rememberClaudeContextWindow(message.session_id || capturedSessionId, turnContextWindow);
        if (contextWindowChanged && sessionKey()) {
          // A history page cached before this turn ended carries the old total.
          sessionHistoryCache.invalidate(sessionKey());
        }
      }

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      let tokenBudgetData = extractTokenBudget(message, reportedContextWindow)
        || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message, reportedContextWindow));
      if (
        !tokenBudgetData
        && turnContextWindow
        && lastSentTokenBudget
        && lastSentTokenBudget.total !== turnContextWindow
      ) {
        // The reading stands; only the window it is measured against was wrong.
        tokenBudgetData = { ...lastSentTokenBudget, total: turnContextWindow };
      }
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        lastSentTokenBudget = tokenBudgetData;
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
      }
      // A foreground command's start (SDK 0.3.3xx) says nothing about work
      // that outlives the turn, so it must not decide the hold.
      if (message.type === 'system' && message.subtype === 'task_started' && message.is_backgrounded !== false) {
        sawTaskEventThisTurn = true;
      }
      backgroundWork.apply(sessionKey(), message);
      if (runStartedKey) {
        providerRuntimeEvents.emit({
          type: 'sdk_message', provider: 'claude', sessionId: runStartedKey, runId,
          providerSessionId: capturedSessionId || null, message, normalized, at: Date.now(),
        });
      }

      // A task the user stopped gets no follow-up turn from the CLI — only its
      // `stopped` notification — so when that was the last outstanding task
      // nothing will ever push the `result` the release below waits for, and
      // the process would sit until the idle ceiling. Release it here. A
      // completed task is different: the CLI relays its result in a turn of
      // its own, which closing stdin now would cut short.
      // Only between turns: a turn running in this process (one continued
      // here, or one the CLI pushed) settles the hold itself when it ends.
      if (
        heldForBackgroundWork
        && turnCompleteSent
        && !cliTurnActive
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && message.status === 'stopped'
        && !backgroundWork.hasOutstanding(sessionKey())
      ) {
        heldForBackgroundWork = false;
        releasePromptStream();
      }

      if (message.type === 'result') {
        cliTurnActive = false;
        // A grace still armed (a turn that ended without opening with init)
        // must not settle this turn a second time.
        cancelSteeredTurnGrace();
        // Mirage: a turn the CLI ran ahead of the client's prompt — expected
        // after a task notification, or known because this process names its
        // prompts back and this turn named none of ours. The prompt's own turn
        // follows right away; the grace settles the turn if none does (an
        // older CLI that names nothing ran the prompt in this very turn).
        const ranAheadOfPrompt = !turnCompleteSent
          && !turnPromptTaken
          && turnPromptUuids.size > 0
          && (cliTurnOfItsOwnExpected || promptUuidsNamedBack);
        cliTurnOfItsOwnExpected = false;
        if (inputsPushedDuringCliTurn > 0 || ranAheadOfPrompt) {
          // A message written in while this turn ran may have missed it; the
          // CLI then answers it in a turn of its own right away. Hold the
          // turn's end back until that turn starts (or clearly does not).
          inputsPushedDuringCliTurn = 0;
          armSteeredTurnGrace();
        } else {
          settleTurnEnd();
        }
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }
    }
    cancelSteeredTurnGrace();

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && abortedInstances.has(queryInstance);
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);
    runError = error;

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    if (supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = abortedInstances.has(queryInstance);
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    cancelSteeredTurnGrace();
    releasePromptStream();
    // A turn that continued in this process must not wait past its end.
    resolveTurnDone?.();
    resolveTurnDone = null;
    if (runStartedKey) {
      const reason = supersededInstances.has(queryInstance) ? 'superseded'
        : abortedInstances.has(queryInstance) ? 'aborted'
          : runError ? 'error' : 'completed';
      providerRuntimeEvents.emit({
        type: 'run_ended', provider: 'claude', sessionId: runStartedKey, runId, reason,
        ...(runError ? { error: String(runError?.message || runError) } : {}), at: Date.now(),
      });
    }
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedInstances.add(session.instance);

    // Mirage: Stop stops the session's background work too, the way replacing
    // a held process does — and before stdin is released below, after which
    // the SDK drops the stop requests.
    stopOutstandingTasks(sessionId, session.instance);

    // Mirage: the live-input interrupt also cancels messages written into the
    // process that the CLI has not taken yet (closing the process if it cannot
    // vouch for that); a plain interrupt would let them run as a new turn.
    try {
      if (session.liveInput?.interruptTurn) {
        await session.liveInput.interruptTurn();
      } else {
        await session.instance.interrupt();
      }
    } catch (error) {
      // Input already closed: the process is on its way out by itself.
      if (!isQueryClosedError(error)) {
        throw error;
      }
      // Mirage: …but it may still be running a turn (one it pushed itself
      // while winding down), which no control request reaches any more.
      // Stop means stop: end the process.
      session.instance.close?.();
    }

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
    session.releaseInput?.();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedInstances.delete(session.instance);
    return false;
  }
}

/**
 * Sessions whose background tasks are still outstanding, with the tasks.
 *
 * A session stays here after its turn's `result` for as long as the process
 * is held open for the work — which is exactly the window in which nothing
 * else (the chat run registry marks the run completed at `result`) knows the
 * session is still busy.
 * @returns {Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>}
 */
function listClaudeSDKBackgroundWork() {
  return backgroundWork.list();
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
async function stopClaudeSDKTask(sessionId, taskId) {
  const session = getSession(sessionId);
  if (!session || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  await session.instance.stopTask(taskId);
  return true;
}

/**
 * Mirage (Х27): the session's live process when it still takes control
 * requests (the SDK drops them once stdin has ended), else null.
 * @param {string} sessionId - App session id
 */
function getControllableSession(sessionId) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') {
    return null;
  }
  return (session.liveInput?.inputOpen?.() ?? true) ? session : null;
}

/**
 * Mirage (Х27): stops any task of the session's live process — a foreground
 * subagent as well as background work, which `stopClaudeSDKTask` alone covers.
 * The CLI answers with the task's `stopped` notification.
 * @param {string} sessionId - App session id
 * @param {string} taskId - The task's `task_id`
 * @returns {Promise<boolean>} False when no live process can take the stop
 */
async function stopAnyClaudeSDKTask(sessionId, taskId) {
  const session = getControllableSession(sessionId);
  if (!session || typeof session.instance.stopTask !== 'function') {
    return false;
  }
  await session.instance.stopTask(taskId);
  return true;
}

/**
 * Mirage (Х29): the context breakdown `/context` shows, asked of the live
 * process. `full` counts every category with the token-count API, which can
 * fail (e.g. without API access); the caller then retries with `summary`.
 * @param {string} sessionId - App session id
 * @param {'full'|'summary'} detail - SDK detail level
 * @returns {Promise<Object|null>} The SDK response, or null without a live process
 */
async function getClaudeSDKContextUsage(sessionId, detail = 'full') {
  const session = getControllableSession(sessionId);
  if (!session || typeof session.instance.getContextUsage !== 'function') {
    return null;
  }
  let timer = null;
  try {
    return await Promise.race([
      session.instance.getContextUsage({ detail }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('no reply from the CLI')), LIVE_CONTROL_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mirage (Х1): folds a message into the turn a session is running right now.
 * The message goes into the live CLI process with `priority: 'next'`, so the
 * agent reads it at its next step and the turn is not interrupted.
 * @param {string} sessionId - App session id
 * @param {string} command - Message text
 * @param {Object} options - `images` / `files` attachment descriptors, already
 *   validated against the upload store by the caller
 * @returns {Promise<boolean>} False when no client turn is running in a live
 *   process that still takes input
 */
async function steerClaudeSDKSession(sessionId, command, options = {}) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || !session.liveInput) {
    return false;
  }
  return session.liveInput.steer(command, options);
}

/**
 * Mirage (Х5): whether the session's live process can take the next turn
 * itself — its last turn ended, and it is still held open (for background
 * work). Such a turn does not replace the process, so nothing it has running
 * has to be waited out or stopped first.
 * @param {string} sessionId - App session id
 * @returns {boolean}
 */
function claudeSDKSessionAcceptsLiveInput(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active' && session.liveInput?.acceptsTurn());
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * When the run behind a session started, or null when no run is up.
 *
 * The history reader uses this to tell a background agent launched by the
 * live process (still able to report back) from one launched by an earlier
 * process that has since exited (never will): a launch row older than the
 * live run cannot belong to it.
 * @param {string} sessionId - Session identifier
 * @returns {number|null} Epoch milliseconds the live run started, or null
 */
function getClaudeSDKSessionStartTime(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active' ? session.startTime : null;
}

/**
 * Mirage: turns the CLI runs on its own in a process of ours after the
 * client's turn ended — a background task reporting back, a message that
 * missed its turn. No chat run covers them, so the running-sessions poll
 * learns of them here (and marks them interruptible: «Стоп» aborts the
 * session's process like any other turn).
 * @returns {Array<{ sessionId: string, startedAt: number }>}
 */
function listClaudeSDKOwnTurns() {
  const turns = [];
  for (const [sessionId, session] of activeSessions) {
    if (session.status !== 'active') {
      continue;
    }
    const startedAt = session.liveInput?.ownTurnStartedAt?.() ?? null;
    if (startedAt !== null) {
      turns.push({ sessionId, startedAt });
    }
  }
  return turns;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
  steer: steerClaudeSDKSession,
  acceptsLiveInput: claudeSDKSessionAcceptsLiveInput,
  stopTask: stopAnyClaudeSDKTask,
  getContextUsage: getClaudeSDKContextUsage,
  isLive: (sessionId) => Boolean(getControllableSession(sessionId)),
  // Mirage: «Стоп» reaches any turn of a process of ours, run or no run.
  canAbort: isClaudeSDKSessionActive,
  listOwnTurns: listClaudeSDKOwnTurns,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  stopClaudeSDKTask,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
