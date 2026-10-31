import type { ReactNode } from 'react';

import '@/modules/auth/kabinaAuth.css';

import { Clock, KabinaLogoMark } from '@/modules/kabina';
import { PRODUCT_NAME, REPOSITORY_URL, UPSTREAM_NAME, UPSTREAM_URL } from '@/shared/constants';
import PreflightPanel from '@/modules/auth/PreflightPanel';
import { usePreflightCheck } from '@/modules/auth/hooks/usePreflightCheck';

type KabinaAuthLayoutProps = {
  /** Mono step code in the card's top bar: «ШАГ 1 ИЗ 2 · ПАРОЛЬ». */
  stepCode: string;
  /** Colour of the step code: muted, orange while locked, sage once in. */
  stepTone?: 'mute' | 'wait' | 'ok';
  /** The two progress segments of the card bar: how many are lit, and whether they are sage («вход выполнен»). */
  stepSegments: { lit: 1 | 2; done?: boolean };
  /** The card turns its border orange on an error or a lock. */
  alarm?: boolean;
  /** Card body. */
  children: ReactNode;
  /** Card heading id, referenced by the section's aria-labelledby. */
  titleId: string;
  /** Big hero line next to the card: «Системы в норме. Осталось войти.» */
  heroTitle: string;
  /** «ВХОД» lamp of the board: waiting, locked, done or not set up. */
  loginLamp: { state: 'wait' | 'ok'; label: string };
  /** Attempts dial: how many of the allowed tries are spent. */
  attempts: { used: number; max: number; locked: boolean };
  /** Last line of the boot log with the blinking cursor. */
  prompt: { text: string; tone: 'text' | 'wait' | 'ok'; cursor: boolean };
};

const STEP_COLORS = { mute: '#948C7E', wait: '#FF8A55', ok: '#9CC49A' } as const;

/**
 * Full-screen sign-in frame in the «Кабина» style:
 * header with the host and clock, the form card on the right (on top on a phone),
 * the preflight check on the left, mono footer. Used by the auth module's LoginForm
 * and SetupForm instead of the authors' AuthScreenLayout, which stays untouched so
 * upstream updates merge cleanly.
 */
export default function KabinaAuthLayout({
  stepCode,
  stepTone = 'mute',
  stepSegments,
  alarm = false,
  children,
  titleId,
  heroTitle,
  loginLamp,
  attempts,
  prompt,
}: KabinaAuthLayoutProps) {
  const preflight = usePreflightCheck();
  const host = typeof window === 'undefined' ? '' : window.location.host;
  const segmentColor = (lit: boolean) => (stepSegments.done ? '#9CC49A' : lit ? '#FF6A2B' : 'rgba(255,236,210,0.14)');

  return (
    <div className="kb-root kb-auth">
      <div className="kb-auth-inner">
        <header className="kb-auth-header">
          <span className="kb-logo">
            <KabinaLogoMark size={28} />
            <span className="kb-t kb-logo-word">MIRAGE</span>
          </span>
          <span className="kb-m kb-auth-host">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={preflight.secure ? '#9CC49A' : '#D9A35B'} strokeWidth="2" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <span>{host}</span>
            <span style={{ color: '#948C7E' }}>{preflight.secure ? '· защищено' : '· без шифрования'}</span>
          </span>
          <div className="kb-spacer" />
          <Clock />
        </header>

        <main className="kb-auth-main">
          <div className="kb-auth-cardcol">
            <section
              className="kb-bz kb-rise kb-d2 kb-auth-card"
              aria-labelledby={titleId}
              data-alarm={alarm ? '' : undefined}
            >
              <div className="kb-auth-cardbar">
                <span className="kb-m" style={{ fontSize: 10, letterSpacing: '0.2em', color: STEP_COLORS[stepTone] }}>{stepCode}</span>
                <div className="kb-spacer" />
                <div aria-hidden="true" style={{ display: 'flex', gap: 4 }}>
                  <span className="kb-auth-seg" style={{ background: segmentColor(true) }} />
                  <span className="kb-auth-seg" style={{ background: segmentColor(stepSegments.lit === 2) }} />
                </div>
              </div>
              <div className="kb-auth-cardbody">{children}</div>
            </section>
          </div>

          <PreflightPanel
            preflight={preflight}
            heroTitle={heroTitle}
            loginLamp={loginLamp}
            attempts={attempts}
            prompt={prompt}
          />
        </main>

        <footer className="kb-m kb-auth-footer">
          {/* AGPL-3.0 §13: the source of this version is one click away. */}
          <a className="kb-lnk" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" style={{ color: '#C9C1B3' }}>
            {PRODUCT_NAME} · исходный код
          </a>
          {/* LICENSE additional terms: the «modified version» marking and the verbatim upstream attribution. */}
          <span className="kb-auth-origin">
            изменённая версия · основано на{' '}
            <a className="kb-lnk" href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" style={{ color: '#948C7E' }}>
              {UPSTREAM_NAME} ({UPSTREAM_URL})
            </a>
            {' '}<span style={{ whiteSpace: 'nowrap' }}>· AGPL-3.0</span>
          </span>
          <div className="kb-spacer" />
          <span>сессия входа живёт 30 дней · после 5 ошибок — пауза 15 мин</span>
        </footer>
      </div>
    </div>
  );
}
