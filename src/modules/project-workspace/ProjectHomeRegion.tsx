import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { HomeScreen } from '@/modules/home';
import { kabinaChatPath, kabinaLimitsHref } from '@/modules/kabina';
import { useProjectHomeState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { Project } from '@/shared/types';

/** `/calendar?event=…&date=…`: the calendar opens on the event's day with it selected. */
function calendarEventPath(eventId: string, startsAt: string): string {
  const at = new Date(startsAt);
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  return `/calendar?${new URLSearchParams({ event: eventId, date }).toString()}`;
}

type ProjectHomeRegionProps = {
  isMobile: boolean;
  onNavigateToSession: (sessionId: string) => void;
  /**
   * `kabina` — the home screen inside KabinaShell, navigating by Kabina
   * addresses; `classic` — the start screen of the classic interface (no
   * project selected), driving the workspace selection directly.
   */
  mode?: 'kabina' | 'classic';
};

/** Rendered by WorkspaceMain (classic) and KabinaWorkspaceRoute (`/`): binds workspace state to the Mirage home screen. */
export default function ProjectHomeRegion({ isMobile, onNavigateToSession, mode = 'classic' }: ProjectHomeRegionProps) {
  const navigate = useNavigate();
  const { projects, handleProjectSelect, setActiveTab, setSidebarOpen } = useProjectHomeState();
  const isKabina = mode === 'kabina';

  const handleOpenProject = useCallback((project: Project) => {
    setActiveTab('chat');
    if (isKabina) {
      navigate(kabinaChatPath(project.projectId));
      return;
    }
    handleProjectSelect(project);
  }, [handleProjectSelect, isKabina, navigate, setActiveTab]);

  const handleOpenSession = useCallback((sessionId: string, projectId: string | null) => {
    setActiveTab('chat');
    if (isKabina && projectId) {
      navigate(kabinaChatPath(projectId, sessionId));
      return;
    }
    onNavigateToSession(sessionId);
  }, [isKabina, navigate, onNavigateToSession, setActiveTab]);

  const handleOpenProjectList = useCallback(() => {
    if (isKabina) navigate('/projects');
    else setSidebarOpen(true);
  }, [isKabina, navigate, setSidebarOpen]);

  return (
    <HomeScreen
      projects={projects}
      isMobile={isMobile}
      embedded={!isKabina}
      onOpenSession={handleOpenSession}
      onOpenProject={handleOpenProject}
      onOpenProjectList={handleOpenProjectList}
      onOpenSearch={isKabina ? () => navigate({ search: '?search' }, { state: { kabinaOverlay: 'search' } }) : undefined}
      onOpenCalendar={isKabina ? () => navigate('/calendar') : undefined}
      onOpenAgents={isKabina ? () => navigate('/agents') : undefined}
      onOpenLimits={isKabina ? () => navigate(kabinaLimitsHref()) : undefined}
      onOpenCalendarEvent={isKabina ? (eventId, startsAt) => navigate(calendarEventPath(eventId, startsAt)) : undefined}
    />
  );
}
