import { matchPath } from 'react-router-dom';

import type { KabinaRoute } from '@/shared/types';

function decode(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Used by KabinaApp (to pick the screen) and by the project-workspace module
 * (to feed the open project and session into its state): decodes a pathname
 * and query string into a «Кабина» route.
 */
export function matchKabinaRoute(pathname: string, search = ''): KabinaRoute {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { screen: 'home' };
  if (path === '/projects') return { screen: 'projects' };
  if (path === '/agents') return { screen: 'agents' };
  if (path === '/calendar') return { screen: 'calendar' };
  if (path === '/states') return { screen: 'states' };
  if (path === '/files') {
    return { screen: 'files', projectId: decode(new URLSearchParams(search).get('project') ?? undefined) };
  }

  const settings = matchPath('/settings/:section?', path);
  if (settings) return { screen: 'settings', section: decode(settings.params.section) };

  const session = matchPath('/p/:projectId/s/:sessionId', path);
  if (session) {
    return { screen: 'chat', projectId: decode(session.params.projectId), sessionId: decode(session.params.sessionId) };
  }
  const project = matchPath('/p/:projectId', path);
  if (project) return { screen: 'chat', projectId: decode(project.params.projectId), sessionId: null };
  const legacy = matchPath('/session/:sessionId', path);
  if (legacy) return { screen: 'chat', projectId: null, sessionId: decode(legacy.params.sessionId) };

  return { screen: 'unknown' };
}

/** Used by the Kabina layer and project-workspace to build the canonical chat address. */
export function kabinaChatPath(projectId: string, sessionId?: string | null): string {
  const base = `/p/${encodeURIComponent(projectId)}`;
  return sessionId ? `${base}/s/${encodeURIComponent(sessionId)}` : base;
}

/** Query flag that opens the HUD's limits panel (KabinaHud consumes and drops it). */
export const LIMITS_DETAILS_FLAG = 'limits';

/**
 * Used by home (the «Лимиты» block and the limit warnings), the bell's limit entries and ⌘K
 * «Лимиты»: every «Подробнее» of the limits opens one place — the HUD's limits panel over
 * the given screen (home by default).
 */
export function kabinaLimitsHref(pathname = '/'): string {
  return `${pathname}?${LIMITS_DETAILS_FLAG}`;
}
