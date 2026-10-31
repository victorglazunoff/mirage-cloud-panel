import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { toPanelWall, usePanelTimeZone, zoneLabel } from '@/modules/kabina';
import { api } from '@/shared/api';
import type { AuthAttemptInfo, PendingAuthSession } from '@/shared/types';
import { useAuth } from '@/modules/auth/context/AuthContext';
import KabinaAuthLayout from '@/modules/auth/KabinaAuthLayout';
import { KabinaAuthAlert, KabinaPasswordField, KabinaSubmitButton } from '@/modules/auth/KabinaAuthFields';
import TwoFactorStep from '@/modules/auth/TwoFactorStep';

const TITLE_ID = 'kb-login-title';
const LOCK_TOTAL_SEC = 15 * 60;
/** How long «Доступ открыт» stays before the Kabina opens by itself. */
const ENTER_DELAY_MS = 2600;

/** «Chrome, macOS» from the user agent — the same words the server uses for «Активные входы». */
function describeBrowser(userAgent: string): string {
  const browser = /YaBrowser/.test(userAgent)
    ? 'Яндекс Браузер'
    : /Edg\//.test(userAgent)
      ? 'Edge'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'браузер';
  const system = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return system ? `${browser}, ${system}` : browser;
}

/**
 * Place for the device line, from the browser zone as the browser names it in
 * Russian: «Екатеринбург», «Москва», «Восточная Европа» (the «, стандартное
 * время» tail is dropped). Null when the browser cannot name it.
 */
