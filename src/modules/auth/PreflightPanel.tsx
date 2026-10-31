import type { CSSProperties } from 'react';

import { Gauge, toPanelWall, usePanelTimeZone } from '@/modules/kabina';
import type { usePreflightCheck } from '@/modules/auth/hooks/usePreflightCheck';

type PreflightPanelProps = {
  preflight: ReturnType<typeof usePreflightCheck>;
  heroTitle: string;
  loginLamp: { state: 'wait' | 'ok'; label: string };
  attempts: { used: number; max: number; locked: boolean };
  prompt: { text: string; tone: 'text' | 'wait' | 'ok'; cursor: boolean };
};

const OK = '#9CC49A';
const SIGNAL_TEXT = '#FF8A55';
const SOFT = '#B3AA9B';
const MUTE = '#948C7E';
const TEXT = '#EDE6DA';

/** Boot-log reveal delays from the mock-up, so the lines type out one after another. */
const LOG_DELAYS = [0.6, 0.85, 1.1, 1.35, 1.7];
const LAMP_DELAYS = ['0.7s', '0.95s', '1.2s', '1.45s', '1.7s', '1.95s'];

function clockTime(instant: Date): string {
  const date = toPanelWall(instant);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

type Lamp = { code: string; value: string; state: 'ok' | 'idle' | 'wait' | 'error' };

/**
 * The left half of DarkLogin: eyebrow and hero line, then the «Проверка систем»
 * plate — three self-testing dials (связь, часы, попытки), the lamp board and the
 * boot log ending in a prompt with a blinking cursor. Rendered by KabinaAuthLayout.
 */
export default function PreflightPanel({ preflight, heroTitle, loginLamp, attempts, prompt }: PreflightPanelProps) {
  usePanelTimeZone();
  const offline = preflight.phase === 'offline';
  const checking = preflight.phase === 'checking';

  const pingPercent = preflight.pingMs === null ? null : Math.min(100, (preflight.pingMs / 200) * 100);
  const skewAbsSec = preflight.clockSkewMs === null ? null : Math.abs(preflight.clockSkewMs) / 1000;
  // A square-root scale: tenths of a second still move the needle, 30 s (one TOTP step) is the stop.
  const skewPercent = skewAbsSec === null ? null : Math.min(100, Math.sqrt(skewAbsSec / 30) * 100);
  const skewOk = skewAbsSec !== null && skewAbsSec < 10;
  // Mock-up colours: sage while there is room, sand from the third miss, orange at the lock.
  const attemptsTone = attempts.used >= attempts.max ? 'signal' : attempts.used >= 3 ? 'sand' : 'sage';
  const left = Math.max(0, attempts.max - attempts.used);

  const attemptsCaption = attempts.locked
    ? 'лимит исчерпан · пауза 15 мин'
    : attempts.used === 0
      ? `ни одной ошибки · лимит ${attempts.max}`
      : `осталось ${left} из ${attempts.max}`;

  const serverUp = preflight.phase === 'done';
  const lamps: Lamp[] = [
    { code: 'СВЯЗЬ', value: offline ? 'нет ответа' : checking ? 'проверяю…' : 'сервер отвечает', state: offline ? 'error' : checking ? 'idle' : 'ok' },
    preflight.secure
      ? { code: 'TLS 1.3', value: 'шифрование включено', state: 'ok' }
      : { code: 'HTTP', value: 'локально · без TLS', state: 'idle' },
    { code: 'БАЗА', value: serverUp ? (preflight.databaseOk ? 'доступна' : 'не отвечает') : '—', state: serverUp && preflight.databaseOk ? 'ok' : offline ? 'error' : 'idle' },
    { code: 'CLAUDE CODE', value: serverUp ? 'на сервере · готов' : '—', state: serverUp ? 'ok' : 'idle' },
    { code: 'ГОЛОС', value: 'после входа', state: 'idle' },
    { code: 'ВХОД', value: loginLamp.label, state: loginLamp.state === 'ok' ? 'ok' : 'wait' },
  ];

  const selfTestText = offline ? 'нет связи · повторяю' : checking ? 'самотест…' : 'самотест пройден';
  const promptColor = prompt.tone === 'ok' ? OK : prompt.tone === 'wait' ? SIGNAL_TEXT : TEXT;
  const now = new Date();

  return (
    <div className="kb-auth-side">
      <div className="kb-rise" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span className="kb-m" style={{ fontSize: 10, letterSpacing: '0.22em', color: MUTE }}>КАБИНА · ПРЕДПОЛЁТНАЯ ПРОВЕРКА</span>
        <p className="kb-t kb-auth-hero">{offline ? 'Нет связи с сервером. Проверяю снова.' : heroTitle}</p>
        <p className="kb-auth-lead">
          Панель Claude Code для твоих проектов. Диалоги, агенты и лимиты появятся после входа — до него сервер не отдаёт ни строчки.
        </p>
      </div>

      <section className="kb-bz kb-rise kb-d1 kb-auth-plate" aria-label="Проверка систем">
        <span aria-hidden="true" className="kb-auth-scanline">
          <span className="kb-auth-bootscan" />
        </span>

        <div className="kb-heading" style={{ minHeight: 24 }}>
          <span className="kb-m kb-ruler-n" aria-hidden="true">01</span>
          <h2 className="kb-m kb-ruler-title">ПРИБОРЫ</h2>
          <span className="kb-ruler-scale" aria-hidden="true" />
          <span
            className="kb-m kb-auth-bootok"
            style={{ fontSize: 10.5, color: offline ? SIGNAL_TEXT : checking ? MUTE : OK, animationDelay: '2.1s' }}
            role="status"
          >
            {selfTestText}
          </span>
        </div>

        <div className="kb-auth-gauges">
          <Gauge
            selfTest
            delay="0.2s"
            name="Связь"
            caption={offline ? 'сервер не ответил' : 'задержка до сервера · норма до 150'}
            percent={pingPercent}
            valueLabel={preflight.pingMs === null ? '—' : `${preflight.pingMs} мс`}
          />
          <Gauge
            selfTest
            delay="0.35s"
            name="Часы"
            caption={
              skewAbsSec === null
                ? 'сверка с сервером…'
                : skewOk
                  ? 'сверены с сервером · коды 2FA пройдут'
                  : 'расходятся с сервером · включи автовремя'
            }
            percent={skewPercent}
            tone={skewOk ? 'signal' : 'brick'}
            valueLabel={preflight.skewLabel ?? '—'}
          />
          <Gauge
            selfTest
            delay="0.5s"
            name="Попытки"
            caption={attemptsCaption}
            percent={(attempts.used / attempts.max) * 100}
            tone={attemptsTone}
            valueLabel={`${attempts.used} / ${attempts.max}`}
            valueColor={attempts.used >= 3 ? SIGNAL_TEXT : TEXT}
          />
        </div>

        <div role="list" aria-label="Табло систем" className="kb-auth-lamps">
          {lamps.map((lamp, index) => (
            <div key={lamp.code} role="listitem" className="kb-auth-lamp" data-state={lamp.state}>
              <span
                className={
                  lamp.state === 'ok'
                    ? 'kb-lamp'
                    : lamp.state === 'wait'
                      ? 'kb-led kb-led-wait'
                      : lamp.state === 'error'
                        ? 'kb-led kb-led-error'
                        : 'kb-led kb-led-idle'
                }
                // The ВХОД lamp lights the moment access opens, not on the boot schedule.
                style={{ animationDelay: lamp.state === 'ok' && lamp.code !== 'ВХОД' ? LAMP_DELAYS[index] : undefined }}
              />
              <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span
                  className="kb-m"
                  style={{
                    fontSize: 9.5,
                    letterSpacing: '0.16em',
                    color: lamp.state === 'wait' || lamp.state === 'error' ? SIGNAL_TEXT : lamp.code === 'ВХОД' && lamp.state === 'ok' ? OK : SOFT,
                  }}
                >
                  {lamp.code}
                </span>
                <span style={{ fontSize: 12, color: SOFT, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lamp.value}</span>
              </span>
            </div>
          ))}
        </div>

        <ol className="kb-m kb-auth-log" aria-label="Журнал запуска">
          {preflight.log.map((line, index) => {
            const delay = LOG_DELAYS[index] ?? 1.7;
            return (
              <li key={line.what} className="kb-auth-bootln" style={{ animationDelay: `${delay.toFixed(2)}s` }}>
                <span className="kb-auth-logtime" style={{ color: MUTE }}>{clockTime(line.at)}</span>
                <span className="kb-auth-logwhat" style={{ color: SOFT }}>{line.what}</span>
                <span aria-hidden="true" className="kb-auth-dots" />
                <span
                  className="kb-auth-bootok"
                  style={{ flex: 'none', color: line.tone === 'ok' ? OK : line.tone === 'warn' ? '#D9A35B' : SIGNAL_TEXT, animationDelay: `${(delay + 0.3).toFixed(2)}s` }}
                >
                  {line.result}
                </span>
              </li>
            );
          })}
          <li className="kb-auth-bootln" style={{ paddingTop: 4, animationDelay: checking ? '0s' : '2.2s' } as CSSProperties}>
            <span className="kb-auth-logtime" style={{ color: MUTE }}>{clockTime(now)}</span>
            <span style={{ color: promptColor }}>
              {checking ? 'проверяю системы' : prompt.text}
              {prompt.cursor && <span className="kb-auth-cursor" aria-hidden="true" />}
            </span>
          </li>
        </ol>
      </section>
    </div>
  );
}
