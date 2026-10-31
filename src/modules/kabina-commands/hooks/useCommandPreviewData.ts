import { useEffect, useRef, useState } from 'react';

import type { CommandSpecial } from '@/modules/kabina-commands/utils/commandMenuModel';
import { api } from '@/shared/api';
import type { ContextUsageSnapshot, ProviderModelOption, SubscriptionLimits } from '@/shared/types';

/** Live numbers behind the special previews of the «/» menu. */
export type CommandPreviewData = {
  context: ContextUsageSnapshot | null;
  limits: SubscriptionLimits | null;
  models: ProviderModelOption[];
  effortLevels: string[];
  currentModel: string | null;
  currentEffort: string | null;
  /** True once the request for the current special finished (successfully or not). */
  settled: boolean;
};

type LoadedData = Omit<CommandPreviewData, 'settled'>;

const EMPTY: LoadedData = {
  context: null,
  limits: null,
  models: [],
  effortLevels: [],
  currentModel: null,
  currentEffort: null,
};

async function readData<T>(response: Response): Promise<T | null> {
  if (!response.ok) return null;
  const body = await response.json();
  return (body?.data ?? null) as T | null;
}

/**
 * Used by SlashCommandMenu's preview: loads only what the selected command shows —
 * `/api/context/:sessionId` for /context, /compact, /autocompact and /cost, the
 * subscription limits for /usage, the model catalog and the session's model and effort
 * for /model and /effort. Each source is fetched once per menu opening.
 */
export function useCommandPreviewData(special: CommandSpecial, sessionId: string | null): CommandPreviewData {
  // Everything loaded so far; specials share it, so switching back is instant.
  const [data, setData] = useState<LoadedData>(EMPTY);
  // Sources whose request finished, so the preview stops showing a skeleton for them.
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  // Sources already requested in this opening (a ref: asking twice must not wait for a render).
  const requestedRef = useRef(new Set<string>());

  const source = special === 'context' || special === 'cost'
    ? (sessionId ? 'context' : null)
    : special === 'usage'
      ? 'limits'
      : special === 'model' || special === 'effort'
        ? 'models'
        : null;

  useEffect(() => {
    if (!source || requestedRef.current.has(source)) return;
    requestedRef.current.add(source);
    const finish = (patch: Partial<LoadedData>) => {
      setData((previous) => ({ ...previous, ...patch }));
      setLoaded((previous) => new Set(previous).add(source));
    };

    if (source === 'context' && sessionId) {
      api.contextUsage(sessionId)
        .then((response) => readData<ContextUsageSnapshot>(response))
        .then((context) => finish({ context }))
        .catch(() => finish({}));
    } else if (source === 'limits') {
      api.home.limits()
        .then((response) => readData<SubscriptionLimits>(response))
        .then((limits) => finish({ limits }))
        .catch(() => finish({}));
    } else if (source === 'models') {
      Promise.all([
        api.providers.models('claude').then((response) => readData<{ models?: { OPTIONS?: ProviderModelOption[]; EFFORT_LEVELS?: string[] } }>(response)),
        sessionId
          ? api.providers.sessionActiveModel('claude', sessionId).then((response) => readData<{ model?: string; effort?: string | null }>(response))
          : Promise.resolve(null),
      ])
        .then(([catalog, active]) => finish({
          models: catalog?.models?.OPTIONS ?? [],
          effortLevels: catalog?.models?.EFFORT_LEVELS ?? [],
          currentModel: active?.model ?? null,
          currentEffort: active?.effort ?? null,
        }))
        .catch(() => finish({}));
    }
  }, [source, sessionId]);

  return { ...data, settled: !source || loaded.has(source) };
}
