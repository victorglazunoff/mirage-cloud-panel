import { useId } from 'react';

import '@/modules/kabina/kabinaStates.css';

/** Permission modes the card lists before the locked Bypass. */
type PermissionModeOption = { value: string; label: string };

const DEFAULT_MODES: PermissionModeOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'auto', label: 'Auto' },
  { value: 'plan', label: 'Plan' },
];

function LockGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

type BypassRootCardProps = {
  /** The active permission mode (highlighted). */
  mode: string;
  /** Picks another allowed mode; omitted → the modes are read-only labels as in the mock-up. */
  onModeChange?: (mode: string) => void;
  /** Modes before Bypass; Default / Auto / Plan by default. */
  modes?: PermissionModeOption[];
  /** Service user name in the fix-it steps; `mirage` by default. */
  serviceUser?: string;
  /** systemd unit in the steps; `mirage` by default (the unit name the install guide uses). */
  serviceName?: string;
};

/**
 * Used by the chat composer's permission menu, the settings screen and the
 * /states showcase: DarkStates E2 «Bypass недоступен под root» — the modes with
 * Bypass locked, why it is locked and the three steps that unlock it.
 */
export function BypassRootCard({
  mode,
  onModeChange,
  modes = DEFAULT_MODES,
  serviceUser = 'mirage',
  serviceName = 'mirage',
}: BypassRootCardProps) {
  const whyId = useId();
  return (
    <div className="kb-bypass">
      <div className="kb-bypass-modes">
        <span className="kb-m kb-bypass-label">ПРАВА</span>
        <div role="group" aria-label="Режим прав" className="kb-bypass-group">
          {modes.map((option) => {
            const isActive = option.value === mode;
            return onModeChange ? (
              <button
                key={option.value}
                type="button"
                className="kb-bypass-mode kb-seg"
                aria-pressed={isActive}
                data-active={isActive ? '' : undefined}
                onClick={() => onModeChange(option.value)}
              >
                {option.label}
              </button>
            ) : (
              <span key={option.value} className="kb-bypass-mode" data-active={isActive ? '' : undefined}>{option.label}</span>
            );
          })}
          <button type="button" className="kb-bypass-locked" aria-disabled="true" aria-describedby={whyId}>
            <LockGlyph />
            Bypass
          </button>
        </div>
      </div>
      <div id={whyId} className="kb-bypass-why">
        <span className="kb-bypass-title">Bypass недоступен под root</span>
        <span className="kb-bypass-text">
          Claude Code не даёт пропускать все подтверждения, когда панель запущена от root, — иначе любая команда пройдёт с полными
          правами сервера. Поэтому кнопка выключена заранее, а не ломает диалог посреди хода.
        </span>
      </div>
      <ol className="kb-m kb-bypass-steps">
        <li><span className="kb-bypass-n">1</span><span>создай пользователя: <span className="kb-bypass-code">useradd -m {serviceUser}</span></span></li>
        <li><span className="kb-bypass-n">2</span><span>в службе {serviceName}: <span className="kb-bypass-code">User={serviceUser}</span></span></li>
        <li><span className="kb-bypass-n">3</span><span>перезапусти — Bypass появится здесь сам</span></li>
      </ol>
      <span className="kb-bypass-foot">Пока можно Auto: рискованное решает классификатор и спрашивает тебя.</span>
    </div>
  );
}
