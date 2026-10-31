import { useCallback, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';

import { EditorSidebar, useEditorSidebar } from '@/modules/code-editor';
import { FileTree } from '@/modules/file-tree';
import { GitPanel } from '@/modules/git-panel';
import { Panel, Skeleton, useDelayedFlag } from '@/modules/kabina';
import { KabinaChatScreen } from '@/modules/kabina-chat';
import { StandaloneShell } from '@/modules/standalone-shell';
import { useProjectHomeState, useProjectMainState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';
import { useKabinaNewDialog } from '@/modules/project-workspace/hooks/useKabinaNewDialog';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type { AppTab, Project, ProjectSession, SessionEstablishedContext, SessionNavigationOptions } from '@/shared/types';

type KabinaChatRegionProps = {
  isMobile: boolean;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  navigate: NavigateFunction;
  /** Project named by the address, to tell "still opening" from "no such project". */
  routeProjectId: string | null;
  routeSessionId: string | null;
};

/** Tabs a Kabina link may ask the chat to open on (`state: { kabinaTab }`). */
const LINKABLE_TABS: AppTab[] = ['chat', 'files', 'shell', 'git'];
/** Tabs the Kabina chat screen has (DarkChat); anything else falls back to the chat. */
const KABINA_TABS: AppTab[] = ['chat', 'files', 'shell', 'git'];

function ChatSkeleton() {
  const visible = useDelayedFlag(true);
  return (
    <Panel tone="well" role="status" aria-label="Открываю диалог" style={{ flex: 1, minHeight: 0, gap: 22, padding: '24px 20px' }}>
      {visible && (
        <>
          <Skeleton width={72} height={8} />
          <Skeleton width="62%" height={11} />
          <Skeleton width="48%" height={11} />
          <Skeleton width={280} height={36} radius={5} style={{ maxWidth: '100%' }} />
          <span className="kb-m" style={{ fontSize: 11, color: 'var(--kb-mute)' }}>открываю проект…</span>
        </>
      )}
    </Panel>
  );
}

/**
 * Rendered by KabinaWorkspaceRoute for `/p/:projectId(/s/:sessionId)`: binds
 * the workspace state (project, sessions, tabs, navigation) to the kabina-chat
 * screen, and supplies the authors' Files / Git / Terminal for its tabs.
 */
export default function KabinaChatRegion({ isMobile, ws, sendMessage, navigate, routeProjectId, routeSessionId }: KabinaChatRegionProps) {
  const location = useLocation();
  const { selectedProject, isLoadingProjects, setActiveTab } = useProjectMainState();
  const { projects } = useProjectHomeState();

  const requestedTab = (location.state as { kabinaTab?: AppTab } | null)?.kabinaTab;
  useEffect(() => {
    if (requestedTab && LINKABLE_TABS.includes(requestedTab)) setActiveTab(requestedTab);
  }, [location.key, requestedTab, setActiveTab]);

  const isUnknownProject = Boolean(
    !isLoadingProjects
      && routeProjectId
      && !routeSessionId
      && !projects.some((project) => project.projectId === routeProjectId),
  );

  if (isUnknownProject) {
    return (
      <Panel role="alert" style={{ padding: 24, gap: 12, maxWidth: 560 }}>
        <span className="kb-m" style={{ fontSize: 10, letterSpacing: '0.22em', color: 'var(--kb-mute)' }}>ПРОЕКТ НЕ НАЙДЕН</span>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: 'var(--kb-soft)' }}>
          Такого проекта нет в панели — возможно, он убран в архив или адрес устарел.
        </p>
        <div>
          <Link className="kb-btn kb-ghost" to="/projects">Все проекты</Link>
        </div>
      </Panel>
    );
  }

  if (isLoadingProjects || !selectedProject) {
    return <ChatSkeleton />;
  }

  return (
    <WorkspaceErrorBoundary showDetails>
      <KabinaChatBinding isMobile={isMobile} ws={ws} sendMessage={sendMessage} navigate={navigate} project={selectedProject} />
    </WorkspaceErrorBoundary>
  );
}

type KabinaChatBindingProps = {
  isMobile: boolean;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  navigate: NavigateFunction;
  project: Project;
};

