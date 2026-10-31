import { useEffect, useRef } from 'react';

import type { VoiceFailure } from '@/modules/kabina-voice/hooks/useVoiceFlow';
import { Button } from '@/modules/kabina';

type VoiceAlertProps = {
  failure: VoiceFailure;
  onRetry: () => void;
  onClose: () => void;
  /** Phone: buttons stretch to full width. */
  isPhone?: boolean;
};

const RETRY_LABEL: Record<VoiceFailure['retry'], string> = {
  record: 'Записать заново',
  parse: 'Ещё раз',
  none: '',
};

/**
 * Used by both voice layouts for every failure (no SpeechKit key, no microphone,
 * empty recording, server errors): the sand «что случилось и что делать» card of
 * DarkStates 05, with the machine code as a chip and one clear next step.
 */
export function VoiceAlert({ failure, onRetry, onClose, isPhone = false }: VoiceAlertProps) {
  const mainRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mainRef.current?.focus();
  }, [failure.code]);

  return (
    <div className="kb-vo-alert kb-rise" role="alert">
      <div className="kb-vo-alert-head">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D9A35B" strokeWidth="1.8" aria-hidden="true">
          <path d="M12 3l10 18H2z" />
          <path d="M12 10v5M12 18v.5" />
        </svg>
        <h3 className="kb-vo-alert-title">{failure.title}</h3>
        <span className="kb-m kb-vo-alert-code">{failure.code}</span>
      </div>
      <p className="kb-vo-alert-text">{failure.text}</p>
      <div className="kb-vo-alert-row" style={isPhone ? { flexDirection: 'column', alignItems: 'stretch' } : undefined}>
        {failure.retry !== 'none' && (
          <Button ref={mainRef} variant="pri" size={isPhone ? 'lg' : 'md'} onClick={onRetry}>{RETRY_LABEL[failure.retry]}</Button>
        )}
        <Button ref={failure.retry === 'none' ? mainRef : undefined} variant="ghost" size={isPhone ? 'lg' : 'md'} onClick={onClose}>Закрыть</Button>
      </div>
    </div>
  );
}
