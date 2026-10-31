import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

import { api, ApiRequestError } from '@/shared/api';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import type { BackgroundSendChoice, BackgroundSendPrompt, CommandModalPayload, CostCommandData, HelpCommandData, MarkSessionProcessing, ModelCommandData, QueuedDraft, SessionActivityMap, StatusCommandData,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand,SteerAck,SteerMode,TurnDispatchedAck } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import {
  appendQueuedMessage,
  clearQueuedMessage,
  hydrateChatDrafts,
  readDraftText,
  readQueuedMessage,
  subscribeToChatDrafts,
  writeDraftText,
} from '@/shared/chatDrafts';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';

type UseChatComposerStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => boolean | void;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
};

type MentionableFile = {
  name: string;
  path: string;
};

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};





type SubmitOptions = {
  /**
   * Send the text as a chat message even when it starts with "/" (or is
   * "help"). Set only for the re-submit of a custom command's expanded body:
   * like the Claude Code CLI, that body is never read as a command again, so a
   * body that opens with its own or another command's name cannot loop or
   * run that command instead of being sent.
   */
  skipCommandInterception?: boolean;
};

/** A steer sent into a running turn and still waiting for the server's answer. */
type PendingSteer = {
  sessionId: string;
  draft: QueuedDraft;
  /** The acknowledgement deadline; when it fires the steer falls back to the queue. */
  timer: number | null;
};

/** Why a steer did not go into the turn: refused by the server, never answered, or never sent. */
type SteerFallbackReason = 'refused' | 'timeout' | 'offline';

/** How long a steer waits for `chat_steered` before it is queued for after the turn instead. */
const STEER_ACK_TIMEOUT_MS = 8_000;
/**
 * After a reconnect, how long unacknowledged steers wait for the replayed
 * `chat_steered` (the re-subscribe replays what was missed) before they are queued.
 */
const STEER_RECONNECT_GRACE_MS = 3_000;
/** How long the one-line steer note above the composer stays. */
const STEER_NOTICE_VISIBLE_MS = 5_000;
/**
 * Mirage: how long a «Стоп» waits for the turn to end before it is sent once
 * more, and after that once more before the composer says it did not work.
 */
const STOP_ACK_TIMEOUT_MS = 8_000;
/** Mirage: a note about «Стоп» stays longer than a steer note — it asks for an action. */
const STOP_NOTICE_VISIBLE_MS = 12_000;

/**
 * Mirage: why the running turn cannot be stopped from here, from what the
 * server says about it. The poll names a turn in a Claude CLI the panel does
 * not own (a terminal) with this status.
 */
function describeStopUnavailable(statusText: string | null | undefined): { text: string; line: string; short: string } {
  return statusText === 'Running in the Claude CLI'
    ? { text: 'Ход идёт в терминале Claude Code — остановить его можно только там', line: 'Ход в терминале — стоп только там', short: 'в терминале' }
    : { text: 'Этот ход отсюда не остановить', line: 'Этот ход отсюда не остановить', short: 'стоп недоступен' };
}
/** When to re-check the queued card after a turn ends, ahead of the 5 s poll (the dispatcher sends it at once). */
const QUEUE_RECHECKS_AFTER_TURN_MS = [700, 2_000];
/** A queued message the server claims twice within this window (a lost race) is echoed once. */
const QUEUED_ECHO_REPEAT_WINDOW_MS = 60_000;
/** At most this many acknowledged steerIds are remembered for de-duplicating replays. */
const CONFIRMED_STEER_IDS_LIMIT = 200;

