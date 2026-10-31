import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { MirageSettings, MirageSettingsView } from '@/shared/types';

type Widgets = MirageSettings['home']['widgets'];

/**
 * Used by HomeScreen: the widget list of DarkSettings 03 («Главный экран»)
 * from `GET /api/mirage-settings`, read on every visit of the home screen so a
 * change made in the settings shows on return. Null until the answer (or on
 * failure) — the layout then uses the default set.
 */
export function useHomeWidgets(): Widgets | null {
  // The saved order and switches; null before the first answer.
  const [widgets, setWidgets] = useState<Widgets | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await readApiJson<{ data: MirageSettingsView }>(await api.mirageSettings.get());
        if (!cancelled) setWidgets(body.data.settings.home.widgets);
      } catch {
        // The default widgets stay; the home screen must not break on a settings hiccup.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return widgets;
}