function browserCity(): string | null {
  try {
    const name = new Intl.DateTimeFormat('ru-RU', { timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value;
    const place = name?.split(',')[0]?.trim();
    return place && !/^(GMT|UTC)/.test(place) ? place : null;
  } catch {
    return null;
  }
}

const pad = (value: number) => String(value).padStart(2, '0');

/** «1 попытка», «2 попытки», «5 попыток». */
function attemptsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} попытка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} попытки`;
  return `${count} попыток`;
}

type Step = 'cred' | 'code' | 'done';

type LoginError = { title: string; hint: string | null };

type DoneInfo = {
  session: PendingAuthSession;
  signedAt: Date;
  /** Other live sign-ins, «2 · iPhone, ноутбук»; null until the list arrives. */
  others: string | null;
  /**
   * How the second factor went: a code was entered, a remembered device skipped
   * it, 2FA is off, or (null) not known yet.
   */
  factor: 'code' | 'trusted' | 'off' | null;
};

/**
 * The «Кабина» sign-in: password, the
 * TOTP step when 2FA is on, wrong-password and lock states driven by the
 * server's attempt counters, «Забыл пароль» and «Доступ открыт».
 * Rendered by the auth module's ProtectedRoute when no user session exists.
 */
export default function LoginForm() {
  usePanelTimeZone();
  const { error: sessionError, requestLogin, verifySecondFactor, enterSession } = useAuth();

  // Which card is shown: password, code, or «Доступ открыт».
  const [step, setStep] = useState<Step>('cred');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // The open «Забыл пароль?» explanation.
  const [forgotOpen, setForgotOpen] = useState(false);
  // Refusal of the password step (title + hint), shown above the fields.
  const [credError, setCredError] = useState<LoginError | null>(null);
  // Refusal of the code step.
  const [codeError, setCodeError] = useState<string | null>(null);
  // Latest attempt counters from the server; they drive the «Попытки» dial.
  const [attempts, setAttempts] = useState<AuthAttemptInfo | null>(null);
  // When the 15-minute lock ends (epoch ms) and how long it was when it started.
  const [lock, setLock] = useState<{ untilMs: number; totalSec: number } | null>(null);
  // Seconds left on the lock, ticking every second.
  const [lockLeftSec, setLockLeftSec] = useState(0);
  // Challenge from the password step for the code step.
  const [challenge, setChallenge] = useState<{ token: string; username: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The issued session shown on «Доступ открыт» before it is published.
  const [done, setDone] = useState<DoneInfo | null>(null);

  const device = useMemo(() => describeBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent), []);

  // Lock countdown; when it runs out the form comes back with a fresh attempt count.
  useEffect(() => {
    if (!lock) return undefined;
    const tick = () => {
      const left = Math.max(0, Math.ceil((lock.untilMs - Date.now()) / 1000));
      setLockLeftSec(left);
      if (left === 0) {
        setLock(null);
        setAttempts(null);
        setCredError(null);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [lock]);

  const applyLock = useCallback((info: AuthAttemptInfo | null) => {
    const seconds = info?.retryAfterSec ?? LOCK_TOTAL_SEC;
    setLock({ untilMs: Date.now() + seconds * 1000, totalSec: Math.max(seconds, LOCK_TOTAL_SEC) });
    setForgotOpen(true);
  }, []);

  const finish = useCallback(
    (session: PendingAuthSession, usedSecondFactor: boolean) => {
      setDone({ session, signedAt: new Date(), others: null, factor: usedSecondFactor ? 'code' : null });
      setStep('done');
      setAttempts(null);
      // Without a code step: either a remembered device let us through, or 2FA is off.
      if (!usedSecondFactor) {
        void api.auth
          .twoFactorStatus(session.token)
          .then(async (response) => {
            const status = response.ok ? ((await response.json()) as { enabled?: boolean }) : null;
            const factor = status?.enabled ? 'trusted' : 'off';
            setDone((previous) => (previous ? { ...previous, factor } : previous));
          })
          .catch(() => undefined);
      }
      // The list of other sign-ins is read with the new token before it is published.
      void api.auth
        .sessions(session.token)
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { sessions?: Array<{ current: boolean; deviceLabel: string }> };
          const others = (body.sessions ?? []).filter((entry) => !entry.current);
          const labels = Array.from(new Set(others.map((entry) => entry.deviceLabel))).slice(0, 2).join(', ');
          setDone((previous) =>
            previous ? { ...previous, others: others.length === 0 ? 'нет' : `${others.length} · ${labels}` } : previous,
          );
        })
        .catch(() => undefined);
    },
    [],
  );

  const handleCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting || lock) return;
    if (!username.trim() || !password) {
      setCredError({ title: 'Введи логин и пароль', hint: null });
      return;
    }
    setIsSubmitting(true);
    setCredError(null);
    const outcome = await requestLogin(username.trim(), password);
    setIsSubmitting(false);

    if (outcome.kind === 'second-factor') {
      setChallenge({ token: outcome.challengeToken, username: outcome.username || username.trim() });
      setCodeError(null);
      setStep('code');
      return;
    }
    if (outcome.kind === 'session') {
      finish(outcome.session, false);
      return;
    }

    if (outcome.attempts) setAttempts(outcome.attempts);
    if (outcome.code === 'AUTH_LOCKED') {
      applyLock(outcome.attempts);
      return;
    }
    // Mirage: the fields were disabled while the request ran, so focus went to <body>; put it back
    // on the password, selected, so the next attempt is typed straight away.
    window.setTimeout(() => {
      const field = document.getElementById('password') as HTMLInputElement | null;
      field?.focus();
      field?.select();
    }, 0);
    if (outcome.code === 'AUTH_INVALID_CREDENTIALS') {
      const left = outcome.attempts?.attemptsLeft;
      setCredError({
        title: 'Логин или пароль не подходят',
        hint: left === undefined
          ? 'Проверь раскладку и Caps Lock.'
          : `Проверь раскладку и Caps Lock. Осталось ${attemptsWord(left)} — после пятой вход закроется на 15 минут.`,
      });
      return;
    }
    setCredError({ title: outcome.message, hint: null });
  };

  const handleCode = async (input: { code?: string; backupCode?: string; rememberDevice: boolean }) => {
    if (!challenge || isSubmitting) return;
    setIsSubmitting(true);
    setCodeError(null);
    const outcome = await verifySecondFactor({ challengeToken: challenge.token, ...input });
    setIsSubmitting(false);

    if (outcome.kind === 'session') {
      finish(outcome.session, true);
      return;
    }
    if (outcome.kind === 'error') {
      if (outcome.attempts) setAttempts(outcome.attempts);
      if (outcome.code === 'AUTH_LOCKED') {
        setStep('cred');
        applyLock(outcome.attempts);
        return;
      }
      if (outcome.code === 'AUTH_2FA_CHALLENGE_EXPIRED') {
        setStep('cred');
        setCredError({ title: 'Время на ввод кода вышло', hint: 'Войди заново — пароль ещё раз, потом свежий код.' });
        return;
      }
      const left = outcome.attempts?.attemptsLeft;
      setCodeError(left === undefined ? outcome.message : `${outcome.message.replace(/\.$/, '')} · осталось ${attemptsWord(left)}`);
    }
  };

  const enter = useCallback(() => {
    if (done) void enterSession(done.session);
  }, [done, enterSession]);

  // «Доступ открыт · загружаю кабину»: the Kabina opens by itself after a short beat.
  useEffect(() => {
    if (step !== 'done' || !done) return undefined;
    const timer = window.setTimeout(enter, ENTER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [done, enter, step]);

  const locked = step === 'cred' && lock !== null;
  const wrong = step === 'cred' && credError !== null && !locked;
  const usedAttempts = locked ? (attempts?.maxAttempts ?? 5) : attempts ? attempts.maxAttempts - attempts.attemptsLeft : 0;
  const maxAttempts = attempts?.maxAttempts ?? 5;
  const lockEndText = lock ? (() => {
    const end = new Date(lock.untilMs);
    const wall = toPanelWall(end);
    return `в ${pad(wall.getHours())}:${pad(wall.getMinutes())} ${zoneLabel(end)}`;
  })() : '';

  const stepCode = step === 'done'
    ? 'ВХОД ВЫПОЛНЕН'
    : step === 'code'
      ? 'ШАГ 2 ИЗ 2 · ВТОРОЙ ФАКТОР'
      : locked
        ? 'ВХОД НА ПАУЗЕ'
        : 'ШАГ 1 ИЗ 2 · ПАРОЛЬ';
  const heroTitle = step === 'done'
    ? 'Все системы в норме. Кабина твоя.'
    : locked
      ? 'Системы в норме. Вход на паузе.'
      : 'Системы в норме. Осталось войти.';
  const promptText = step === 'done'
    ? 'доступ открыт · загружаю кабину'
    : locked
      ? `вход закрыт · подожди ${Math.floor(lockLeftSec / 60)}:${pad(lockLeftSec % 60)}`
      : step === 'code'
        ? 'жду код второго фактора'
        : 'жду логин и пароль';

  const mm = Math.floor(lockLeftSec / 60);
  const ss = lockLeftSec % 60;
  const city = browserCity();

  return (
    <KabinaAuthLayout
      titleId={TITLE_ID}
      stepCode={stepCode}
      stepTone={step === 'done' ? 'ok' : locked ? 'wait' : 'mute'}
      stepSegments={{ lit: step === 'cred' ? 1 : 2, done: step === 'done' }}
      alarm={wrong || locked || (step === 'code' && codeError !== null)}
      heroTitle={heroTitle}
      loginLamp={{
        state: step === 'done' ? 'ok' : 'wait',
        label: step === 'done' ? 'выполнен' : locked ? 'закрыт на 15 мин' : 'ждёт тебя',
      }}
      attempts={{ used: usedAttempts, max: maxAttempts, locked }}
      prompt={{ text: promptText, tone: step === 'done' ? 'ok' : locked ? 'wait' : 'text', cursor: step !== 'done' }}
    >
      {step === 'cred' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h1 id={TITLE_ID} className="kb-t kb-auth-title">Войти в кабину</h1>
            <p className="kb-auth-desc">Логин и пароль, которые ты задал при установке панели.</p>
          </div>

          {!credError && sessionError && !locked && <KabinaAuthAlert title={sessionError} />}
          {wrong && credError && <KabinaAuthAlert title={credError.title}>{credError.hint && renderHint(credError.hint)}</KabinaAuthAlert>}

          {!locked && (
            <form onSubmit={handleCredentials} style={{ display: 'flex', flexDirection: 'column', gap: 16 }} noValidate>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor="username" className="kb-label">ЛОГИН</label>
                <input
                  id="username"
                  className="kb-field"
                  type="text"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={username}
                  disabled={isSubmitting}
                  aria-invalid={wrong && credError?.title === 'Логин или пароль не подходят'}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              <KabinaPasswordField
                id="password"
                label="ПАРОЛЬ"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                disabled={isSubmitting}
                invalid={wrong && credError?.title === 'Логин или пароль не подходят'}
                labelAside={
                  <button type="button" className="kb-textlink" onClick={() => setForgotOpen((open) => !open)} aria-expanded={forgotOpen} aria-controls="kb-forgot">
                    Забыл пароль?
                  </button>
                }
              />
              <KabinaSubmitButton label="Войти" busyLabel="Вхожу…" busy={isSubmitting} />
            </form>
          )}

          {locked && (
            <div role="alert" className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16, background: '#241A14', border: '1px solid rgba(255,106,43,0.5)', borderRadius: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="kb-led kb-led-wait" />
                <span className="kb-m" style={{ fontSize: 10.5, fontWeight: 500, letterSpacing: '0.18em', color: '#FF8A55' }}>ВХОД ЗАКРЫТ</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 16, fontWeight: 500 }}>Слишком много попыток</span>
                <span style={{ fontSize: 13, lineHeight: 1.55, color: '#B3AA9B', textWrap: 'pretty' }}>
                  Пять неверных паролей подряд — вход закрыт на 15 минут, чтобы пароль нельзя было подобрать. Подожди или сбрось пароль на сервере.
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="kb-m" style={{ fontSize: 9.5, letterSpacing: '0.18em', color: '#948C7E' }}>ОТКРОЕТСЯ ЧЕРЕЗ</span>
                  <span
                    className="kb-t"
                    role="timer"
                    aria-label={`Вход откроется через ${mm} мин ${ss} с`}
                    style={{ fontSize: 44, lineHeight: 0.95, fontWeight: 500, color: '#FF8A55', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {pad(mm)}:{pad(ss)}
                  </span>
                </div>
                <span className="kb-m" style={{ fontSize: 11, color: '#B3AA9B', textAlign: 'right' }}>{lockEndText}</span>
              </div>
              <span aria-hidden="true" style={{ display: 'block', height: 4, background: 'rgba(255,236,210,0.08)', borderRadius: 2, overflow: 'hidden' }}>
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${lock ? ((lockLeftSec / lock.totalSec) * 100).toFixed(1) : 0}%`,
                    background: 'repeating-linear-gradient(135deg, #FF6A2B 0 3px, rgba(255,106,43,0.45) 3px 6px)',
                    transition: 'width 1s linear',
                  }}
                />
              </span>
            </div>
          )}

          {(forgotOpen || locked) && (
            <div id="kb-forgot" className="kb-auth-well kb-fadein">
              <span style={{ fontSize: 13, lineHeight: 1.55, color: '#B3AA9B', textWrap: 'pretty' }}>
                Пароль меняется только на самом сервере — через интернет его не сбросить, и это защита. Открой терминал сервера и выполни:
              </span>
              <div className="kb-m kb-command">
                <span style={{ color: '#FF6A2B' }}>$</span>
                <span style={{ whiteSpace: 'nowrap', color: '#EDE6DA' }}>mirage passwd</span>
              </div>
              <span style={{ fontSize: 12, color: '#948C7E', textWrap: 'pretty' }}>
                Под тем же пользователем, от которого запущена панель. Без глобальной команды — из папки панели: <span className="kb-m" style={{ whiteSpace: 'nowrap' }}>npm run mirage -- passwd</span>. После смены все открытые входы закроются, блокировка попыток снимется.
              </span>
            </div>
          )}
        </>
      )}

      {step === 'code' && challenge && (
        <TwoFactorStep
          titleId={TITLE_ID}
          username={challenge.username}
          deviceLine={['новое устройство', device, city].filter(Boolean).join(' · ')}
          error={codeError}
          busy={isSubmitting}
          onSubmit={(input) => void handleCode(input)}
          onBack={() => {
            setStep('cred');
            setChallenge(null);
            setCodeError(null);
            setPassword('');
          }}
        />
      )}

      {step === 'done' && done && (
        <div className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 44, height: 44, flex: 'none', display: 'grid', placeItems: 'center', border: '1px solid rgba(156,196,154,0.45)', borderRadius: '50%', color: '#9CC49A', boxShadow: '0 0 18px rgba(156,196,154,0.18)' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 12l5 5 9-10" />
              </svg>
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h1 id={TITLE_ID} className="kb-t kb-auth-title">Доступ открыт</h1>
              <span className="kb-m" style={{ fontSize: 11, color: '#9CC49A' }}>все системы в норме</span>
            </div>
          </div>
          <p role="status" style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: '#B3AA9B', textWrap: 'pretty' }}>
            {doneText(done)}
          </p>
          <ul className="kb-m kb-auth-done-list">
            <li>
              <span>вход</span>
              <span>{pad(toPanelWall(done.signedAt).getHours())}:{pad(toPanelWall(done.signedAt).getMinutes())} · {device}</span>
            </li>
            <li>
              <span>устройство</span>
              <span>{deviceText(done)}</span>
            </li>
            <li>
              <span>другие входы</span>
              <span>{done.others ?? '…'}</span>
            </li>
          </ul>
          <button type="button" className="kb-btn kb-pri kb-auth-submit" onClick={enter}>
            <span>Открыть кабину</span>
            <svg className="kb-auth-arr" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      )}
    </KabinaAuthLayout>
  );
}

