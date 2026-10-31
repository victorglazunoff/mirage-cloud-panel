import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';

import { kabinaChatPath } from '@/modules/kabina';
import {
  useProjectHomeState,
  useProjectMainState,
} from '@/modules/project-workspace/context/ProjectsStateContext';
import type { KabinaRoute } from '@/shared/types';

type KabinaUrlSyncProps = {
  route: KabinaRoute;
  /** The router's own navigate (the workspace gets a filtered one). */
  navigate: NavigateFunction;
};

/**
 * Headless controller rendered by KabinaWorkspaceRoute. Keeps «Кабина» chat
 * addresses and the workspace selection in step:
 * - URL → state: opening `/p/:projectId` selects that project (once per address);
 *   `/p/:projectId/s/:sessionId` and `/session/:id` are resolved by the
 *   workspace's own session lookup;
 * - state → URL: when the workspace changes the selection itself (new session,
 *   session deleted, "home" in the header) the address follows — `/p/…/s/…`,
 *   `/p/…` or `/`. The legacy `/session/:id` is rewritten in place.
 */
export default function KabinaUrlSync({ route, navigate }: KabinaUrlSyncProps) {
  const location = useLocation();
  const { selectedProject, selectedSession, isLoadingProjects, handleProjectSelect } = useProjectMainState();
  const { projects } = useProjectHomeState();

  const isChat = route.screen === 'chat';
  const routeProjectId = isChat ? route.projectId : null;
  const routeSessionId = isChat ? route.sessionId : null;
  const routeKey = isChat ? `${routeProjectId ?? ''}|${routeSessionId ?? ''}` : null;
  const appliedRouteRef = useRef<string | null>(null);

  // URL → state for a project address without a session.
  useEffect(() => {
    if (!isChat || routeSessionId || !routeProjectId || isLoadingProjects) return;
    if (appliedRouteRef.current === routeKey) return;
    if (selectedProject?.projectId === routeProjectId && !selectedSession) {
      appliedRouteRef.current = routeKey;
      return;
    }
    const project = projects.find((candidate) => candidate.projectId === routeProjectId);
    if (!project) return;
    appliedRouteRef.current = routeKey;
    handleProjectSelect(project);
  }, [handleProjectSelect, isChat, isLoadingProjects, projects, routeKey, routeProjectId, routeSessionId, selectedProject?.projectId, selectedSession]);

  useEffect(() => {
    if (!isChat) appliedRouteRef.current = null;
  }, [isChat]);

  // State → URL, only for changes the workspace makes while a chat is on screen.
  // The last seen selection is recorded on every screen, so a selection left
  // over from before is not mistaken for news when a chat opens.
  const stateKey = `${selectedProject?.projectId ?? ''}|${selectedSession?.id ?? ''}`;
  const lastStateRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastStateRef.current;
    lastStateRef.current = stateKey;
    if (!isChat || previous === null || previous === stateKey) return;

    let target: string;
    if (!selectedProject) {
      target = '/';
    } else {
      target = kabinaChatPath(selectedProject.projectId, selectedSession?.id ?? null);
    }
    if (target === location.pathname) return;
    // A session the URL already names, now resolved to its project: rewrite in place.
    const rewrite = Boolean(routeSessionId && selectedSession?.id === routeSessionId);
    navigate(target, { replace: rewrite || location.pathname.startsWith('/session/') });
  }, [isChat, location.pathname, navigate, routeSessionId, selectedProject, selectedSession?.id, stateKey]);

  return null;
}