// One id per steer, sent with `chat.steer` and echoed by the server in its
// answer, so each answer settles exactly the steer it is about.
const createSteerId = (): string => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `steer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
);

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await api.assets.uploadFiles(formData);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    // Mirage: Russian fallback; the line lands in the Russian chat feed.
    throw new Error(typeof body?.error === 'string' && body.error ? body.error : 'сервер не принял файлы');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};


const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  return saved
    ? {
        content: saved.content,
        attachments: [],
        uploadedAttachments: saved.attachments ?? saved.images,
        options: saved.options,
      }
    : null;
};

// Whether the card already shows this stored queued message. Send options are
// not compared: the card does not show them.
const showsQueuedMessage = (card: QueuedDraft, stored: QueuedDraft): boolean => (
  card.content === stored.content
  && JSON.stringify(card.uploadedAttachments ?? []) === JSON.stringify(stored.uploadedAttachments ?? [])
);

// Whether a stored queued message is the card's message with more added after
// it (by this tab or another one), rather than a different message: only then
// do the card's browser files still belong to it. A card holds browser files
// only for attachments it uploaded, and every upload gets its own descriptor,
// so the stored message must start with the card's descriptors.
const extendsQueuedMessage = (card: QueuedDraft, stored: QueuedDraft): boolean => {
  const cardUploads = card.uploadedAttachments ?? [];
  const storedUploads = stored.uploadedAttachments ?? [];
  return JSON.stringify(storedUploads.slice(0, cardUploads.length)) === JSON.stringify(cardUploads);
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

/**
 * Enter that CONFIRMS an IME candidate must not also submit.
 *
 * `event.isComposing` alone is not enough: Safari fires `compositionend` BEFORE the confirming
 * Enter's `keydown`, so the flag is already `false` by the time the handler runs. Chrome and
 * Firefox fire it after, which is why the naive guard looks correct on those two and the bug
 * reads as Safari-only. A tight window after `compositionend` covers it — that sequence is
 * synchronous (microseconds), while a human pressing Enter a second time takes >= 100ms and
 * never lands inside it.
 */
const SAFARI_IME_RACE_WINDOW_MS = 30;

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  processingSessions,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const { t } = useTranslation('chat');
  // The composer text together with the chat scope it belongs to. They are one
  // state rather than a value plus a ref because they have to move in lockstep:
  // on a session switch there is one commit where the scope has already changed
  // while the text has not, and anything that persisted the text in that commit
  // would write the previous session's message into the new session's draft.
  // A ref cannot express this — React evaluates a state updater eagerly, so a
  // ref set inside one is already ahead by the time the effects run.
  //
  // Restored synchronously from the draft mirror so a reload shows what was
  // being typed on the first paint rather than after the drafts request lands.
  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);

  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialScope = selectedSession?.id || currentSessionId
      || (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  // Composition is tracked on `window` in the capture phase rather than on the textarea, so a
  // composition that starts in one field and ends after focus moves still closes cleanly.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  useEffect(() => {
    const onStart = () => {
      isComposingRef.current = true;
    };
    const onEnd = () => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
    };
    // `blur` does not bubble, but a capture-phase listener on `window` still sees it on the way
    // down — otherwise a composition abandoned by clicking away would stay open forever.
    const onBlur = () => {
      isComposingRef.current = false;
    };
    window.addEventListener('compositionstart', onStart, true);
    window.addEventListener('compositionend', onEnd, true);
    window.addEventListener('blur', onBlur, true);
    return () => {
      window.removeEventListener('compositionstart', onStart, true);
      window.removeEventListener('compositionend', onEnd, true);
      window.removeEventListener('blur', onBlur, true);
    };
  }, []);

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setInputState((previous) => ({
      scope: draftScopeRef.current,
      value: typeof next === 'function' ? next(previous.value) : next,
    }));
  }, []);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });

  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Which session the in-memory `queuedDraft` belongs to, so editing or
  // deleting the card clears that session's queued message. On a session
  // switch there is one commit where `sessionKey` already points at the new
  // session while `queuedDraft` still holds the old session's draft.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);
  // The card as last rendered, for handlers that must not be rebuilt on every
  // card change (a late steer acknowledgement compares against it).
  const queuedDraftRef = useRef(queuedDraft);
  useEffect(() => {
    queuedDraftRef.current = queuedDraft;
  }, [queuedDraft]);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    // The expanded body is the message itself: it skips slash-command interception.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent(), undefined, { skipCommandInterception: true });
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        // Everything typed after the command name is its argument text, line
        // breaks included (`[\s\S]`, unlike `.`), trimmed as the Claude Code CLI
        // does. `$ARGUMENTS` gets it verbatim; `$1`, `$2`, … get its tokens.
        // The name must open the input and end at whitespace or the end: a pick
        // from the slash menu passes the whole composer, where the name may
        // appear later or inside a longer word ("see /echo2 …" has no arguments).
        const commandMatch = effectiveInput
          .trimStart()
          .match(new RegExp(`^${escapeRegExp(command.name)}(?=\\s|$)([\\s\\S]*)`));
        const rawArgs = commandMatch ? commandMatch[1].trim() : '';
        const args = rawArgs ? rawArgs.split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          rawArgs,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    fileListTruncated,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => readUserPreference(
      PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
      {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      },
    );

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  // Read at send time through a ref: the map changes on every poll, and a
  // submit handler rebuilt that often would re-render the whole composer.
  const processingSessionsRef = useRef(processingSessions);
  useEffect(() => {
    processingSessionsRef.current = processingSessions;
  }, [processingSessions]);

  // Sending over background work asks first. The dialog is rendered by the
  // composer; the submit awaits the user's choice through this resolver.
  const [backgroundSendPrompt, setBackgroundSendPrompt] = useState<BackgroundSendPrompt | null>(null);
  const backgroundSendResolverRef = useRef<((choice: BackgroundSendChoice) => void) | null>(null);

  const askBeforeSendingOverBackgroundWork = useCallback(
    (work: string[]) => new Promise<BackgroundSendChoice>((resolve) => {
      // Only one prompt at a time: a stale one is answered "cancel".
      backgroundSendResolverRef.current?.('cancel');
      backgroundSendResolverRef.current = resolve;
      setBackgroundSendPrompt({ work });
    }),
    [],
  );

  const resolveBackgroundSendPrompt = useCallback((choice: BackgroundSendChoice) => {
    const resolve = backgroundSendResolverRef.current;
    backgroundSendResolverRef.current = null;
    setBackgroundSendPrompt(null);
    resolve?.(choice);
  }, []);

  // An unmounted composer cannot answer; let the pending submit finish.
  useEffect(() => () => {
    backgroundSendResolverRef.current?.('cancel');
    backgroundSendResolverRef.current = null;
  }, []);

  // Persist a message to send "when this finishes" and show it as the queued
  // card. Used while a turn is in flight and when the user chooses to queue
  // behind background work. Attachments must already be uploaded.
  //
  // A session has one queued turn. A message queued while another is still
  // waiting is added after it rather than replacing it, so a burst of
  // follow-ups all reach the provider, in order, as that turn. The server
  // does the append against what it has stored, and the card shows what it
  // returns: exactly what will be sent.
  //
  // The composer empties when the message is taken, as it does for a direct
  // send, not when the server answers: what the user types during that round
  // trip is the next follow-up and must not be erased with this one. If the
  // server refuses the message, it goes back into the composer, in front of
  // anything typed since, and the composer says so, rather than showing a card
  // nothing will send.
  const queueMessage = useCallback(
    async (
      durableDraft: QueuedDraft,
      queuedSessionKey: string | null,
      // A refused steer re-enters the queue long after it left the composer:
      // what the user has typed since belongs to the next message, so the box
      // is left alone.
      queueOptions?: { keepComposer?: boolean },
    ) => {
      const queuedFromOpenComposer = !queuedSessionKey || sessionKeyRef.current === queuedSessionKey;
      if (queueOptions?.keepComposer) {
        // Nothing to clear: the composer was emptied when the steer was sent.
      } else if (queuedFromOpenComposer) {
        setInput('');
        inputValueRef.current = '';
        setAttachedFiles([]);
        setFileErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        if (draftScopeRef.current) {
          writeDraftText(draftScopeRef.current, '');
        }
      } else if (queuedSessionKey && readDraftText(queuedSessionKey) === durableDraft.content) {
        // The user changed sessions during the upload. The composer they left
        // still holds the text as its draft: clear it, or going back and
        // pressing Enter would queue the same message a second time.
        writeDraftText(queuedSessionKey, '');
      }

      let queuedCard = durableDraft;
      let appendedToEarlierMessage = false;
      if (queuedSessionKey) {
        try {
          const { queuedMessage, appended } = await appendQueuedMessage(queuedSessionKey, {
            content: durableDraft.content,
            options: durableDraft.options,
            attachments: durableDraft.uploadedAttachments,
          });
          appendedToEarlierMessage = appended;
          queuedCard = {
            content: queuedMessage.content,
            attachments: durableDraft.attachments,
            uploadedAttachments: queuedMessage.attachments,
            options: queuedMessage.options,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Failed to queue message:', error);
          addMessage({
            type: 'error',
            // A slash command is refused by design, and the reason is said in
            // the user's language; any other failure shows the server's text.
            content: error instanceof ApiRequestError && error.code === 'QUEUED_MESSAGE_NOT_COMBINABLE'
              ? t('input.queue.notCombinable')
              : `Failed to queue message: ${message}`,
            timestamp: new Date(),
          });
          const withTypedSince = (typedSince: string) => (
            [durableDraft.content, typedSince].filter((part) => part.trim()).join('\n\n')
          );
          if (sessionKeyRef.current === queuedSessionKey) {
            const restored = withTypedSince(inputValueRef.current);
            setInput(restored);
            inputValueRef.current = restored;
            if (queuedFromOpenComposer) {
              setAttachedFiles((current) => [...durableDraft.attachments, ...current]);
            }
            if (draftScopeRef.current) {
              writeDraftText(draftScopeRef.current, restored);
            }
          } else {
            // Browser files cannot follow it into a composer that is not open.
            writeDraftText(queuedSessionKey, withTypedSince(readDraftText(queuedSessionKey)));
          }
          return;
        }
      }

      // Recorded under the session the message was queued FOR, and before
      // the session-switch return below — the queued text must be
      // recallable even when it dispatches without this composer.
      recordSentMessage(durableDraft.content, queuedSessionKey);

      // The server owns dispatch after persistence. If the user changed
      // sessions meanwhile, the durable record is already enough; do not
      // attach its UI card to the newly opened composer.
      if (queuedSessionKey && sessionKeyRef.current !== queuedSessionKey) {
        return;
      }

      queuedDraftSessionRef.current = queuedSessionKey;
      // The browser files of the messages queued before this one stay with
      // the card, so editing it brings all of them back into the composer;
      // not when the earlier one was already sent and this one queued alone.
      setQueuedDraft((previous) => ({
        ...queuedCard,
        attachments: appendedToEarlierMessage && previous && extendsQueuedMessage(previous, queuedCard)
          ? [...previous.attachments, ...queuedCard.attachments]
          : queuedCard.attachments,
      }));
    },
    [addMessage, recordSentMessage, resetCommandMenuState, setInput, t],
  );

  // "Steer" (Х1): while a turn runs, Send goes into it at once ('now') or waits
  // in the queue for the turn to finish ('after', the previous behaviour). The
  // choice is a UI preference, so "After turn" survives a reload.
  const [steerMode, setSteerModeState] = useState<SteerMode>(
    () => (readStoredUiPreferences().steerAfterTurn ? 'after' : 'now'),
  );
  const setSteerMode = useCallback((mode: SteerMode) => {
    setSteerModeState(mode);
    // Written through the shared UI preference blob; UiPreferencesProvider
    // picks the change up from the store, so it never writes back a stale value.
    writeUserPreference('uiPreferences', {
      ...readStoredUiPreferences(),
      steerAfterTurn: mode === 'after',
    });
  }, []);
  // A quiet one-line note above the composer, e.g. after a refused steer.
  const [steerNotice, setSteerNotice] = useState<string | null>(null);
  // Steers sent but not yet acknowledged, by their steerId. Each waits for its
  // own `chat_steered` (or its own refusal); one that hears nothing in time,
  // or whose socket dropped, falls back to the queue.
  const pendingSteersRef = useRef(new Map<string, PendingSteer>());
  // steerIds already shown, so a replayed `chat_steered` never adds a second bubble.
  const confirmedSteerIdsRef = useRef(new Set<string>());
  // Steers that already fell back (queued or sent as a normal message), so a
  // late acknowledgement can undo the duplicate instead of adding one.
  const fallenBackSteersRef = useRef(new Map<string, { sessionId: string; content: string; via: 'queue' | 'send' }>());
  // Set once the fallback below exists; the ack timers call it through this ref.
  const steerFallbackRef = useRef<((steerIds: string[], reason: SteerFallbackReason) => void) | null>(null);
  const steerNoticeTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const pendingSteers = pendingSteersRef.current;
    return () => {
      if (steerNoticeTimerRef.current !== null) {
        window.clearTimeout(steerNoticeTimerRef.current);
      }
      pendingSteers.forEach((pending) => {
        if (pending.timer !== null) {
          window.clearTimeout(pending.timer);
        }
      });
    };
  }, []);

  const showSteerNotice = useCallback((notice: string, visibleMs: number = STEER_NOTICE_VISIBLE_MS) => {
    setSteerNotice(notice);
    if (steerNoticeTimerRef.current !== null) {
      window.clearTimeout(steerNoticeTimerRef.current);
    }
    steerNoticeTimerRef.current = window.setTimeout(() => {
      steerNoticeTimerRef.current = null;
      setSteerNotice(null);
    }, visibleMs);
  }, []);

  // (Re)arms one pending steer's wait for its acknowledgement.
  const armSteerAckTimer = useCallback((steerId: string, delayMs: number) => {
    const pending = pendingSteersRef.current.get(steerId);
    if (!pending) {
      return;
    }
    if (pending.timer !== null) {
      window.clearTimeout(pending.timer);
    }
    pending.timer = window.setTimeout(() => {
      pending.timer = null;
      steerFallbackRef.current?.([steerId], 'timeout');
    }, delayMs);
  }, []);

  const submitMessage = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => {
      event.preventDefault();
      const currentInput = queuedSubmission?.content ?? inputValueRef.current;
      const currentAttachments = queuedSubmission?.attachments ?? attachedFiles;
      const previouslyUploadedAttachments = queuedSubmission?.uploadedAttachments ?? [];
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      // A turn is already in flight: stash this message instead of sending it.
      // Upload attached files now so the queued record contains durable image
      // descriptors that can be sent even if another session is open later.
      if (isLoading) {
        // A run can restart in the tiny gap between scheduling and flushing a
        // queued submission. Put the same durable draft back without uploading
        // its files again.
        if (queuedSubmission) {
          queuedDraftSessionRef.current = sessionKey;
          setQueuedDraft(queuedSubmission);
          return;
        }

        const queuedOptions = buildSendOptions(currentInput);
        const queuedSessionKey = sessionKey;
        const steerSessionId = selectedSession?.id || currentSessionId || null;
        // Only Claude can take a message into a running turn; every other
        // provider keeps the queue.
        const shouldSteer = steerMode === 'now'
          && provider === 'claude'
          && Boolean(steerSessionId)
          && !editingAnchorId
          && !currentInput.trimStart().startsWith('/');
        let uploadedAttachments: unknown[] = [];
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'неизвестная ошибка';
          console.error('Queued file upload failed:', error);
          addMessage({
            type: 'error',
            // Mirage: Russian feed line.
            content: `Не удалось загрузить файлы: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (shouldSteer && steerSessionId) {
          const steerDraft: QueuedDraft = {
            content: currentInput,
            attachments: currentAttachments,
            uploadedAttachments,
            options: queuedOptions,
          };
          const steerId = createSteerId();
          const delivered = sendMessage({
            type: 'chat.steer',
            sessionId: steerSessionId,
            steerId,
            content: currentInput,
            options: { ...queuedOptions, attachments: uploadedAttachments },
          });
          // The socket is down: the steer never left, so it goes straight to
          // the durable queue rather than being lost (queueMessage clears the
          // composer as for any queued message).
          if (delivered === false) {
            await queueMessage(steerDraft, steerSessionId);
            showSteerNotice(t('input.steer.offline', {
              defaultValue: 'No connection, queued for after the turn',
            }));
            return;
          }
          pendingSteersRef.current.set(steerId, { sessionId: steerSessionId, draft: steerDraft, timer: null });
          armSteerAckTimer(steerId, STEER_ACK_TIMEOUT_MS);
          recordSentMessage(currentInput, steerSessionId);
          setInput('');
          inputValueRef.current = '';
          resetCommandMenuState();
          setAttachedFiles([]);
          setFileErrors(new Map());
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          if (draftScopeRef.current) {
            writeDraftText(draftScopeRef.current, '');
          }
          return;
        }

        await queueMessage({
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments,
          options: queuedOptions,
        }, queuedSessionKey);
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (!submitOptions?.skipCommandInterception && (commandInput.startsWith('/') || isHelpAlias)) {
        // The name ends at the first whitespace of any kind, so "/cmd" followed
        // by a line break still runs /cmd (the Claude Code CLI splits the same way).
        const firstWhitespace = commandInput.search(/\s/);
        const commandName = isHelpAlias
          ? '/help'
          : firstWhitespace > 0 ? commandInput.slice(0, firstWhitespace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          recordSentMessage(currentInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      const messageContent = currentInput;

      let uploadedAttachments = previouslyUploadedAttachments;
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'неизвестная ошибка';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            // Mirage: Russian feed line.
            content: `Не удалось загрузить файлы: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        try {
          const response = await api.providers.createSession({
            provider,
            projectPath: resolvedProjectPath,
            initialMessage: messageContent,
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          const returnedSessionName = typeof body?.data?.sessionName === 'string'
            ? body.data.sessionName.trim()
            : '';
          if (returnedSessionName) {
            createdSessionName = returnedSessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: createdSessionName,
        });
      }

      // A new turn replaces the CLI process a session's background work runs
      // under: the agents, workflows and commands it still has going are
      // stopped, or finish where nothing is listening. Sending is the user's
      // call, but not one to make for them — and queueing behind the work,
      // which the server holds until it finishes, is the safe alternative.
      const backgroundActivity = processingSessionsRef.current?.get(targetSessionId);
      if (backgroundActivity?.background) {
        const work = ownBackgroundTasks(backgroundActivity.tasks ?? [])
          .map((task) => describeBackgroundTask(task, t));
        const choice = await askBeforeSendingOverBackgroundWork(work);
        if (choice === 'cancel') {
          return;
        }
        if (choice === 'queue') {
          if (queuedSubmission) {
            queuedDraftSessionRef.current = sessionKey;
            setQueuedDraft(queuedSubmission);
            return;
          }
          // Attachments were uploaded above; queue the same descriptors.
          await queueMessage({
            content: currentInput,
            attachments: currentAttachments,
            uploadedAttachments,
            options: buildSendOptions(currentInput),
          }, targetSessionId);
          return;
        }
      }

      const attachmentRecords = uploadedAttachments as ChatAttachment[];
      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
        images: attachmentRecords.filter(isImageAttachment),
        files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
        timestamp: new Date(),
        // Tags this echo as the replacement, so the truncation the server
        // broadcasts a moment later cuts the turns being replaced without
        // taking the message the user just sent with them.
        ...(editingAnchorId ? { replacesAnchorId: editingAnchorId } : {}),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      sendMessage({
        // Replacing an already-sent message is its own frame: it changes the
        // shape of the conversation, so it gets validated separately and can
        // report why it was refused.
        type: editingAnchorId ? 'chat.edit-send' : 'chat.send',
        sessionId: targetSessionId,
        ...(editingAnchorId ? { anchorId: editingAnchorId } : {}),
        content: messageContent,
        options: {
          ...(queuedSubmission?.options ?? buildSendOptions(messageContent)),
          attachments: uploadedAttachments,
        },
      });
      setEditingAnchorId(null);

      // Recorded under the (possibly just-allocated) session id, so the first
      // message of a new chat lands in the history of the session the user is
      // navigated to. Queued drafts were recorded when they were queued; the
      // consecutive-duplicate check keeps this second call a no-op.
      recordSentMessage(currentInput, targetSessionId);
      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      setAttachedFiles([]);
      setFileErrors(new Map());
      setIsTextareaExpanded(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, '');
      }
    },
    [
      selectedSession,
      askBeforeSendingOverBackgroundWork,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      editingAnchorId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      queueMessage,
      recordSentMessage,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
      steerMode,
      showSteerNotice,
      armSteerAckTimer,
      t,
    ],
  );

  // Chat scopes with a submit still awaiting its upload or, for a brand-new
  // chat, its session id. The composer does not change until that returns (the
  // text stays, send stays enabled), so on a slow server the user submits
  // again — and each extra submit of a new chat allocated its own session and
  // sent it the same first message.
  const submittingScopesRef = useRef(new Set<string>());

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => {
      const scope = draftScopeRef.current ?? '';
      if (submittingScopesRef.current.has(scope)) {
        // Still cancel the event: an ignored form submit must not reload the page.
        event.preventDefault();
        return;
      }
      submittingScopesRef.current.add(scope);
      try {
        await submitMessage(event, queuedSubmission, submitOptions);
      } finally {
        submittingScopesRef.current.delete(scope);
      }
    },
    [submitMessage],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // The last queued message echoed into the transcript, so a claim the server
  // undoes and repeats (a lost race for the session) is not echoed twice.
  const lastQueuedEchoRef = useRef<{ sessionId: string; content: string; at: number } | null>(null);

  // The card left the server's queue because the dispatcher sent it: show it
  // in the transcript now, as a direct send does, rather than only when the
  // turn it started has finished and the history is fetched again. The echo
  // is an ordinary local row, retired by the persisted turn when it arrives.
  const echoDispatchedQueuedMessage = useCallback((
    sessionId: string,
    message: { content: string; attachments?: unknown[]; at?: string },
    // Mirage: the server's own `turn_dispatched` frame is exact and already
    // de-duplicated by the caller; only the poll's guess needs the window.
    options: { checkRecentEcho?: boolean } = {},
  ) => {
    if (sessionKeyRef.current !== sessionId || (!message.content.trim() && !message.attachments?.length)) {
      return;
    }
    const lastEcho = lastQueuedEchoRef.current;
    if (
      options.checkRecentEcho !== false
      && lastEcho
      && lastEcho.sessionId === sessionId
      && lastEcho.content === message.content
      && Date.now() - lastEcho.at < QUEUED_ECHO_REPEAT_WINDOW_MS
    ) {
      return;
    }
    lastQueuedEchoRef.current = { sessionId, content: message.content, at: Date.now() };
    const attachmentRecords = (message.attachments ?? []) as ChatAttachment[];
    addMessage({
      type: 'user',
      content: message.content,
      images: attachmentRecords.filter(isImageAttachment),
      files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
      timestamp: message.at ? new Date(message.at) : new Date(),
    });
    setIsUserScrolledUp(false);
    setTimeout(() => scrollToBottom(), 100);
  }, [addMessage, scrollToBottom, setIsUserScrolledUp]);

  // The VPS dispatcher owns sending. While the card is visible, periodically
  // reconcile it with the server, so the UI notices when the server claims it
  // or another tab adds to it.
  useEffect(() => {
    if (!sessionKey || !queuedDraft) {
      return;
    }
    let cancelled = false;
    const reconcile = async () => {
      await hydrateChatDrafts();
      if (cancelled) {
        return;
      }
      if (!readQueuedMessage(sessionKey)) {
        // Gone from the server without this tab editing or deleting it (those
        // clear the card themselves): the dispatcher has sent it.
        const card = queuedDraftRef.current;
        cancelled = true;
        queuedDraftSessionRef.current = sessionKey;
        setQueuedDraft(null);
        if (card) {
          echoDispatchedQueuedMessage(sessionKey, {
            content: card.content,
            attachments: card.uploadedAttachments,
          });
        }
        return;
      }
      // Another tab may have added to the queued message; the card shows what
      // will be sent, so it follows the server's copy.
      const stored = restoreQueuedDraft(sessionKey);
      if (stored) {
        setQueuedDraft((card) => {
          if (!card || showsQueuedMessage(card, stored)) {
            return card;
          }
          // This tab's browser files stay with its part of the message, so
          // editing the card still brings them back into the composer.
          return extendsQueuedMessage(card, stored) ? { ...stored, attachments: card.attachments } : stored;
        });
      }
    };
    const timer = setInterval(() => void reconcile(), 5_000);
    // The dispatcher sends a queued turn as soon as the running one ends, so
    // once the turn is over look sooner than the next poll: the card goes and
    // the message shows in the transcript within about a second.
    const quickChecks = isLoading
      ? []
      : QUEUE_RECHECKS_AFTER_TURN_MS.map((delay) => window.setTimeout(() => void reconcile(), delay));
    // A hidden tab's timers are throttled (to about once a minute after a few
    // minutes), so its card can be far behind; catch up as soon as it is shown.
    const reconcileWhenShown = () => {
      if (document.visibilityState === 'visible') {
        void reconcile();
      }
    };
    document.addEventListener('visibilitychange', reconcileWhenShown);
    return () => {
      cancelled = true;
      clearInterval(timer);
      quickChecks.forEach((quickCheck) => window.clearTimeout(quickCheck));
      document.removeEventListener('visibilitychange', reconcileWhenShown);
    };
  }, [echoDispatchedQueuedMessage, isLoading, queuedDraft, sessionKey]);

  // `turn_dispatched` frames already handled, by session and seq, so a replay
  // after a reconnect does not show the message twice.
  const handledDispatchesRef = useRef(new Set<string>());

  /**
   * Mirage: the server just sent a queued (or scheduled) message as a new turn
   * and says so on the session's stream. The card goes now, not on the next
   * poll, and the message shows in the transcript the way a direct send does.
   */
  const handleTurnDispatched = useCallback((ack: TurnDispatchedAck, seq?: number) => {
    if (typeof seq === 'number') {
      const key = `${ack.sessionId}\u0000${seq}`;
      if (handledDispatchesRef.current.has(key)) {
        return;
      }
      handledDispatchesRef.current.add(key);
    }

    const showsSentCard = () => {
      const card = queuedDraftRef.current;
      return Boolean(card) && queuedDraftSessionRef.current === ack.sessionId;
    };
    if (ack.origin === 'queue' && showsSentCard() && queuedDraftRef.current?.content === ack.content) {
      queuedDraftRef.current = null;
      setQueuedDraft(null);
    }
    // The server has already taken the message off its queue; bring this
    // page's copy in line, and drop a card that showed an older version of it.
    if (ack.origin === 'queue') {
      void hydrateChatDrafts().then(() => {
        if (showsSentCard() && !readQueuedMessage(ack.sessionId)) {
          queuedDraftRef.current = null;
          setQueuedDraft(null);
        }
      });
    }

    echoDispatchedQueuedMessage(
      ack.sessionId,
      { content: ack.content, attachments: ack.attachments, at: ack.at },
      { checkRecentEcho: false },
    );
  }, [echoDispatchedQueuedMessage]);

  // Editing or deleting the card takes the message off the server's queue at
  // once, before the dispatcher's next poll can send it.
  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    if (queuedDraftSessionRef.current) {
      clearQueuedMessage(queuedDraftSessionRef.current);
    }
    setQueuedDraft(null);
    setInput(queuedDraft.content);
    inputValueRef.current = queuedDraft.content;
    setAttachedFiles(queuedDraft.attachments);
    textareaRef.current?.focus();
  }, [queuedDraft]);

  const deleteQueuedDraft = useCallback(() => {
    if (queuedDraftSessionRef.current) {
      clearQueuedMessage(queuedDraftSessionRef.current);
    }
    setQueuedDraft(null);
  }, []);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    return subscribeToChatDrafts(restoreDraft);
  }, [draftScope]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  // The card is never written back to storage: the server owns the queued
  // message, and this page's copy of it may already be out of date (sent, or
  // added to from another tab). Queueing appends on the server; editing and
  // deleting clear it there.

  // Switching sessions swaps in that session's queued draft. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        const endedJustNow =
          performance.now() - lastCompositionEndAtRef.current < SAFARI_IME_RACE_WINDOW_MS;
        if (event.nativeEvent.isComposing || isComposingRef.current || endedJustNow) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  // Whether a session is in the middle of a turn right now (background work
  // after the turn does not count: a message then starts a new turn).
  const isSessionRunning = useCallback((sessionId: string): boolean => {
    const activity = processingSessionsRef.current?.get(sessionId);
    return Boolean(activity && !activity.background);
  }, []);

  // Steers that did not go into the turn. If the turn is already over and the
  // session is the one open, the first is sent as an ordinary message right
  // away (no waiting for the dispatcher's poll); everything else is queued for
  // after the turn, leaving whatever the user has typed since alone.
  const fallBackSteers = useCallback((steerIds: string[], reason: SteerFallbackReason) => {
    const steers = steerIds
      .map((steerId) => {
        const pending = pendingSteersRef.current.get(steerId);
        if (!pending) {
          return null;
        }
        if (pending.timer !== null) {
          window.clearTimeout(pending.timer);
        }
        pendingSteersRef.current.delete(steerId);
        return { steerId, ...pending };
      })
      .filter((steer): steer is { steerId: string } & PendingSteer => steer !== null);
    if (steers.length === 0) {
      return;
    }

    // A direct send empties the composer and would turn into an edit-send
    // while a message is being edited, so it is used only when the composer
    // holds nothing of the user's.
    const composerIsFree = !inputValueRef.current.trim() && attachedFiles.length === 0 && !editingAnchorId;
    let sentDirectly = false;
    let queuedAny = false;
    steers.forEach(({ steerId, sessionId, draft }) => {
      const canSendNow = !sentDirectly
        && composerIsFree
        && sessionKeyRef.current === sessionId
        && !isSessionRunning(sessionId)
        && !submittingScopesRef.current.has(draftScopeRef.current ?? '')
        && Boolean(handleSubmitRef.current);
      if (canSendNow) {
        sentDirectly = true;
        fallenBackSteersRef.current.set(steerId, { sessionId, content: draft.content, via: 'send' });
        void handleSubmitRef.current?.(createFakeSubmitEvent(), draft, { skipCommandInterception: true });
        return;
      }
      queuedAny = true;
      fallenBackSteersRef.current.set(steerId, { sessionId, content: draft.content, via: 'queue' });
      void queueMessage(draft, sessionId, { keepComposer: true });
    });

    if (queuedAny) {
      showSteerNotice(reason === 'timeout'
        ? t('input.steer.timeout', { defaultValue: 'No answer to the steer, queued for after the turn' })
        : reason === 'offline'
          ? t('input.steer.offline', { defaultValue: 'No connection, queued for after the turn' })
          : t('input.steer.unavailable', {
            defaultValue: 'Could not steer into the turn, queued for after it finishes',
          }));
    }
  }, [attachedFiles.length, editingAnchorId, isSessionRunning, queueMessage, showSteerNotice, t]);
  useEffect(() => {
    steerFallbackRef.current = fallBackSteers;
  }, [fallBackSteers]);

  /**
   * The server took a steer into the running turn: show it as a user message
   * tagged "steered". Matched by its steerId; an answer without one (an older
   * server) falls back to the first pending steer of that session with the
   * same text, then to its oldest.
   */
  const handleSteered = useCallback((ack: SteerAck) => {
    const { sessionId, content, at, steerId } = ack;
    if (steerId) {
      // A replay after a reconnect, or a second tab's echo: shown once only.
      if (confirmedSteerIdsRef.current.has(steerId)) {
        return;
      }
      confirmedSteerIdsRef.current.add(steerId);
      if (confirmedSteerIdsRef.current.size > CONFIRMED_STEER_IDS_LIMIT) {
        const oldest = confirmedSteerIdsRef.current.values().next().value;
        if (oldest !== undefined) {
          confirmedSteerIdsRef.current.delete(oldest);
        }
      }
    }

    let matchedSteerId: string | null = null;
    if (steerId) {
      matchedSteerId = pendingSteersRef.current.has(steerId) ? steerId : null;
    } else {
      const sameSession = [...pendingSteersRef.current.entries()]
        .filter(([, pending]) => pending.sessionId === sessionId);
      const sameText = sameSession.find(([, pending]) => pending.draft.content === content);
      matchedSteerId = (sameText ?? sameSession[0])?.[0] ?? null;
    }

    const matched = matchedSteerId ? pendingSteersRef.current.get(matchedSteerId) : undefined;
    if (matchedSteerId && matched) {
      if (matched.timer !== null) {
        window.clearTimeout(matched.timer);
      }
      pendingSteersRef.current.delete(matchedSteerId);
    }

    // The answer came after the steer had already fallen back. It did reach
    // the turn, so take the queued copy back when it is still exactly that
    // message; a copy already sent as a normal message has its own bubble.
    const fallenBack = steerId ? fallenBackSteersRef.current.get(steerId) : undefined;
    if (steerId && fallenBack) {
      fallenBackSteersRef.current.delete(steerId);
      if (fallenBack.via === 'send') {
        return;
      }
      const card = queuedDraftRef.current;
      if (card && queuedDraftSessionRef.current === fallenBack.sessionId && card.content === fallenBack.content) {
        clearQueuedMessage(fallenBack.sessionId);
        setQueuedDraft(null);
      } else {
        console.warn('[Chat] A steer was acknowledged after it had been queued; the queued copy stays.');
      }
    }

    // Another session's steer shows up from its history when it is opened.
    if (sessionId !== (selectedSession?.id || currentSessionId || null)) {
      return;
    }
    const attachmentRecords = (matched?.draft.uploadedAttachments ?? ack.attachments ?? []) as ChatAttachment[];
    addMessage({
      type: 'user',
      content,
      images: attachmentRecords.filter(isImageAttachment),
      files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
      timestamp: at ? new Date(at) : new Date(),
      steered: true,
      // Mirage: the server names it back if it runs as a turn of its own.
      steerId,
    });
    setIsUserScrolledUp(false);
    setTimeout(() => scrollToBottom(), 100);
  }, [addMessage, currentSessionId, scrollToBottom, selectedSession?.id, setIsUserScrolledUp]);

  /**
   * The server refused a steer (the turn cannot take one). With a steerId only
   * that steer falls back; without one (an older server) every pending steer
   * of the session does, as before.
   */
  const handleSteerUnavailable = useCallback((sessionId: string, steerId?: string) => {
    if (steerId) {
      const pending = pendingSteersRef.current.get(steerId);
      if (pending && pending.sessionId === sessionId) {
        fallBackSteers([steerId], 'refused');
      }
      return;
    }
    const refused = [...pendingSteersRef.current.entries()]
      .filter(([, pending]) => pending.sessionId === sessionId)
      .map(([id]) => id);
    fallBackSteers(refused, 'refused');
  }, [fallBackSteers]);

  /**
   * The socket came back. A steer sent before the drop may or may not have
   * arrived: the re-subscribe replays its `chat_steered` if it did, so each
   * unacknowledged steer gets a short grace period and is then queued.
   */
  const handleSteerConnectionRestored = useCallback(() => {
    pendingSteersRef.current.forEach((_pending, steerId) => {
      armSteerAckTimer(steerId, STEER_RECONNECT_GRACE_MS);
    });
  }, [armSteerAckTimer]);

  // Mirage: the «Стоп» watchdog (see handleAbortSession); it reads the
  // session's activity through processingSessionsRef after the fact.
  const stopWatchRef = useRef<{ sessionId: string; timer: number } | null>(null);
  const clearStopWatch = useCallback(() => {
    if (stopWatchRef.current) {
      window.clearTimeout(stopWatchRef.current.timer);
      stopWatchRef.current = null;
    }
  }, []);
  useEffect(() => clearStopWatch, [clearStopWatch]);

  const activeStopSessionId = selectedSession?.id || currentSessionId || null;
  const activeStopActivity = activeStopSessionId ? processingSessions?.get(activeStopSessionId) : undefined;
  // Mirage: a running turn that cannot be stopped from here says why — the
  // «Стоп» button is shown inactive with this reason instead of doing nothing.
  const stopUnavailableReason = isLoading && !canAbortSession
    ? describeStopUnavailable(activeStopActivity?.statusText)
    : null;

  const handleAbortSession = useCallback(() => {
    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!canAbortSession) {
      // Mirage: never a silent «Стоп».
      if (isLoading) {
        showSteerNotice(describeStopUnavailable(
          targetSessionId ? processingSessionsRef.current?.get(targetSessionId)?.statusText : null,
        ).text, STOP_NOTICE_VISIBLE_MS);
      }
      return;
    }

    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // Mirage: the turn ends with its `complete`; until then the stop is
    // watched. Sent once more if nothing came back, then the composer says so.
    const stillRunning = () => {
      const activity = processingSessionsRef.current?.get(targetSessionId);
      return Boolean(activity && !activity.background);
    };
    const sendStop = (attempt: number) => {
      clearStopWatch();
      // The backend resolves the provider from the session row, so no provider
      // field is needed here.
      const sent = sendMessage({
        type: 'chat.abort',
        sessionId: targetSessionId,
      });
      if (sent === false) {
        showSteerNotice('Нет связи с сервером — «Стоп» не ушёл. Удержи ещё раз, когда связь вернётся', STOP_NOTICE_VISIBLE_MS);
        return;
      }
      const timer = window.setTimeout(() => {
        stopWatchRef.current = null;
        if (!stillRunning()) {
          return;
        }
        if (attempt === 0) {
          sendStop(1);
          return;
        }
        showSteerNotice('Не удалось остановить ход — сервер не ответил. Удержи «Стоп» ещё раз', STOP_NOTICE_VISIBLE_MS);
      }, STOP_ACK_TIMEOUT_MS);
      stopWatchRef.current = { sessionId: targetSessionId, timer };
    };
    sendStop(0);
  }, [canAbortSession, clearStopWatch, currentSessionId, isLoading, selectedSession?.id, sendMessage, showSteerNotice]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
    },
    [],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [setInput]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    setInput('');
    inputValueRef.current = '';
  }, [setInput]);

  return {
    input,
    setInput,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    fileListTruncated,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    stopUnavailableReason,
    steerMode,
    setSteerMode,
    steerNotice,
    handleSteered,
    handleTurnDispatched,
    handleSteerUnavailable,
    handleSteerConnectionRestored,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
