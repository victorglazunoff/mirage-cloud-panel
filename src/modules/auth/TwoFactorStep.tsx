import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react';

import { KabinaAuthAlert, KabinaSubmitButton } from '@/modules/auth/KabinaAuthFields';

type TwoFactorStepProps = {
  titleId: string;
  username: string;
  /** «новое устройство · Chrome, macOS · Екатеринбург». */
  deviceLine: string;
  /** Server message of the last refused code, or null. */
  error: string | null;
  busy: boolean;
  onSubmit: (input: { code?: string; backupCode?: string; rememberDevice: boolean }) => void;
  onBack: () => void;
};

const DIGIT_COUNT = 6;

/**
 * Step two of DarkLogin: six one-digit fields (the first carries
 * `autocomplete="one-time-code"` so a phone can paste the SMS/authenticator code
 * into all six), «запомнить устройство на 30 дней», and the backup-code fallback.
 * Rendered by LoginForm.
 */
export default function TwoFactorStep({ titleId, username, deviceLine, error, busy, onSubmit, onBack }: TwoFactorStepProps) {
  // The six typed digits; empty strings are unfilled cells.
  const [digits, setDigits] = useState<string[]>(() => Array(DIGIT_COUNT).fill(''));
  // «Запомнить это устройство» — on by default as in the mock-up.
  const [remember, setRemember] = useState(true);
  // Whether the backup-code field is unfolded.
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  // A refused code clears the cells and puts the caret back at the start.
  useEffect(() => {
    if (!error) return;
    setDigits(Array(DIGIT_COUNT).fill(''));
    inputs.current[0]?.focus();
  }, [error]);

  const fillFrom = (start: number, text: string) => {
    const incoming = text.replace(/\D/g, '').slice(0, DIGIT_COUNT - start).split('');
    if (incoming.length === 0) return;
    setDigits((previous) => {
      const next = [...previous];
      incoming.forEach((digit, offset) => {
        next[start + offset] = digit;
      });
      return next;
    });
    inputs.current[Math.min(DIGIT_COUNT - 1, start + incoming.length)]?.focus();
  };

  const handleChange = (index: number, value: string) => {
    if (value === '') {
      setDigits((previous) => previous.map((digit, position) => (position === index ? '' : digit)));
      return;
    }
    // Autofill of a one-time code lands the whole code in the first cell; fillFrom spreads it.
    fillFrom(index, value);
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      event.preventDefault();
      setDigits((previous) => previous.map((digit, position) => (position === index - 1 ? '' : digit)));
      inputs.current[index - 1]?.focus();
    } else if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      inputs.current[index - 1]?.focus();
    } else if (event.key === 'ArrowRight' && index < DIGIT_COUNT - 1) {
      event.preventDefault();
      inputs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    fillFrom(index, event.clipboardData.getData('text'));
  };

  const code = digits.join('');
  const usingBackup = backupOpen && backupCode.trim().length > 0;
  const canSubmit = usingBackup || code.length === DIGIT_COUNT;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !canSubmit) return;
    onSubmit(usingBackup ? { backupCode: backupCode.trim(), rememberDevice: remember } : { code, rememberDevice: remember });
  };

  // The next empty cell carries the orange edge, as the caret target in the mock-up.
  const nextEmpty = digits.findIndex((digit) => !digit);

  return (
    <form onSubmit={submit} style={{ display: 'contents' }} noValidate>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h1 id={titleId} className="kb-t kb-auth-title">Код из приложения</h1>
        <p className="kb-auth-desc">
          Пароль верный. Открой приложение-аутентификатор — запись{' '}
          <span style={{ color: '#EDE6DA' }}>«Mirage · {username}»</span> — и введи 6 цифр.
        </p>
      </div>

      <div className="kb-m" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: '#161512', border: '1px solid rgba(255,236,210,0.08)', borderRadius: 4, fontSize: 11, color: '#B3AA9B' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" style={{ flex: 'none' }}>
          <rect x="3" y="4" width="18" height="12" rx="1.5" />
          <path d="M8 20h8M12 16v4" />
        </svg>
        <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{deviceLine}</span>
      </div>

      {error && (
        <KabinaAuthAlert title={error}>
          Коды меняются каждые 30 секунд — возьми свежий. Если раз за разом не подходит, проверь время на телефоне: оно должно ставиться автоматически.
        </KabinaAuthAlert>
      )}

      <fieldset style={{ margin: 0, padding: 0, border: 'none', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <legend className="kb-label" style={{ padding: 0, marginBottom: 10 }}>КОД ИЗ 6 ЦИФР</legend>
        <div className="kb-auth-digits">
          {digits.map((digit, index) => (
            <span key={index} style={{ display: 'contents' }}>
              {index === 3 && <span className="kb-auth-digit-gap" aria-hidden="true" />}
              <input
                ref={(node) => {
                  inputs.current[index] = node;
                }}
                className="kb-auth-digit"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={index === 0 ? DIGIT_COUNT : 1}
                autoComplete={index === 0 ? 'one-time-code' : 'off'}
                aria-label={`Цифра ${index + 1} из 6`}
                aria-invalid={Boolean(error)}
                value={digit}
                disabled={busy}
                onChange={(event) => handleChange(index, event.target.value)}
                onKeyDown={(event) => handleKeyDown(index, event)}
                onPaste={(event) => handlePaste(index, event)}
                onFocus={(event) => event.target.select()}
                style={!error && index === nextEmpty ? { borderColor: 'rgba(255,106,43,0.55)' } : undefined}
              />
            </span>
          ))}
        </div>
      </fieldset>

      <label className="kb-check" htmlFor="kb-remember">
        <input id="kb-remember" type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 14, color: '#EDE6DA' }}>Запомнить это устройство на 30 дней</span>
          <span style={{ fontSize: 12, lineHeight: 1.45, color: '#948C7E', textWrap: 'pretty' }}>
            Код здесь больше не спросим. Отозвать — в Настройках → Аккаунт.
          </span>
        </span>
      </label>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <KabinaSubmitButton label="Подтвердить" busyLabel="Проверяю…" busy={busy} grow />
        <button type="button" className="kb-btn kb-ghost" onClick={onBack} style={{ minHeight: 48, padding: '0 16px', fontSize: 14, color: '#B3AA9B' }}>
          Назад
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 14, borderTop: '1px solid rgba(255,236,210,0.07)' }}>
        <button
          type="button"
          className="kb-textlink"
          onClick={() => setBackupOpen((open) => !open)}
          aria-expanded={backupOpen}
          aria-controls="kb-backup-box"
          style={{ alignSelf: 'flex-start' }}
        >
          Телефона нет под рукой — войти резервным кодом
        </button>
        {backupOpen && (
          <div id="kb-backup-box" className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="kb-backup" className="kb-label">РЕЗЕРВНЫЙ КОД</label>
            <input
              id="kb-backup"
              className="kb-field kb-m"
              data-size="md"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="7F3K-Q9PD"
              value={backupCode}
              disabled={busy}
              onChange={(event) => setBackupCode(event.target.value.toUpperCase())}
              style={{ letterSpacing: '0.12em' }}
            />
            <span style={{ fontSize: 12, color: '#948C7E' }}>Каждый из 10 кодов срабатывает один раз. Новые — в Настройках → Аккаунт.</span>
          </div>
        )}
      </div>
    </form>
  );
}
