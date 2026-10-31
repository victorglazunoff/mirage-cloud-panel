import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * «Новый диалог» of the «Кабина» chat, end to end through the workspace state and the URL
 * sync: from an open dialog (`/p/:project/s/:session`) the new dialog must leave the old
 * session for good — the URL names no session and nothing re-selects it. Before the fix the
 * selection was cleared, the URL kept the session, and the workspace put it straight back.
 */

vi.setConfig({ testTimeout: 30_000 });

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const buildProject = (projectId: string, sessionIds: string[]): Project => ({
  projectId,
  path: `/repo/${projectId}`,
  fullPath: `/repo/${projectId}`,
  displayName: projectId,
  isStarred: false,
  sessions: sessionIds.map((id) => ({ id, summary: `dialog ${id}`, __provider: 'claude' })),
  sessionMeta: { hasMore: false, total: sessionIds.length },
});

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => [buildProject('alpha', ['s-1', 's-2']), buildProject('beta', ['b-1'])],
  });
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

async function renderWorkspace(initialPath: string) {
  const [{ matchKabinaRoute }, context, { default: KabinaUrlSync }, { useKabinaWorkspaceNavigate }, { useKabinaNewDialog }] = await Promise.all([
    import('@/modules/kabina'),
    import('@/modules/project-workspace/context/ProjectsStateContext'),
    import('@/modules/project-workspace/controllers/KabinaUrlSync'),
    import('@/modules/project-workspace/hooks/useKabinaWorkspaceNavigate'),
    import('@/modules/project-workspace/hooks/useKabinaNewDialog'),
  ]);
  const { ProjectsStateProvider, useProjectMainState } = context;

  function Probe({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
    const location = useLocation();
    const { selectedProject, selectedSession, newSessionTrigger } = useProjectMainState();
    const startNewDialog = useKabinaNewDialog(navigate);
    return (
      <div>
        <span data-testid="path">{location.pathname}</span>
        <span data-testid="selection">{`${selectedProject?.projectId ?? '-'}|${selectedSession?.id ?? '-'}`}</span>
        <span data-testid="trigger">{newSessionTrigger}</span>
        <button type="button" onClick={() => startNewDialog()}>new here</button>
        <button type="button" onClick={() => startNewDialog('beta')}>new in beta</button>
      </div>
    );
  }

  function Workspace() {
    const location = useLocation();
    const routerNavigate = useNavigate();
    const workspaceNavigate = useKabinaWorkspaceNavigate(routerNavigate);
    const route = matchKabinaRoute(location.pathname, location.search);
    return (
      <ProjectsStateProvider
        sessionId={route.screen === 'chat' ? route.sessionId ?? undefined : undefined}
        navigate={workspaceNavigate}
        subscribe={() => () => undefined}
        isMobile={false}
        isSessionProcessing={() => false}
      >
        <KabinaUrlSync route={route} navigate={routerNavigate} />
        <Probe navigate={workspaceNavigate} />
      </ProjectsStateProvider>
    );
  }

  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Workspace />
    </MemoryRouter>,
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

test('from an open dialog, «Новый диалог» leaves it: no session in the URL or the selection', async () => {
  await renderWorkspace('/p/alpha/s/s-2');
  await waitFor(() => assert.equal(text('selection'), 'alpha|s-2'));
  const triggerBefore = Number(text('trigger'));

  fireEvent.click(screen.getByRole('button', { name: 'new here' }));
  await settle();
  await settle();

  assert.equal(text('path'), '/p/alpha');
  assert.equal(text('selection'), 'alpha|-');
  assert.equal(Number(text('trigger')), triggerBefore + 1, 'the chat gets its explicit reset');

  // A second press on the empty dialog still resets the chat (and keeps the address).
  fireEvent.click(screen.getByRole('button', { name: 'new here' }));
  await settle();
  assert.equal(text('path'), '/p/alpha');
  assert.equal(Number(text('trigger')), triggerBefore + 2);
});

test('«Новый диалог в beta» from a dialog of alpha opens an empty dialog of beta', async () => {
  await renderWorkspace('/p/alpha/s/s-1');
  await waitFor(() => assert.equal(text('selection'), 'alpha|s-1'));

  fireEvent.click(screen.getByRole('button', { name: 'new in beta' }));
  await settle();
  await settle();

  assert.equal(text('path'), '/p/beta');
  assert.equal(text('selection'), 'beta|-');
});
