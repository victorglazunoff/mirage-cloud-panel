import { useState } from 'react';

import '@/modules/kabina/kabinaStates.css';
import { Button } from '@/modules/kabina/ui/Button';
import { WifiOffIcon } from '@/modules/kabina/ui/KabinaIcons';

type LoadErrorStateProps = {
  /** What did not load: «Сводка не загрузилась». */
  title: string;
  /** The reason as the request reported it (already in Russian); hidden when empty. */
  reason?: string | null;
  /** Reads again; the button waits while the promise (if any) is pending. */
  onRetry: () => void | Promise<unknown>;
  headingLevel?: 'h2' | 'h3';
  className?: string;
};

/**
 * Used by the home screen and the «Агенты» screen: what stands in place of a skeleton when the
 * first read failed — the DarkStates 06 empty-state layout (dashed glyph box, heading, reason)
 * with the single next step «Повторить». The screens also keep polling, so it clears by itself.
 */
export function LoadErrorState({ title, reason, onRetry, headingLevel = 'h2', className }: LoadErrorStateProps) {
  // A retry is on its way: the button waits instead of firing again.
  const [isRetrying, setIsRetrying] = useState(false);
  const Heading = headingLevel;

  const retry = () => {
    const pending = onRetry();
    if (!pending || typeof pending.then !== 'function') return;
    setIsRetrying(true);
    void pending.finally(() => setIsRetrying(false));
  };

  return (
    <div className={`kb-empty kb-loaderror${className ? ` ${className}` : ''}`} role="alert">
      <div className="kb-empty-glyph kb-bz" aria-hidden="true">
        <WifiOffIcon size={26} strokeWidth={1.3} />
      </div>
      <div className="kb-empty-copy">
        <span className="kb-m kb-loaderror-code">НЕ ЗАГРУЗИЛОСЬ</span>
        <Heading className="kb-empty-title">{title}</Heading>
        {reason ? <p className="kb-empty-text">{reason}</p> : null}
      </div>
      <Button variant="ghost" className="kb-empty-action" onClick={retry} disabled={isRetrying}>
        {isRetrying ? 'Повторяю…' : 'Повторить'}
      </Button>
    </div>
  );
}
