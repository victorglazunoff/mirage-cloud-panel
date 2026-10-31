import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { api, readApiJson } from '@/shared/api';
import { encodeQr } from '@/modules/kabina-settings/utils/qrCode';

type PanelMode = 'enable' | 'disable' | 'codes';

type TwoFactorPanelProps = {
  mode: PanelMode;
  onClose: () => void;
  /** Called once the server state changed (2FA on/off, new codes) so the screen re-reads the status. */
  onChanged: () => void;
};

type Step =
  | { kind: 'password' }
  | { kind: 'scan'; secret: string; otpauthUri: string }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'done'; text: string };

/** Draws the otpauth URI as an SVG QR code; the secret never leaves the page. */
function QrCode({ text }: { text: string }) {
  const path = useMemo(() => {
    const matrix = encodeQr(text);
    let d = '';
    matrix.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }));
    return { d, size: matrix.length };
  }, [text]);
  return (
    <svg className="kb-set-qr" viewBox={`-2 -2 ${path.size + 4} ${path.size + 4}`} role="img" aria-label="QR-код для приложения-аутентификатора" shapeRendering="crispEdges">
      <path d={path.d} fill="#12110F" />
    </svg>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Не получилось — попробуй ещё раз';
}

/**
 * The second-factor flows of DarkSettings → Аккаунт, opened under the 2FA row:
 * enable (password → QR from `otpauthUri` + confirm code → ten backup codes),
 * disable (password + code or backup code) and fresh backup codes.
 * Rendered by the kabina-settings AccountSection.
 */
