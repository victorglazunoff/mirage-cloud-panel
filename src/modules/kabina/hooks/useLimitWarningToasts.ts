import { useEffect, useRef } from 'react';

import { useKabinaToasts } from '@/modules/kabina/context/KabinaToastContext';
import { kabinaLimitsHref } from '@/modules/kabina/utils/kabinaRoutes';
import { computeLimitWarnings, readLimitWarningFlag, writeLimitWarningFlag } from '@/modules/kabina/utils/limitWarnings';
import { useSubscriptionLimits } from '@/shared/hooks/useSubscriptionLimits';

/**
 * Used by KabinaApp (inside the toast provider) on every Kabina screen: raises
 * each DarkStates 04 limits warning as a sand toast exactly once per browser
 * (per warning key: threshold + window, or day for credits). The plaque on
 * the home screen stays until dismissed; the toast is the heads-up elsewhere.
 */
export function useLimitWarningToasts(): void {
  const limits = useSubscriptionLimits();
  const { show } = useKabinaToasts();
  const toolsRef = useRef({ show });
  toolsRef.current = { show };

  useEffect(() => {
    const { show: showToast } = toolsRef.current;
    for (const warning of computeLimitWarnings(limits, Date.now())) {
      if (readLimitWarningFlag('toast', warning.key) || readLimitWarningFlag('hidden', warning.key)) continue;
      writeLimitWarningFlag('toast', warning.key);
      showToast({
        id: `limit-${warning.code}`,
        kind: 'warn',
        project: `ЛИМИТЫ · ${warning.tag}`,
        title: warning.title,
        sub: warning.meta,
        actions: [{ label: 'Подробнее', href: kabinaLimitsHref() }],
      });
    }
  }, [limits]);
}
