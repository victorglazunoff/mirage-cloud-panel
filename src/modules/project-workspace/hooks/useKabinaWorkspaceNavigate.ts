import { useMemo } from 'react';
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom';

/**
 * The workspace hook navigates with absolute authors' paths. In «Кабина» a bare
 * "/" from it is not "go home" but "the selection changed" (pick project, new
 * session…), so it is dropped here and KabinaUrlSync derives the address from
 * the selection instead. `/session/:id` passes through and is rewritten later.
 * Used by KabinaWorkspaceRoute (and its new-dialog test).
 */
export function useKabinaWorkspaceNavigate(routerNavigate: NavigateFunction): NavigateFunction {
  return useMemo<NavigateFunction>(() => ((to: To | number, options?: NavigateOptions) => {
    if (typeof to === 'number') return routerNavigate(to);
    if (to === '/') return undefined;
    return routerNavigate(to, options);
  }) as NavigateFunction, [routerNavigate]);
}
