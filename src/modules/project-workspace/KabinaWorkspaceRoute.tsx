import { memo, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';

import { PaletteOpsProvider } from '@/modules/command-palette';
import { KabinaApp, matchKabinaRoute } from '@/modules/kabina';
import { AgentsScreen } from '@/modules/kabina-agents';
import { KabinaCalendarScreen } from '@/modules/kabina-calendar';
import { FilesScreen } from '@/modules/kabina-files';
import { ProjectsScreen } from '@/modules/kabina-projects';
import { KabinaSearch } from '@/modules/kabina-search';
import { KabinaVoiceOverlay } from '@/modules/kabina-voice';
import { Settings } from '@/modules/settings';
import { KabinaSettingsScreen, describeSettingsSection } from '@/modules/kabina-settings';
import KabinaChatRegion from '@/modules/project-workspace/KabinaChatRegion';
import ProjectHomeRegion from '@/modules/project-workspace/ProjectHomeRegion';
import KabinaUrlSync from '@/modules/project-workspace/controllers/KabinaUrlSync';
import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import { useKabinaWorkspaceNavigate } from '@/modules/project-workspace/hooks/useKabinaWorkspaceNavigate';
import { ProjectsStateProvider, useProjectHomeState, useProjectMainState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { SessionProtectionProvider, useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import type { AgentSettingsProject, KabinaProjectRef, KabinaRoute } from '@/shared/types';

const MemoizedKabinaWorkspaceContent = memo(KabinaWorkspaceContent);

/** Breadcrumb word of each project tab of the Kabina chat screen. */
const CHAT_TAB_LABELS: Partial<Record<string, string>> = { chat: 'Чат', files: 'Файлы', git: 'Git', shell: 'Терминал' };

/** Rendered by App for every «Кабина» address (`/*` outside `/classic`): one workspace state for all Kabina screens. */
export default function KabinaWorkspaceRoute() {
  return (
    <SessionProtectionProvider>
      <PaletteOpsProvider>
        <MemoizedKabinaWorkspaceContent />
      </PaletteOpsProvider>
    </SessionProtectionProvider>
  );
}

function KabinaWorkspaceContent() {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const workspaceNavigate = useKabinaWorkspaceNavigate(routerNavigate);
  const route = matchKabinaRoute(location.pathname, location.search);
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe } = useWebSocket();
  const { isSessionProcessing } = useSessionProtectionActions();

  // The keyboard / visible-area frame is kept by the Kabina shell (useVisualViewportFrame).

  const sessionId = route.screen === 'chat' ? route.sessionId ?? undefined : undefined;

  return (
    <ProjectsStateProvider
      sessionId={sessionId}
      navigate={workspaceNavigate}
      subscribe={subscribe}
      isMobile={isMobile}
      isSessionProcessing={isSessionProcessing}
    >
      <ProjectEffects navigate={workspaceNavigate} />
      <KabinaUrlSync route={route} navigate={routerNavigate} />
      <KabinaScreens
        route={route}
        isMobile={isMobile}
        ws={ws}
        sendMessage={sendMessage}
        workspaceNavigate={workspaceNavigate}
        routerNavigate={routerNavigate}
      />
    </ProjectsStateProvider>
  );
}

type KabinaScreensProps = {
  route: KabinaRoute;
  isMobile: boolean;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  workspaceNavigate: NavigateFunction;
  routerNavigate: NavigateFunction;
};

/** Binds workspace state to the Kabina app: project list for search, chat title for the trail, the screen slots. */
function KabinaScreens({ route, isMobile, ws, sendMessage, workspaceNavigate }: KabinaScreensProps) {
  const { projects } = useProjectHomeState();
  const { selectedProject, selectedSession, activeTab, refreshProjectsSilently, isLoadingProjects } = useProjectMainState();

  const projectRefs = useMemo<KabinaProjectRef[]>(
    () => projects.map((project) => ({
      projectId: project.projectId,
      displayName: project.displayName || project.projectId,
      path: project.fullPath || project.path || '',
      isStarred: Boolean(project.isStarred),
    })),
    [projects],
  );

  const settingsProjects = useMemo<AgentSettingsProject[]>(
    () => projects.map((project) => ({
      name: project.projectId,
      displayName: project.displayName,
      fullPath: project.fullPath || project.path,
      path: project.path || project.fullPath,
    })),
    [projects],
  );

  const isChat = route.screen === 'chat';
  const chatTitle = {
    projectName: isChat ? selectedProject?.displayName ?? null : null,
    // DarkChat's trail names the open project tab: «MIRAGE // Сайт клиента // Чат».
    sessionTitle: isChat ? CHAT_TAB_LABELS[activeTab] ?? 'Чат' : null,
    // «Вернуться в Сайт клиента · Фид Авито» from Files / Settings.
    dialogTitle: isChat
      ? (selectedSession ? String(selectedSession.summary || selectedSession.title || selectedSession.name || 'Новый диалог') : 'новый диалог')
      : null,
  };

  return (
    <KabinaApp
      isPhone={isMobile}
      projects={projectRefs}
      chatTitle={chatTitle}
      describeSettingsSection={describeSettingsSection}
      renderHome={() => <ProjectHomeRegion isMobile={isMobile} mode="kabina" onNavigateToSession={(id) => workspaceNavigate(`/session/${id}`)} />}
      renderChat={() => (
        <KabinaChatRegion
          isMobile={isMobile}
          ws={ws}
          sendMessage={sendMessage}
          navigate={workspaceNavigate}
          routeProjectId={isChat ? route.projectId : null}
          routeSessionId={isChat ? route.sessionId : null}
        />
      )}
      renderAgents={() => <AgentsScreen />}
      renderProjects={() => <ProjectsScreen onProjectsChanged={() => void refreshProjectsSilently()} />}
      renderFiles={(projectId) => <FilesScreen projects={projectRefs} routeProjectId={projectId} isLoadingProjects={isLoadingProjects} />}
      renderCalendar={() => <KabinaCalendarScreen isPhone={isMobile} projects={projectRefs} />}
      renderSettings={(section) => (
        <KabinaSettingsScreen
          section={section}
          renderClassic={(tab, onClose) => (
            <Settings isOpen onClose={onClose} projects={settingsProjects} initialTab={tab} />
          )}
        />
      )}
      renderSearch={(onClose) => <KabinaSearch onClose={onClose} projects={projectRefs} />}
      renderVoice={(slot) => <KabinaVoiceOverlay {...slot} />}
    />
  );
}
