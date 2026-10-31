import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode, UIEventHandler } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import '@/modules/kabina-chat/kabinaChat.css';
import { CommandResultModal, FileLinkContext, useChatController } from '@/modules/chat';
import { useFeedFileLinks } from '@/modules/kabina-chat/FilePathLink';
import { BigSessionNotice, BypassRootCard, NotificationBell, Sheet, useBigSessionNotice, useClaimKabinaHud } from '@/modules/kabina';
import { useAgentsLive } from '@/modules/kabina-agents';
import ArtifactPanel from '@/modules/kabina-chat/ArtifactPanel';
import ChatFeed from '@/modules/kabina-chat/ChatFeed';
import type { FeedActions } from '@/modules/kabina-chat/ChatFeed';
import ChatHeaderBar from '@/modules/kabina-chat/ChatHeaderBar';
import ChatHud from '@/modules/kabina-chat/ChatHud';
import { ChevronDown, ChevronLeft, CloseIcon } from '@/modules/kabina-chat/ChatIcons';
import ChatSplitDivider, { useChatSplit } from '@/modules/kabina-chat/ChatSplitDivider';
import { ContextPanel, compactText } from '@/modules/kabina-chat/ContextPanel';
import DecisionCards from '@/modules/kabina-chat/DecisionCard';
import { KabinaComposer, ModelMenu, shortModelName } from '@/modules/kabina-chat/KabinaComposer';
import ChatNavigator from '@/modules/kabina-chat/ChatNavigator';
import { sessionTitle } from '@/modules/kabina-chat/SessionsColumn';
import { useChatEcho } from '@/modules/kabina-chat/hooks/useChatEcho';
import { readChatView, useChatViewMemory } from '@/modules/kabina-chat/hooks/useChatViewMemory';
import { useFeedFollowsKeyboard } from '@/modules/kabina-chat/hooks/useFeedFollowsKeyboard';
import { useFeedWindow } from '@/modules/kabina-chat/hooks/useFeedWindow';
import { useNewDialogDefaults } from '@/modules/kabina-chat/hooks/useNewDialogDefaults';
import { useNewDialogShortcut } from '@/modules/kabina-chat/hooks/useNewDialogShortcut';
import { useQueueItems } from '@/modules/kabina-chat/hooks/useQueueItems';
import { useSessionArtifacts } from '@/modules/kabina-chat/hooks/useSessionArtifacts';
import { useSessionContext } from '@/modules/kabina-chat/hooks/useSessionContext';
import { backgroundWork, describeTurnActivity, formatWorkTime } from '@/modules/kabina-chat/utils/agentWork';
import type { LiveAgentSample } from '@/modules/kabina-chat/utils/agentWork';
import { buildChatFeed } from '@/modules/kabina-chat/utils/chatFeed';
import { formatDuration, formatTokens, plural } from '@/modules/kabina-chat/utils/chatFormat';
import { api } from '@/shared/api';
import { useProcessingSessions } from '@/shared/context/SessionProtectionContext';
import { useMirageSettingsView } from '@/shared/hooks/useMirageSettingsView';
import type {
  AppTab,
  ArtifactSummary,
  PermissionMode,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
  SlashCommandPick,
} from '@/shared/types';

/** Names of the authors' project tabs (the tool area's label). */
const TOOL_TAB_LABELS: Partial<Record<AppTab, string>> = { files: 'Файлы', git: 'Git', shell: 'Терминал' };

const PHONE_PERMISSIONS: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: 'default', label: 'Default', hint: 'спрашивать перед правками' },
  { id: 'auto', label: 'Auto', hint: 'рискованное — спросит' },
  { id: 'plan', label: 'Plan', hint: 'только план' },
  { id: 'acceptEdits', label: 'Принимать правки', hint: 'правки без вопросов' },
];

