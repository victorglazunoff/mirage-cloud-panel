import { memo, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom';

import { PaletteOpsProvider } from '@/modules/command-palette';
import { ProjectsStateProvider } from '@/modules/project-workspace/context/ProjectsStateContext';
import {
  SessionProtectionProvider,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { useVisualViewportKeyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';
import ProjectWorkspaceShell from '@/modules/project-workspace/ProjectWorkspaceShell';

const MemoizedProjectWorkspaceRouteContent = memo(ProjectWorkspaceRouteContent);

type ProjectWorkspaceRouteProps = {
  /**
   * Mirage: the classic interface lives under `/classic` while «Кабина» owns the
   * root, so every absolute path this workspace navigates to gets this prefix.
   */
  basePath?: string;
};

/** Rendered by App for the classic interface ("/classic" and "/classic/session/:sessionId"). */
export default function ProjectWorkspaceRoute({ basePath = '' }: ProjectWorkspaceRouteProps) {
  return (
    <SessionProtectionProvider>
      <PaletteOpsProvider>
        <MemoizedProjectWorkspaceRouteContent basePath={basePath} />
      </PaletteOpsProvider>
    </SessionProtectionProvider>
  );
}

function ProjectWorkspaceRouteContent({ basePath }: { basePath: string }) {
  const routerNavigate = useNavigate();
  const navigate = useMemo<NavigateFunction>(() => {
    if (!basePath) return routerNavigate;
    const prefixed = ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === 'number') return routerNavigate(to);
      if (typeof to === 'string' && to.startsWith('/')) {
        return routerNavigate(to === '/' ? basePath : `${basePath}${to}`, options);
      }
      return routerNavigate(to, options);
    }) as NavigateFunction;
    return prefixed;
  }, [basePath, routerNavigate]);
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe } = useWebSocket();
  const { isSessionProcessing } = useSessionProtectionActions();

  useVisualViewportKeyboardOffset();

  return (
    <ProjectsStateProvider
      sessionId={sessionId}
      navigate={navigate}
      subscribe={subscribe}
      isMobile={isMobile}
      isSessionProcessing={isSessionProcessing}
    >
      <ProjectWorkspaceShell
        isMobile={isMobile}
        ws={ws}
        sendMessage={sendMessage}
        navigate={navigate}
      />
    </ProjectsStateProvider>
  );
}