function KabinaChatBinding({ isMobile, ws, sendMessage, navigate, project }: KabinaChatBindingProps) {
  const {
    selectedSession,
    activeTab,
    setActiveTab,
    openSettings,
    externalMessageUpdate,
    newSessionTrigger,
    registerOptimisticSession,
    refreshProjectsSilently,
    renameSession,
  } = useProjectMainState();
  const { sidebarSharedProps } = useProjectSidebarState();
  const { sendByCtrlEnter } = useUiPreferences();

  // The project list streams updates (titles, new sessions); take the fresh copy of this project.
  const freshProject = sidebarSharedProps.projects.find((candidate: Project) => candidate.projectId === project.projectId) ?? project;
  const sessions = (freshProject.sessions ?? []) as ProjectSession[];
  const hasMoreSessions = Boolean(freshProject.sessionMeta?.hasMore);

  const tab: AppTab = KABINA_TABS.includes(activeTab) ? activeTab : 'chat';

  const editor = useEditorSidebar({ selectedProject: project, isMobile });

  const onNavigateToSession = useCallback((sessionId: string, options?: SessionNavigationOptions) => {
    navigate(`/session/${sessionId}`, { replace: Boolean(options?.replace) });
  }, [navigate]);

  const onSessionEstablished = useCallback((sessionId: string, context: SessionEstablishedContext) => {
    registerOptimisticSession({ sessionId, ...context });
  }, [registerOptimisticSession]);

  const onSelectSession = useCallback((session: ProjectSession) => {
    sidebarSharedProps.onSessionSelect(session);
    navigate(`/session/${session.id}`);
  }, [navigate, sidebarSharedProps]);

  const onNewSession = useKabinaNewDialog(navigate);

  const onLoadMoreSessions = useCallback(() => {
    void sidebarSharedProps.onLoadMoreSessions?.(project.projectId);
  }, [project.projectId, sidebarSharedProps]);

  const onOpenFile = useCallback((filePath: string) => {
    if (editor.handleFileOpen(filePath)) setActiveTab('files');
  }, [editor, setActiveTab]);

  const renderToolTab = useCallback((target: AppTab) => {
    if (target === 'shell') {
      return (
        <div style={{ height: '100%', width: '100%', overflow: 'hidden' }}>
          <StandaloneShell project={project} session={selectedSession} showHeader={false} isActive />
        </div>
      );
    }
    const content = target === 'git' ? (
      <GitPanel
        selectedProject={project}
        isMobile={isMobile}
        onFileOpen={editor.handleFileOpen}
        onProjectSelect={sidebarSharedProps.onProjectSelect}
        onProjectsRefresh={() => void refreshProjectsSilently()}
      />
    ) : (
      <FileTree selectedProject={project} onFileOpen={editor.handleFileOpen} revealDirectory={null} />
    );
    return (
      <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 200, minHeight: 0, overflow: 'hidden' }} className={editor.editorExpanded ? 'hidden' : undefined}>
          {content}
        </div>
        <EditorSidebar
          editingFile={editor.editingFile}
          isMobile={isMobile}
          editorExpanded={editor.editorExpanded}
          editorWidth={editor.editorWidth}
          hasManualWidth={editor.hasManualWidth}
          resizeHandleRef={editor.resizeHandleRef}
          onResizeStart={editor.handleResizeStart}
          onCloseEditor={editor.handleCloseEditor}
          onToggleEditorExpand={editor.handleToggleEditorExpand}
          onUnsavedChangesChange={editor.handleUnsavedChangesChange}
          projectPath={project.path}
          fillSpace={target === 'files'}
        />
      </div>
    );
  }, [editor, isMobile, project, refreshProjectsSilently, selectedSession, sidebarSharedProps.onProjectSelect]);

  return (
    <KabinaChatScreen
      isPhone={isMobile}
      project={freshProject}
      session={selectedSession}
      sessions={sessions}
      hasMoreSessions={hasMoreSessions}
      attentionSessionIds={sidebarSharedProps.attentionSessionIds}
      ws={ws}
      sendMessage={sendMessage}
      activeTab={tab}
      setActiveTab={setActiveTab}
      externalMessageUpdate={externalMessageUpdate}
      newSessionTrigger={newSessionTrigger}
      sendByCtrlEnter={sendByCtrlEnter}
      onSelectSession={onSelectSession}
      onNewSession={onNewSession}
      onNavigateToSession={onNavigateToSession}
      onSessionEstablished={onSessionEstablished}
      onRenameSession={renameSession}
      onSessionArchived={sidebarSharedProps.onSessionDelete}
      onLoadMoreSessions={onLoadMoreSessions}
      onRefreshProjects={() => void refreshProjectsSilently()}
      onShowSettings={() => openSettings()}
      onOpenFile={onOpenFile}
      renderToolTab={renderToolTab}
    />
  );
}
