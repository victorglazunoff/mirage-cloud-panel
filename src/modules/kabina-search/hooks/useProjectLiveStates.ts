import { useMemo } from 'react';

import { useHomeOverviewFeed } from '@/shared/hooks/useHomeOverviewFeed';
import type { HomeActivityItem } from '@/shared/types';
import type { ProjectLiveState } from '@/modules/kabina-search/utils/searchModel';

/** Live picture of the projects for the ⌘K rows and preview. */
export type ProjectLive = {
  states: Map<string, ProjectLiveState>;
  /** The busy session per project, for «Агент работает · 12 мин» / «Ждёт разрешения». */
  activity: Map<string, HomeActivityItem>;
  /** Total of known projects (`/api/home/overview`), for the footer and the ask preview. */
  projectCount: number | null;
};

/**
 * Used by KabinaSearch: which projects are working or waiting for the user right now,
 * from the shared home overview poll (the same answer as the home screen and the HUD).
 */
export function useProjectLiveStates(): ProjectLive {
  const { overview } = useHomeOverviewFeed();

  return useMemo(() => {
    const states = new Map<string, ProjectLiveState>();
    const activity = new Map<string, HomeActivityItem>();
    for (const item of overview?.activity ?? []) {
      if (!item.projectId) continue;
      const state: ProjectLiveState = item.state === 'waiting' ? 'wait' : 'run';
      // A waiting session outranks a running one in the same project.
      if (states.get(item.projectId) !== 'wait') {
        states.set(item.projectId, state);
        activity.set(item.projectId, item);
      }
    }
    return { states, activity, projectCount: overview?.projectCount ?? null };
  }, [overview]);
}