export default function TwoFactorPanel({ mode, onClose, onChanged }: TwoFactorPanelProps) {
  // Where the flow is: asking for the password, showing the QR, showing codes, finished.
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Disabling may use a backup code instead of the app code.
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // «Скопировано» feedback for the codes / secret.
  const [copied, setCopied] = useState<string | null>(null);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  };

  const downloadCodes = (codes: string[]) => {
    const blob = new Blob([`Mirage — резервные коды входа\nКаждый срабатывает один раз.\n\n${codes.join('\n')}\n`], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'mirage-backup-codes.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    if (!password) {
      setError('Введи текущий пароль');
      return;
    }
    if (mode === 'enable') {
      void run(async () => {
        const setup = await readApiJson<{ secret: string; otpauthUri: string }>(await api.auth.twoFactorSetup(password));
        setStep({ kind: 'scan', secret: setup.secret, otpauthUri: setup.otpauthUri });
      });
      return;
    }
    const cleaned = code.trim();
    if (!cleaned) {
      setError(useBackup ? 'Введи резервный код' : 'Введи 6 цифр из приложения');
      return;
    }
    if (mode === 'disable') {
      void run(async () => {
        await readApiJson(await api.auth.twoFactorDisable(useBackup ? { currentPassword: password, backupCode: cleaned } : { currentPassword: password, code: cleaned }));
        onChanged();
        setStep({ kind: 'done', text: 'Второй фактор выключен. Доверенные устройства забыты — вход снова только по паролю.' });
      });
      return;
    }
    void run(async () => {
      const result = await readApiJson<{ backupCodes: string[] }>(await api.auth.twoFactorBackupCodes(password, cleaned));
      onChanged();
      setStep({ kind: 'codes', codes: result.backupCodes });
    });
  };

  const confirmScan = (event: FormEvent) => {
    event.preventDefault();
    const cleaned = code.replace(/\D/g, '');
    if (cleaned.length !== 6) {
      setError('Нужно 6 цифр из приложения');
      return;
    }
    void run(async () => {
      const result = await readApiJson<{ backupCodes: string[] }>(await api.auth.twoFactorEnable(cleaned));
      onChanged();
      setStep({ kind: 'codes', codes: result.backupCodes });
    });
  };

  const title = mode === 'enable' ? 'Включить второй фактор' : mode === 'disable' ? 'Выключить второй фактор' : 'Новые резервные коды';

  return (
    <div className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 18, borderTop: '1px solid rgba(255,236,210,0.07)', background: '#161512' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="kb-m" style={{ fontSize: 10, letterSpacing: '0.18em', color: '#FF8A55' }}>{title.toUpperCase()}</span>
        <div className="kb-spacer" />
        <button type="button" className="kb-textlink" onClick={onClose}>{step.kind === 'done' || step.kind === 'codes' ? 'Закрыть' : 'Отмена'}</button>
      </div>

      {error && (
        <div role="alert" className="kb-alert kb-fadein">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF8A55" strokeWidth="1.8" aria-hidden="true" style={{ flex: 'none', marginTop: 1 }}><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></svg>
          <span className="kb-alert-title">{error}</span>
        </div>
      )}

      {step.kind === 'password' && (
        <form onSubmit={submitPassword} style={{ display: 'flex', flexDirection: 'column', gap: 14 }} noValidate>
          <span className="kb-set-desc">
            {mode === 'enable'
              ? 'Подтверди паролем — потом покажем QR-код для приложения-аутентификатора.'
              : mode === 'disable'
                ? 'Пароль и код из приложения. Все доверенные устройства тоже забудутся.'
                : 'Пароль и код из приложения. Старые резервные коды перестанут работать.'}
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <label className="kb-m kb-set-fieldlabel">
              ТЕКУЩИЙ ПАРОЛЬ
              <input className="kb-set-field" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
            </label>
            {mode !== 'enable' && (
              <label className="kb-m kb-set-fieldlabel">
                {useBackup ? 'РЕЗЕРВНЫЙ КОД' : 'КОД ИЗ ПРИЛОЖЕНИЯ'}
                <input
                  className="kb-set-field kb-m"
                  type="text"
                  inputMode={useBackup ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  placeholder={useBackup ? '7F3K-Q9PD' : '6 цифр'}
                  value={code}
                  onChange={(event) => setCode(useBackup ? event.target.value.toUpperCase() : event.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={busy}
                  style={{ letterSpacing: '0.16em', fontFamily: "'Martian Mono', ui-monospace, monospace" }}
                />
              </label>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px' }}>
            <button type="submit" className="kb-btn kb-pri" disabled={busy} style={{ minHeight: 44, padding: '0 18px', fontSize: 14, borderRadius: 6 }}>
              {busy ? 'Проверяю…' : mode === 'enable' ? 'Дальше' : mode === 'disable' ? 'Выключить' : 'Выпустить новые'}
            </button>
            {mode === 'disable' && (
              <button type="button" className="kb-textlink" onClick={() => { setUseBackup((value) => !value); setCode(''); }}>
                {useBackup ? 'Есть приложение — ввести код' : 'Телефона нет — резервным кодом'}
              </button>
            )}
          </div>
        </form>
      )}

      {step.kind === 'scan' && (
        <form onSubmit={confirmScan} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '18px 24px' }} noValidate>
          <QrCode text={step.otpauthUri} />
          <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span className="kb-set-desc">
              Отсканируй код в Google Authenticator, 1Password или любом TOTP-приложении. Запись появится как <span style={{ color: '#EDE6DA' }}>«Mirage»</span>.
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="kb-m" style={{ fontSize: 10, letterSpacing: '0.16em', color: '#948C7E' }}>НЕ СКАНИРУЕТСЯ — ВВЕДИ КЛЮЧ</span>
              <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                <code className="kb-m" style={{ fontSize: 12.5, letterSpacing: '0.08em', color: '#EDE6DA', wordBreak: 'break-all' }}>{step.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                <button type="button" className="kb-textlink" onClick={() => void copy(step.secret, 'secret')}>{copied === 'secret' ? 'Скопировано' : 'Скопировать'}</button>
              </span>
            </div>
            <label className="kb-m kb-set-fieldlabel" style={{ flex: 'none', maxWidth: 240 }}>
              КОД ИЗ ПРИЛОЖЕНИЯ
              <input
                className="kb-set-field"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6 цифр"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={busy}
                style={{ fontFamily: "'Martian Mono', ui-monospace, monospace", letterSpacing: '0.3em', fontSize: 18 }}
              />
            </label>
            <div>
              <button type="submit" className="kb-btn kb-pri" disabled={busy} style={{ minHeight: 44, padding: '0 18px', fontSize: 14, borderRadius: 6 }}>
                {busy ? 'Проверяю…' : 'Включить'}
              </button>
            </div>
          </div>
        </form>
      )}

      {step.kind === 'codes' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span className="kb-set-desc">
            {mode === 'enable' ? 'Второй фактор включён. ' : ''}Сохрани эти 10 кодов — каждый срабатывает один раз, если телефона нет под рукой. Больше их не покажем.
          </span>
          <ul className="kb-m kb-set-codes" aria-label="Резервные коды">
            {step.codes.map((backupCode) => <li key={backupCode}>{backupCode}</li>)}
          </ul>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="kb-btn kb-ghost" onClick={() => void copy(step.codes.join('\n'), 'codes')}>{copied === 'codes' ? 'Скопировано' : 'Скопировать'}</button>
            <button type="button" className="kb-btn kb-ghost" onClick={() => downloadCodes(step.codes)}>Скачать .txt</button>
            <button type="button" className="kb-btn kb-pri" onClick={onClose}>Я сохранил коды</button>
          </div>
        </div>
      )}

      {step.kind === 'done' && <span role="status" style={{ fontSize: 13.5, color: '#9CC49A' }}>{step.text}</span>}
    </div>
  );
}
