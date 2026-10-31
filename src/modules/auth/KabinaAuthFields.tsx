import { useState } from 'react';
import type { ReactNode } from 'react';

/** Used by the auth module's LoginForm and SetupForm: the orange-edged alert box with the warning triangle. */
export function KabinaAuthAlert({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="alert" className="kb-alert kb-fadein">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF8A55" strokeWidth="1.8" aria-hidden="true" style={{ flex: 'none', marginTop: 1 }}>
        <path d="M12 3l10 18H2z" />
        <path d="M12 10v5M12 18v.5" />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span className="kb-alert-title">{title}</span>
        {children && <span className="kb-alert-text">{children}</span>}
      </div>
    </div>
  );
}

type PasswordFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  invalid?: boolean;
  disabled?: boolean;
  /** Slot to the right of the label: «Забыл пароль?». */
  labelAside?: ReactNode;
};

/** Used by the auth module's LoginForm and SetupForm: a password field with the show/hide eye inside it (DarkLogin). */
export function KabinaPasswordField({ id, label, value, onChange, autoComplete, invalid = false, disabled = false, labelAside }: PasswordFieldProps) {
  // Whether the characters are shown; the eye button toggles it.
  const [isShown, setIsShown] = useState(false);
  const toggleLabel = isShown ? 'Скрыть пароль' : 'Показать пароль';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <label htmlFor={id} className="kb-label">{label}</label>
        {labelAside}
      </div>
      <div style={{ position: 'relative' }}>
        <input
          id={id}
          className="kb-field"
          type={isShown ? 'text' : 'password'}
          name={id}
          autoComplete={autoComplete}
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
          style={{ paddingRight: 54, letterSpacing: isShown || !value ? '0.02em' : '0.12em' }}
        />
        <button
          type="button"
          className="kb-auth-eye"
          onClick={() => setIsShown((shown) => !shown)}
          aria-pressed={isShown}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          {isShown ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M3 3l18 18" />
              <path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
              <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

/** Used by the auth module's LoginForm and SetupForm: the orange primary button with the arrow that nudges right on hover. */
export function KabinaSubmitButton({
  label,
  busyLabel,
  busy,
  onClick,
  grow = false,
}: {
  label: string;
  busyLabel: string;
  busy: boolean;
  onClick?: () => void;
  /** Takes the free width of a button row (the code step's «Подтвердить» next to «Назад»). */
  grow?: boolean;
}) {
  return (
    <button
      type={onClick ? 'button' : 'submit'}
      onClick={onClick}
      className="kb-btn kb-pri kb-auth-submit"
      disabled={busy}
      aria-busy={busy}
      style={grow ? { flex: '1 1 200px' } : undefined}
    >
      <span>{busy ? busyLabel : label}</span>
      <svg className="kb-auth-arr" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </button>
  );
}