type KabinaChatScreenProps = {
  isPhone: boolean;
  project: Project;
  session: ProjectSession | null;
  /** Fresh session list of the project (the sidebar state streams updates into it). */
  sessions: ProjectSession[];
  hasMoreSessions: boolean;
  attentionSessionIds: ReadonlySet<string>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  sendByCtrlEnter: boolean;
  onSelectSession: (session: ProjectSession) => void;
  /** A new empty dialog — in this project, or in the one named (the navigator's other projects). */
  onNewSession: (projectId?: string) => void;
  onNavigateToSession: (sessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onRenameSession: (sessionId: string, title: string) => Promise<boolean>;
  onSessionArchived: (sessionId: string) => void;
  onLoadMoreSessions: () => void;
  onRefreshProjects: () => void;
  onShowSettings: () => void;
  /** Opens a project file (from the context panel's file list) in the Files tab. */
  onOpenFile: (filePath: string) => void;
  /** The authors' Files / Git / Terminal content for the project tabs. */
  renderToolTab: (tab: AppTab) => ReactNode;
};

function useNow(active: boolean, intervalMs = 1000): number {
  // Ticks the turn clock while a turn runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** Lets the composer's submit run without a form event (the feed's «Повторить» / «Продолжить»). */
const fakeSubmit = () => ({ preventDefault: () => undefined }) as unknown as FormEvent<HTMLFormElement>;

/** The feed took at least this long to open: «Большая сессия» says «лента грузится N с». */
const SLOW_FEED_MS = 2_000;

/** A minimal summary for an artifact known only from its tool row (the list has not caught up yet). */
function fallbackArtifact(artifactId: string, title: string, url: string, version: string | null): ArtifactSummary {
  return {
    artifactId, url, title, version: version ?? '', seq: null, icon: null, kind: 'page', publishedAt: null,
    description: null, label: null, stored: true, versionsCount: 1, versions: [], screens: [],
  };
}

/**
 * Used by the project-workspace module for `/p/:projectId(/s/:sessionId)`:
 * the «Кабина» chat of a project (DarkChat at 1440, DarkPhoneChat at 390).
 * Chat behaviour comes from the authors' hooks via `useChatController`.
 */
export default function KabinaChatScreen(props: KabinaChatScreenProps) {
  const {
    isPhone, project, session, sessions, hasMoreSessions, attentionSessionIds, ws, sendMessage, activeTab, setActiveTab,
    externalMessageUpdate, newSessionTrigger, sendByCtrlEnter, onSelectSession, onNewSession, onNavigateToSession,
    onSessionEstablished, onRenameSession, onSessionArchived, onLoadMoreSessions, onRefreshProjects, onShowSettings,
    onOpenFile, renderToolTab,
  } = props;
  const navigate = useNavigate();
  const location = useLocation();
  const processingSessions = useProcessingSessions();

  const chat = useChatController({
    isActive: activeTab === 'chat',
    selectedProject: project,
    selectedSession: session,
    ws,
    sendMessage,
    onNavigateToSession,
    onSessionEstablished,
    onShowSettings,
    sendByCtrlEnter,
    externalMessageUpdate,
    newSessionTrigger,
  });
  const { session: sessionState, composer, provider } = chat;
  // A new dialog starts from the Claude defaults in settings; the address tells it
  // apart from a session that is still being looked up.
  useNewDialogDefaults({
    chat,
    isNewDialog: !session && !/\/s\//.test(location.pathname),
    dialogKey: `${project.projectId}:${newSessionTrigger}`,
  });
  const sessionId = chat.activeSessionId;
  const isProcessing = sessionState.isProcessing;
  const pendingRequests = provider.pendingPermissionRequests;
  // A message the voice overlay sent into this dialog shows at once, like a composer send.
  // Phone: the keyboard shrinks the feed; the last message stays in view (messenger-like).
  useFeedFollowsKeyboard(sessionState.scrollContainerRef, isPhone);
  useChatEcho({
    sessionId,
    addMessage: sessionState.addMessage,
    setIsUserScrolledUp: sessionState.setIsUserScrolledUp,
    scrollToBottom: sessionState.scrollToBottom,
  });

  // ChatLayoutB: the HUD of this screen replaces the shell's (dialog, turn, context, artifacts).
  useClaimKabinaHud();
  // The pane beside the feed (desktop): the context drawer, the artifact split — or nothing;
  // neither is open by default, the HUD's КТКСТ / АРТ open them and they push the feed aside.
  // Coming back from Files / Settings to the same dialog reopens what was open beside the feed.
  const [rememberedView] = useState(() => (isPhone ? null : readChatView(session?.id ?? null)));
  const [panel, setPanel] = useState<'ctx' | 'art' | null>(rememberedView?.panel ?? null);
  // Which artifact is open (desktop: beside the feed; phone: full screen under the HUD).
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(rememberedView?.artifactId ?? null);
  // The artifact takes the whole width (desktop).
  const [isArtifactFull, setIsArtifactFull] = useState(rememberedView?.isArtifactFull ?? false);
  // The navigator is open, and from where: up from the HUD, down from the project crumb (all
  // projects, this one unfolded) or from the dialog crumb (this project's dialogs).
  const [dialogsFrom, setDialogsFrom] = useState<'hud' | 'project' | 'dialog' | null>(null);
  // The feed's share beside an artifact (30–70 %, remembered) and whether its divider is dragged.
  const [splitShare, setSplitShare] = useChatSplit();
  const [isSplitDragging, setIsSplitDragging] = useState(false);
  // Phone: context sheet, sessions sheet, model picker inside the sheet.
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  // Phone: the navigator sheet and the tab it opened on.
  const [sessionsSheet, setSessionsSheet] = useState<'here' | 'all' | null>(null);
  const isSessionsSheetOpen = sessionsSheet !== null;
  const setIsSessionsSheetOpen = useCallback((open: boolean) => setSessionsSheet(open ? 'here' : null), []);
  const [isPhoneModelOpen, setIsPhoneModelOpen] = useState(false);
  // Phone sheet: the locked Bypass explanation (DarkStates E2) unfolded under «ПРАВА».
  const [isPhoneBypassOpen, setIsPhoneBypassOpen] = useState(false);
  // The server says whether it runs as root (Claude Code refuses Bypass then) and where its home is.
  const serverRuntime = useMirageSettingsView()?.server ?? null;
  const runsAsRoot = serverRuntime?.isRoot ?? false;
  // File paths in the feed open in the Files screen; `~/` is the home folder of the panel's user.
  const homeDir = serverRuntime?.homeDir ?? null;
  const fileLinks = useFeedFileLinks(project.projectId, homeDir);
  // Text to put into the composer once a new dialog opens («Новый диалог с выжимкой»).
  const [pendingPrefill, setPendingPrefill] = useState<string | null>(null);

  const openArtifactBeside = useCallback((artifactId: string) => {
    setOpenArtifactId(artifactId);
    setPanel('art');
  }, []);
  const closeDialogs = useCallback(() => setDialogsFrom(null), []);
  useChatViewMemory({
    sessionId: session?.id ?? null,
    scrollContainerRef: sessionState.scrollContainerRef,
    setIsUserScrolledUp: sessionState.setIsUserScrolledUp,
    hasMessages: sessionState.chatMessages.length > 0,
    panel,
    artifactId: openArtifactId,
    isArtifactFull,
  });

  const { artifacts } = useSessionArtifacts(sessionId, useCallback((published: ArtifactSummary) => {
    // A fresh artifact opens beside the chat on a wide screen, as claude.ai does.
    if (!isPhone) openArtifactBeside(published.artifactId);
  }, [isPhone, openArtifactBeside]));

  const { usage, error: contextError, isCompactPending, toggleCompact } = useSessionContext(sessionId, isProcessing);

  // DarkStates L4 «Большая сессия» above the composer: transcript size, polled per session.
  const bigSession = useBigSessionNotice(session ? sessionId : null);
  // «Остаться здесь» was just pressed here: the outcome line shows for a moment, then the plaque goes.
  const [isStayNoted, setIsStayNoted] = useState(false);
  // How long this dialog's feed took to open, when it was slow (L4 «лента грузится N с»).
  const [feedLoadSeconds, setFeedLoadSeconds] = useState<number | null>(null);
  const feedLoadStartRef = useRef<number | null>(null);
  useEffect(() => {
    setIsStayNoted(false);
    setFeedLoadSeconds(null);
    feedLoadStartRef.current = null;
  }, [sessionId]);
  useEffect(() => {
    if (sessionState.isLoadingSessionMessages) {
      feedLoadStartRef.current ??= Date.now();
      return;
    }
    const startedAt = feedLoadStartRef.current;
    if (startedAt === null) return;
    feedLoadStartRef.current = null;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= SLOW_FEED_MS) setFeedLoadSeconds(elapsed / 1000);
  }, [sessionState.isLoadingSessionMessages]);
  useEffect(() => {
    if (!isStayNoted) return undefined;
    const timer = window.setTimeout(() => setIsStayNoted(false), 6_000);
    return () => window.clearTimeout(timer);
  }, [isStayNoted]);

  // Reset per-session view state: another dialog's artifact is not open; the context drawer may stay.
  useEffect(() => {
    setOpenArtifactId(null);
    setPanel((current) => (current === 'art' ? null : current));
    setIsArtifactFull(false);
  }, [sessionId]);

  // «Новый диалог» (navigator, ⌘N, «/new»): once the empty dialog is on screen, the cursor
  // waits in the composer. A counter, so a second press on an already empty dialog focuses too.
  const [focusRequest, setFocusRequest] = useState(0);
  const handledFocusRef = useRef(0);
  const startNewDialog = useCallback((projectId?: string) => {
    onNewSession(projectId);
    setFocusRequest((count) => count + 1);
  }, [onNewSession]);

  useEffect(() => {
    if (focusRequest === handledFocusRef.current || session) return undefined;
    handledFocusRef.current = focusRequest;
    // After the navigator's popover / sheet has closed and handed focus back.
    const timer = window.setTimeout(() => composer.textareaRef.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(timer);
  }, [composer.textareaRef, focusRequest, session]);

  useEffect(() => {
    if (pendingPrefill && !session) {
      composer.setInput(pendingPrefill);
      setPendingPrefill(null);
      window.requestAnimationFrame(() => composer.textareaRef.current?.focus());
    }
  }, [composer, pendingPrefill, session]);

  // The clock ticks while the session works — a turn or only background jobs (their time runs too).
  const now = useNow(isProcessing);
  // Built from every loaded message and windowed by feed rows (useFeedWindow):
  // the authors' message window counts thinking and folded subagent rows, so
  // its newest hundred could draw nothing at all.
  const feed = useMemo(
    () => buildChatFeed(sessionState.chatMessages, now),
    // `now` only refreshes «идёт m:ss» of running agents; rebuild once a second while a turn runs.
    [sessionState.chatMessages, now],
  );
  const feedWindow = useFeedWindow({
    items: feed.items,
    sessionId: session?.id ?? null,
    hasMoreOnServer: sessionState.hasMoreMessages,
    isHistoryReady: sessionState.historyStatus !== 'loading',
    isLoadingMore: sessionState.isLoadingMoreMessages,
    loadOlderPage: sessionState.loadOlderPage,
  });
  const { requestLatestMessages } = sessionState;
  const retryHistory = useCallback(() => {
    if (session) void requestLatestMessages(session.id, true);
  }, [requestLatestMessages, session]);

  const queue = useQueueItems({
    sessionKey: sessionId,
    queuedDraft: composer.queuedDraft,
    deleteQueuedDraft: composer.deleteQueuedDraft,
  });

  const openArtifact = artifacts.find((item) => item.artifactId === openArtifactId)
    ?? (() => {
      if (!openArtifactId) return null;
      const fromFeed = feed.items.find((item) => item.kind === 'artifact' && item.artifact.artifactId === openArtifactId);
      return fromFeed && fromFeed.kind === 'artifact'
        ? fallbackArtifact(fromFeed.artifact.artifactId, fromFeed.artifact.title, fromFeed.artifact.url, fromFeed.artifact.version)
        : null;
    })();
  const isArtifactView = panel === 'art' && Boolean(openArtifact);

  const closeArtifact = useCallback(() => {
    setPanel((current) => (current === 'art' ? null : current));
    setIsArtifactFull(false);
  }, []);

  const toggleArtifact = useCallback((artifactId: string) => {
    if (isPhone) {
      setOpenArtifactId(artifactId);
      return;
    }
    if (panel === 'art' && openArtifactId === artifactId) {
      closeArtifact();
      return;
    }
    openArtifactBeside(artifactId);
  }, [closeArtifact, isPhone, openArtifactBeside, openArtifactId, panel]);

  // HUD «АРТ»: the open (or the newest) artifact beside the feed — or close it; phone — full screen.
  const toggleArtifactsPanel = useCallback(() => {
    const target = openArtifactId ?? artifacts[0]?.artifactId ?? null;
    if (isPhone) {
      setOpenArtifactId((current) => (current ? null : target));
      return;
    }
    if (panel === 'art') {
      closeArtifact();
      return;
    }
    if (target) openArtifactBeside(target);
  }, [artifacts, closeArtifact, isPhone, openArtifactBeside, openArtifactId, panel]);

  const openVoice = useCallback(() => {
    const params = new URLSearchParams(location.search);
    params.delete('search');
    params.set('voice', '');
    navigate({ pathname: location.pathname, search: `?${params.toString().replace(/=(&|$)/g, '$1')}` }, { state: { kabinaOverlay: 'voice' } });
  }, [location.pathname, location.search, navigate]);

  const insertIntoComposer = useCallback((text: string) => {
    composer.setInput((previous: string) => (previous.trim() ? `${previous.trimEnd()}\n${text}` : text));
    window.requestAnimationFrame(() => {
      const textarea = composer.textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [composer]);

  const handlePanelAction = useCallback((action: string, _pick: SlashCommandPick): boolean => {
    switch (action) {
      case 'new_session':
        startNewDialog();
        return true;
      case 'open_sessions':
        if (isPhone) setIsSessionsSheetOpen(true);
        else setDialogsFrom('hud');
        return true;
      case 'show_context':
      case 'show_cost':
      case 'show_usage':
      case 'show_status':
        if (isPhone) setIsSheetOpen(true);
        else setPanel('ctx');
        return true;
      case 'open_artifacts':
        if (artifacts[0]) toggleArtifact(artifacts[0].artifactId);
        return true;
      case 'mode_plan':
        provider.selectPermissionMode('plan');
        return true;
      case 'model_menu':
      case 'effort_menu':
        if (isPhone) {
          setIsSheetOpen(true);
          setIsPhoneModelOpen(true);
          return true;
        }
        return false;
      case 'open_agents':
      case 'open_tasks':
      case 'open_workflows':
        navigate('/agents');
        return true;
      case 'open_settings':
      case 'open_mcp':
      case 'open_hooks':
      case 'open_plugins':
      case 'open_skills':
      case 'open_memory':
      case 'open_account':
      case 'theme':
        navigate('/settings');
        return true;
      case 'show_diff':
        setActiveTab('git');
        return true;
      case 'voice_input':
        openVoice();
        return true;
      case 'copy_last_reply': {
        const last = [...feed.items].reverse().find((item) => item.kind === 'assistant');
        if (last && last.kind === 'assistant') void navigator.clipboard?.writeText(last.text).catch(() => undefined);
        return true;
      }
      case 'fork_session':
        if (!sessionId) return false;
        void (async () => {
          const response = await api.forkSession(sessionId, {});
          const body = await response.json().catch(() => null) as { data?: { sessionId?: string } } | null;
          if (response.ok && body?.data?.sessionId) onNavigateToSession(body.data.sessionId);
        })();
        return true;
      default:
        return false;
    }
  }, [artifacts, feed.items, isPhone, navigate, onNavigateToSession, openVoice, startNewDialog, provider, sessionId, setActiveTab, toggleArtifact]);

  const startWithSummary = useCallback((source: ProjectSession) => {
    setPendingPrefill(`Продолжаем работу из диалога «${sessionTitle(source)}» (сессия ${source.id}) — он стал слишком большим. `
      + 'Сначала прочитай его транскрипт и коротко восстанови: цель, что сделано, что осталось и важные решения. Потом продолжай.');
    startNewDialog();
  }, [startNewDialog]);

  // Sends a line as a new turn through the composer (same options, echo and
  // queue rules as a typed message) and puts back whatever was being typed.
  const sendLine = useCallback((text: string) => {
    const draft = composer.input;
    void composer.handleSubmit(fakeSubmit(), { content: text, attachments: [] }).then(() => {
      if (draft.trim()) composer.setInput(draft);
    });
  }, [composer]);

  const hasSonnet = provider.currentProviderModelOptions.some((option) => option.value === 'sonnet');
  const isOnSonnet = /sonnet/i.test(provider.currentProviderModel || '');
  const { selectModel } = chat;
  const feedActions = useMemo<FeedActions>(() => ({
    retry: () => sendLine('Продолжай — прошлый ответ оборвался ошибкой API.'),
    resume: (step: number) => sendLine(step > 0 ? `Продолжай с шага ${step} — я останавливал ход.` : 'Продолжай — я останавливал ход.'),
    switchToSonnet: hasSonnet && !isOnSonnet ? () => void selectModel('sonnet') : null,
  }), [hasSonnet, isOnSonnet, selectModel, sendLine]);

  // ⌘N / Ctrl+N — new dialog, only while the chat tab is on screen (not in Terminal / Files).
  useNewDialogShortcut(activeTab === 'chat', startNewDialog);

  // ----- derived view data

  const activity = sessionState.sessionActivity;
  const waits = pendingRequests.length > 0;
  const turnTone: 'run' | 'wait' | 'idle' = waits ? 'wait' : isProcessing ? 'run' : 'idle';
  const elapsed = activity ? formatDuration(now - activity.startedAt) : '00:00';
  const statusText = waits
    ? '· ждёт твоего решения ↑'
    : isProcessing
      ? `· ${(activity?.statusText === 'Running in the Claude CLI' ? 'в терминале Claude Code' : activity?.statusText || (activity?.background ? 'фоновая работа' : 'работает')).toLowerCase()}`
      : '· ход не идёт';
  // The live agent tree while the session works: the subagent cards' current call, calls, tokens
  // and time, the main thread's word and what Claude has written («↓ 1.2k»).
  const agentsLive = useAgentsLive(isProcessing && Boolean(sessionId));
  const liveSession = sessionId && isProcessing
    ? agentsLive.state.sessions.find((entry) => entry.sessionId === sessionId || entry.providerSessionId === sessionId) ?? null
    : null;
  const liveReceivedAt = liveSession ? agentsLive.state.receivedAt[liveSession.sessionId] ?? null : null;
  const liveAgents = useMemo(() => {
    const byToolUse = new Map<string, LiveAgentSample>();
    if (!liveSession) return byToolUse;
    for (const node of liveSession.agents) {
      if (node.toolUseId) byToolUse.set(node.toolUseId, { node, receivedAt: liveReceivedAt ?? Date.now() });
    }
    return byToolUse;
  }, [liveReceivedAt, liveSession]);
  const liveMain = liveSession?.orchestrator ?? null;

  // «✻ Bash npm test… (12 с · ↓ 1.2k ток.)» — the turn line, as Claude Code's spinner line.
  const isBackgroundOnly = Boolean(activity?.background);
  const turnActivity = !isProcessing ? null : isBackgroundOnly ? 'фоновая работа' : describeTurnActivity(feed.items, {
    waits,
    mainAction: liveMain?.state === 'tool' ? liveMain.currentAction : null,
    now,
    live: (toolId) => liveAgents.get(toolId) ?? null,
  });
  const turnActivityMeta = isProcessing && activity && !isBackgroundOnly
    ? [formatWorkTime(now - activity.startedAt), liveMain?.outputTokens ? `↓ ${formatTokens(liveMain.outputTokens)} ток.` : null]
      .filter(Boolean).join(' · ')
    : null;
  const turn = {
    running: isProcessing, elapsed, steps: feed.lastTurnSteps, statusText, tone: turnTone,
    activity: turnActivity, activityMeta: turnActivityMeta,
  };
  // The plan of the running turn and the session's background jobs: the turn line's chip.
  const work = {
    todos: isProcessing && !isBackgroundOnly ? feed.turnTodos : null,
    background: backgroundWork(activity?.tasks, now),
  };

  const agentTasks = (activity?.tasks ?? []).filter((task) => !task.nested && task.taskType !== 'local_bash');
  const agentsCount = agentTasks.length;
  const agentsNames = agentTasks.map((task) => task.workflowName || task.description).filter(Boolean).slice(0, 3)
    .map((name) => (name.length > 22 ? `${name.slice(0, 21)}…` : name)).join(' · ');

  const title = session ? sessionTitle(session) : 'Новый диалог';

  const modelOption = provider.currentProviderModelOptions.find((option) => option.value === provider.currentProviderModel);
  // The model that answered last (from the transcript or the SDK) — else the composer's choice.
  const modelName = usage?.model
    ? shortModelName(undefined, usage.model)
    : shortModelName(modelOption?.label, provider.currentProviderModel || '—', modelOption?.description);
  const effort = provider.currentProviderEffort && provider.currentProviderEffort !== 'default' ? provider.currentProviderEffort : 'авто';
  const modelMeta = [usage?.maxTokens ? formatTokens(usage.maxTokens) : null, effort].filter(Boolean).join(' · ');
  const percent = usage ? Math.round(usage.percentage) : null;

  const decision = <DecisionCards requests={pendingRequests} onDecision={composer.handlePermissionDecision} isPhone={isPhone} />;

  const feedBlock = (
    <FileLinkContext.Provider value={fileLinks}>
    <ChatFeed
      items={feedWindow.visibleItems}
      isPhone={isPhone}
      scrollRef={sessionState.scrollContainerRef}
      onScroll={sessionState.handleScroll as unknown as UIEventHandler<HTMLDivElement>}
      hasMore={feedWindow.hasEarlier}
      isLoadingMore={sessionState.isLoadingMoreMessages}
      onLoadEarlier={feedWindow.loadEarlier}
      isLoading={sessionState.isLoadingSessionMessages || sessionState.historyStatus === 'loading'}
      loadError={sessionState.historyStatus === 'error' && feed.items.length === 0}
      onRetry={retryHistory}
      openArtifactId={isArtifactView ? openArtifactId : null}
      onToggleArtifact={toggleArtifact}
      decision={decision}
      isProcessing={isProcessing}
      actions={feedActions}
      liveAgents={liveAgents}
      now={now}
      projectId={project.projectId}
      emptyHint={session ? 'В этом диалоге пока пусто.' : 'Новый диалог. Напиши задачу — Claude начнёт ход; пока он работает, можно вклиниваться или ставить сообщения в очередь.'}
    />
    </FileLinkContext.Provider>
  );

  const commandModal = (
    <CommandResultModal
      payload={composer.commandModalPayload}
      onClose={composer.closeCommandModal}
      providerModelCatalog={provider.providerModelCatalog}
      providerModelActions={provider.providerModelActions}
      activeProvider={provider.provider}
      activeProviderModel={provider.currentProviderModel}
      currentSessionId={sessionId}
      onSelectProviderModel={provider.selectProviderModel}
    />
  );

  const compactButton = usage && (
    <div className="kbc-compact">
      <span className="kb-m" style={{ fontSize: 10.5, color: usage.compactQueued ? 'var(--kb-signal-text)' : 'var(--kb-soft)' }}>
        {compactText(usage, false)}
      </span>
      <button type="button" className="kbc-btn-sm" data-fill="" style={{ minHeight: 32, fontSize: 12 }} disabled={isCompactPending} onClick={() => void toggleCompact()}>
        {usage.compactQueued ? 'Отменить' : 'Сжать сессию'}
      </button>
    </div>
  );

  const showBigSession = Boolean(session) && bigSession.sizeBytes !== null && (bigSession.visible || (bigSession.stayed && isStayNoted));
  const bigSessionNotice = showBigSession && session && bigSession.sizeBytes !== null && (
    <BigSessionNotice
      sizeBytes={bigSession.sizeBytes}
      thresholdBytes={bigSession.thresholdBytes}
      scaleMaxBytes={bigSession.scaleMaxBytes}
      sessionTitle={title}
      loadSeconds={feedLoadSeconds}
      filesCount={usage?.files.length || null}
      outcome={bigSession.stayed ? 'stay' : null}
      onNewWithSummary={() => startWithSummary(session)}
      onStay={() => {
        bigSession.stay();
        setIsStayNoted(true);
      }}
      onUndo={() => {
        bigSession.undoStay();
        setIsStayNoted(false);
      }}
    />
  );

  // The turn in the HUD: a waiting turn shows its decision card, otherwise the end of the feed.
  const revealTurn = () => {
    const card = waits ? document.querySelector('.kbc-decision') : null;
    if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else sessionState.scrollToBottom();
  };
  const dialogsCount = `${sessions.length}${hasMoreSessions ? '+' : ''}`;
  const contextTokens = usage ? `${formatTokens(usage.totalTokens)} из ${formatTokens(usage.maxTokens)}` : null;

  // The navigator (ChatNavigator): from the project crumb it opens on «Все проекты» with this
  // project unfolded; from the dialog crumb, the HUD and the phone title — on this project.
  const renderNavigator = (phone: boolean, from: 'project' | 'dialog', close: () => void) => (
    <ChatNavigator
      key={from}
      isPhone={phone}
      project={project}
      sessions={sessions}
      hasMore={hasMoreSessions}
      currentSessionId={session?.id ?? null}
      attentionSessionIds={attentionSessionIds}
      processingSessions={processingSessions}
      currentWaits={waits}
      initialTab={from === 'project' ? 'all' : 'here'}
      focusProjectId={from === 'project' ? project.projectId : null}
      onSelectCurrent={onSelectSession}
      onNew={startNewDialog}
      onNewWithSummary={startWithSummary}
      onRename={onRenameSession}
      onArchived={onSessionArchived}
      onLoadMore={onLoadMoreSessions}
      onRestored={onRefreshProjects}
      onClose={close}
    />
  );

  // ======================================================== PHONE

  if (isPhone) {
    const phonePerms = PHONE_PERMISSIONS.filter((mode) => (provider.availablePermissionModes as PermissionMode[]).includes(mode.id));
    const permHint = phonePerms.find((mode) => mode.id === provider.permissionMode)?.hint ?? '';
    return (
      <div className="kbc-phone">
        {/* ChatLayoutB-Phone: the header (back, project and dialog — opens the list, bell) and
            right under it the HUD row; both stay in view over the sheets and the artifact. */}
        <div className="kbc-ptop">
          <header className="kbc-phead">
            <Link className="kbc-pback" to="/" aria-label="Назад — на главный экран"><ChevronLeft size={20} /></Link>
            <button
              type="button"
              className="kbc-ptitle"
              aria-haspopup="dialog"
              aria-expanded={isSessionsSheetOpen}
              aria-label={`${project.displayName}: ${title} — другие диалоги`}
              onClick={() => setIsSessionsSheetOpen(true)}
            >
              <span className="kbc-proj-mark kb-t" aria-hidden="true">{project.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="kbc-ptitle-text">
                <span className="kbc-ptitle-cap kb-m">{project.displayName.toUpperCase()} · {dialogsCount} {plural(sessions.length, 'ДИАЛОГ', 'ДИАЛОГА', 'ДИАЛОГОВ')}</span>
                <h1>{title}</h1>
              </span>
              <ChevronDown size={12} className="kbc-chev" />
            </button>
            <NotificationBell isPhone />
          </header>
          <ChatHud
            isPhone
            projectName={project.displayName}
            title={title}
            dialogsCount={dialogsCount}
            dialogs={null}
            isDialogsOpen={isSessionsSheetOpen}
            onToggleDialogs={() => setIsSessionsSheetOpen(!isSessionsSheetOpen)}
            onCloseDialogs={() => setIsSessionsSheetOpen(false)}
            turn={turn}
            agentsCount={agentsCount}
            onTurnClick={revealTurn}
            contextPercent={percent}
            contextTokens={contextTokens}
            isContextOpen={isSheetOpen}
            onToggleContext={() => setIsSheetOpen((open) => !open)}
            artifactsCount={artifacts.length}
            isArtifactOpen={Boolean(openArtifactId && openArtifact)}
            onToggleArtifacts={toggleArtifactsPanel}
          />
        </div>

        {feedBlock}
        {bigSessionNotice && <div className="kbc-pbig">{bigSessionNotice}</div>}
        <KabinaComposer
          chat={chat}
          isPhone
          compact={false}
          projectId={project.projectId}
          onVoice={openVoice}
          onPanelAction={handlePanelAction}
          turn={turn}
          queue={queue}
          agentsCount={agentsCount}
          work={work}
        />

        <Sheet
          open={isSheetOpen}
          onClose={() => {
            setIsSheetOpen(false);
            setIsPhoneModelOpen(false);
          }}
          title="КОНТЕКСТ СЕССИИ"
          belowHud
          meta={usage ? `${formatTokens(usage.totalTokens)} / ${formatTokens(usage.maxTokens)}` : undefined}
          footer={usage && (
            <>
              <span className="kb-m" style={{ fontSize: 10.5, color: usage.compactQueued ? 'var(--kb-signal-text)' : 'var(--kb-soft)' }}>
                {compactText(usage, true)}
              </span>
              <button
                type="button"
                className={`kb-btn ${usage.compactQueued ? 'kb-ghost' : 'kb-out'}`}
                data-size="lg"
                disabled={isCompactPending}
                onClick={() => void toggleCompact()}
              >
                {usage.compactQueued ? 'Отменить сжатие' : 'Сжать сессию после хода'}
              </button>
            </>
          )}
        >
          <ContextPanel
            usage={usage}
            error={contextError}
            hasSession={Boolean(sessionId)}
            variant="sheet"
            modelLine={{ name: modelName, meta: modelMeta }}
            isRunning={isProcessing}
            onOpenFile={(path) => {
              setIsSheetOpen(false);
              onOpenFile(path);
            }}
            extra={(
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                    <h3 id="kbc-perm-h" className="kbc-h kb-m">ПРАВА</h3>
                    <span style={{ fontSize: 12, color: 'var(--kb-mute)', textAlign: 'right' }}>{permHint}</span>
                  </div>
                  <div className="kbc-perm-grid" role="group" aria-labelledby="kbc-perm-h">
                    {phonePerms.map((mode) => (
                      <button key={mode.id} type="button" aria-pressed={mode.id === provider.permissionMode} onClick={() => provider.selectPermissionMode(mode.id)}>
                        {mode.label}
                      </button>
                    ))}
                  </div>
                  {runsAsRoot && provider.provider === 'claude' && (
                    <button
                      type="button"
                      className="kbc-pbypass kb-m"
                      aria-expanded={isPhoneBypassOpen}
                      onClick={() => setIsPhoneBypassOpen((open) => !open)}
                    >
                      Bypass недоступен под root · {isPhoneBypassOpen ? 'скрыть' : 'почему'}
                    </button>
                  )}
                  {runsAsRoot && isPhoneBypassOpen && (
                    <div className="kbc-psheet-bypass">
                      <BypassRootCard mode={provider.permissionMode} />
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <h3 className="kbc-h kb-m">МОДЕЛЬ</h3>
                  <button type="button" className="kbc-pmodel" aria-label="Сменить модель и effort" aria-expanded={isPhoneModelOpen} onClick={() => setIsPhoneModelOpen((open) => !open)}>
                    <span style={{ fontSize: 15, fontWeight: 500 }}>{modelName}</span>
                    <span className="kb-m" style={{ flex: 1, fontSize: 11, color: 'var(--kb-mute)' }}>{modelMeta.replace(effort, `effort ${effort}`)}</span>
                    <ChevronDown size={14} />
                  </button>
                  {isPhoneModelOpen && <ModelMenu chat={chat} inline onClose={() => setIsPhoneModelOpen(false)} />}
                </div>
              </>
            )}
          />
        </Sheet>

        <Sheet open={isSessionsSheetOpen} onClose={() => setIsSessionsSheetOpen(false)} title="ДИАЛОГИ И ПРОЕКТЫ"
          meta={project.displayName}
          belowHud
          footer={(
            <Link className="kbc-dlg-foot kbc-dlg-foot-sheet kb-lnk" to="/projects" onClick={() => setIsSessionsSheetOpen(false)}>
              <span>Страница проектов</span>
              <span className="kb-m">все проекты →</span>
            </Link>
          )}
        >
          {sessionsSheet && renderNavigator(true, sessionsSheet === 'all' ? 'project' : 'dialog', () => setIsSessionsSheetOpen(false))}
        </Sheet>

        {openArtifactId && openArtifact && (
          <ArtifactPanel
            artifacts={artifacts}
            artifact={openArtifact}
            sessionId={sessionId}
            isPhone
            isFull
            onPick={setOpenArtifactId}
            onToggleFull={() => undefined}
            onClose={() => setOpenArtifactId(null)}
            onComment={(item) => {
              setOpenArtifactId(null);
              insertIntoComposer(`К артефакту «${item.title}» (${item.url}): `);
            }}
            onVoice={openVoice}
          />
        )}
        {commandModal}
      </div>
    );
  }

  // ======================================================== DESKTOP

  const isChatTab = activeTab === 'chat';
  const isContextView = isChatTab && panel === 'ctx';
  const isSplit = isChatTab && isArtifactView;

  return (
    <div
      className="kbc-screen"
      data-art={isSplit ? '' : undefined}
      data-full={isSplit && isArtifactFull ? '' : undefined}
      data-ctx={isContextView ? '' : undefined}
      data-dragging={isSplitDragging ? '' : undefined}
    >
      <ChatHeaderBar
        projectName={project.displayName}
        title={title}
        activeTab={activeTab}
        onTab={setActiveTab}
        dialogs={dialogsFrom === 'project' || dialogsFrom === 'dialog' ? renderNavigator(false, dialogsFrom, closeDialogs) : null}
        openFrom={dialogsFrom === 'project' || dialogsFrom === 'dialog' ? dialogsFrom : null}
        onOpenFrom={setDialogsFrom}
        onCloseDialogs={closeDialogs}
      />

      {!isChatTab && (
        <main className="kbc-main kbc-toolmain kb-rise" aria-label={TOOL_TAB_LABELS[activeTab] ?? 'Проект'}>
          <div className="kbc-tool-host">{renderToolTab(activeTab)}</div>
        </main>
      )}

      {isChatTab && (
        <div className="kbc-stage" style={{ '--kbc-split': `${splitShare}%` } as CSSProperties}>
          <main className="kbc-main kb-rise kb-d1" aria-label="Чат">
            {feedBlock}
            <div className="kbc-bottom">
              {bigSessionNotice}
              <KabinaComposer
                chat={chat}
                isPhone={false}
                compact={isArtifactView || isContextView}
                projectId={project.projectId}
                onVoice={openVoice}
                onPanelAction={handlePanelAction}
                turn={turn}
                queue={queue}
                agentsCount={agentsCount}
                work={work}
              />
            </div>
          </main>

          {isSplit && !isArtifactFull && (
            <ChatSplitDivider share={splitShare} onChange={setSplitShare} onDragChange={setIsSplitDragging} />
          )}

          {isSplit && openArtifact && (
            <div className="kbc-right kbc-right-art">
              <ArtifactPanel
                artifacts={artifacts}
                artifact={openArtifact}
                sessionId={sessionId}
                isPhone={false}
                isFull={isArtifactFull}
                onPick={openArtifactBeside}
                onToggleFull={() => setIsArtifactFull((full) => !full)}
                onClose={closeArtifact}
                onComment={(item) => insertIntoComposer(`К артефакту «${item.title}» (${item.url}): `)}
                onVoice={openVoice}
              />
            </div>
          )}

          {isContextView && (
            <div className="kbc-right kbc-right-ctx">
              <div role="group" aria-label="Панель диалога" className="kbc-ptabs">
                <button type="button" className="kbc-tab kbc-ptab" aria-pressed="true">
                  <span className="kbc-tab-bar" aria-hidden="true" />
                  <span>Контекст</span>
                  <span className="kbc-ptab-meta kb-m">{percent !== null ? `${percent}%` : '—'}</span>
                </button>
                <button
                  type="button"
                  className="kbc-tab kbc-ptab"
                  aria-pressed="false"
                  disabled={artifacts.length === 0}
                  title={artifacts.length === 0 ? 'В этом диалоге ещё нет артефактов' : 'Открыть рядом с лентой'}
                  onClick={toggleArtifactsPanel}
                >
                  <span className="kbc-tab-bar" aria-hidden="true" />
                  <span>Артефакты</span>
                  <span className="kbc-ptab-meta kb-m">{artifacts.length}</span>
                </button>
                <button type="button" className="kbc-ptab-x" aria-label="Закрыть панель контекста" title="Закрыть" onClick={() => setPanel(null)}>
                  <CloseIcon size={16} />
                </button>
              </div>
              <aside className="kbc-ctx kbc-slidein kb-bz" aria-label="Контекст сессии">
                <ContextPanel
                  usage={usage}
                  error={contextError}
                  hasSession={Boolean(sessionId)}
                  variant="aside"
                  modelLine={{ name: modelName, meta: modelMeta }}
                  isRunning={isProcessing}
                  onOpenFile={onOpenFile}
                  compact={compactButton}
                />
              </aside>
            </div>
          )}
        </div>
      )}

      <ChatHud
        isPhone={false}
        projectName={project.displayName}
        title={title}
        dialogsCount={dialogsCount}
        dialogs={dialogsFrom === 'hud' ? renderNavigator(false, 'dialog', closeDialogs) : null}
        isDialogsOpen={dialogsFrom === 'hud'}
        onToggleDialogs={() => setDialogsFrom((from) => (from === 'hud' ? null : 'hud'))}
        onCloseDialogs={closeDialogs}
        turn={turn}
        agentsCount={agentsCount}
        agentsNames={agentsNames}
        onTurnClick={revealTurn}
        contextPercent={percent}
        contextTokens={contextTokens}
        isContextOpen={isContextView}
        onToggleContext={() => {
          setActiveTab('chat');
          setPanel((current) => (current === 'ctx' ? null : 'ctx'));
        }}
        artifactsCount={artifacts.length}
        isArtifactOpen={isSplit}
        onToggleArtifacts={() => {
          setActiveTab('chat');
          toggleArtifactsPanel();
        }}
      />
      {commandModal}
    </div>
  );
}
