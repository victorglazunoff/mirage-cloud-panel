import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';

import { kabinaChatPath } from '@/modules/kabina';
import { useProjectHomeState, useProjectMainState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { Project } from '@/shared/types';

/**
 * «Новый диалог» of the «Кабина» chat (navigator, ⌘N, «/new», a big session's «с выжимкой»):
 * an empty dialog in the open project or in the one named.
 *
 * The address goes first. In «Кабина» `/p/:project/s/:session` names the open dialog and the
 * workspace re-selects a session the URL still names; the authors' handler only clears the
 * selection and navigates to «/», which the Kabina navigate drops — so the old dialog came
 * straight back and the button looked dead. Navigating and clearing in one handler lands both
 * in the same render: the URL has no session, the selection is empty, the chat resets.
 */
export function useKabinaNewDialog(navigate: NavigateFunction): (projectId?: string) => void {
  const location = useLocation();
  const { selectedProject } = useProjectMainState();
  const { projects } = useProjectHomeState();
  const { sidebarSharedProps } = useProjectSidebarState();
  const startNewSession = sidebarSharedProps.onNewSession as (project: Project) => void;

  return useCallback((projectId?: string) => {
    const wantedId = projectId ?? selectedProject?.projectId;
    if (!wantedId) return;
    const target = projects.find((candidate) => candidate.projectId === wantedId)
      ?? (selectedProject?.projectId === wantedId ? selectedProject : null);
    const path = kabinaChatPath(wantedId);
    if (location.pathname !== path) navigate(path);
    // A project the list does not have yet: its address alone opens it (KabinaUrlSync selects it).
    if (target) startNewSession(target);
  }, [location.pathname, navigate, projects, selectedProject, startNewSession]);
}