/** Highlights «N попытки» in the wrong-password hint, as the mock-up does. */
function renderHint(hint: string) {
  const match = hint.match(/(\d+ попыт\S*)/);
  if (!match || match.index === undefined) return hint;
  return (
    <>
      {hint.slice(0, match.index)}
      <span className="kb-m" style={{ color: '#FF8A55' }}>{match[1]}</span>
      {hint.slice(match.index + match[1].length)}
    </>
  );
}

function doneText(done: DoneInfo): string {
  const tail = ' Кабина откроется там же, где ты её оставил.';
  if (done.session.trustedDevice) return `Устройство запомнено на 30 дней — код здесь больше не спросим.${tail}`;
  if (done.factor === 'trusted') return `Устройство уже доверенное — код не спрашивали.${tail}`;
  if (done.factor === 'code') return `Это устройство не запомнено — при следующем входе снова спросим код.${tail}`;
  if (done.factor === 'off') return `Вход по паролю: второй фактор выключен — включить его можно в Настройках → Аккаунт.${tail}`;
  return `Пароль принят.${tail}`;
}

function deviceText(done: DoneInfo): string {
  const expires = done.session.trustedDevice?.expiresAt;
  if (expires) {
    const date = toPanelWall(expires);
    return `запомнено до ${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
  }
  if (done.factor === 'trusted') return 'доверенное · код не нужен';
  if (done.factor === 'off') return 'без кода · 2FA выключена';
  return done.factor === 'code' ? 'не запомнено' : '…';
}
