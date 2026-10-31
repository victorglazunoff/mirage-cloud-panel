import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

/**
 * Used by the kabina-chat project header («~/demo-site · mirage»): the git branch of the
 * open project from `GET` git status; null without git or while it loads.
 */
export function useProjectBranch(projectId: string | null): string | null {
  // Branch of the project the header shows; reset when the project changes.
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    setBranch(null);
    if (!projectId) return undefined;
    const controller = new AbortController();
    api.git.status(projectId, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { branch?: unknown } | null) => {
        if (!controller.signal.aborted) setBranch(typeof body?.branch === 'string' && body.branch ? body.branch : null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [projectId]);

  return branch;
}
