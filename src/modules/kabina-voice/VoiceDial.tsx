import type { MutableRefObject } from 'react';

import { VoiceLiveWave } from '@/modules/kabina-voice/VoiceLiveWave';
import { VOICE_MAX_MS } from '@/modules/kabina-voice/hooks/useVoiceRecorder';
import { formatTimer } from '@/modules/kabina-voice/utils/voiceActionPlan';

/** What the dial centre says: recording, waiting for the server, parsed, or failed. */
export type DialState = 'live' | 'busy' | 'ready' | 'idle' | 'error';

/**
 * Used by both voice screens: the dial state of a flow phase. A failure says «НЕ ВЫШЛО»
 * in the dial too, as the header and the error card do — never a calm «ЖДУ».
 */
export function dialStateOf(phase: string, hasIntent: boolean): DialState {
  if (phase === 'listening') return 'live';
  if (phase === 'transcribing' || phase === 'parsing') return 'busy';
  if (phase === 'error') return 'error';
  return hasIntent ? 'ready' : 'idle';
}

type DialProps = {
  elapsedMs: number;
  levels: MutableRefObject<number[]>;
  state: DialState;
};

/** Desktop dial geometry (DarkVoice): 280 px, scale r 121–131, progress arc r 116. */
const ARC_LENGTH = 728.85;
const DESKTOP_HEIGHTS = [14, 22, 34, 44, 52, 58, 64, 58, 52, 44, 34, 22, 14];
const DESKTOP_DURATIONS = [0.9, 1.15, 0.8, 1.05, 0.95, 1.2, 0.85, 1.1, 0.9, 1.25, 0.8, 1.05, 0.95];
const PHONE_HEIGHTS = [16, 26, 38, 30, 48, 60, 70, 76, 70, 60, 48, 30, 38, 26, 16];
const PHONE_DURATIONS = [0.9, 1.15, 0.8, 1.05, 0.95, 1.2, 0.85, 1.1, 0.9, 1.25, 0.8, 1.05, 0.95, 1.15, 0.9];

function tickPath(step: number, inner: number, outer: number, centre: number): string {
  let path = '';
  for (let value = 0; value < 60; value += step) {
    const angle = (value * 6 * Math.PI) / 180;
    path += `M${(centre + inner * Math.sin(angle)).toFixed(1)} ${(centre - inner * Math.cos(angle)).toFixed(1)}`
      + `L${(centre + outer * Math.sin(angle)).toFixed(1)} ${(centre - outer * Math.cos(angle)).toFixed(1)}`;
  }
  return path;
}

const DIAL_MINOR = tickPath(1, 124, 129, 140);
const DIAL_MAJOR = tickPath(5, 121, 131, 140);

function waveMode(state: DialState): 'live' | 'idle' | 'still' {
  if (state === 'live') return 'live';
  if (state === 'busy') return 'idle';
  return 'still';
}

const CORE_LABEL: Record<DialState, string> = { live: 'ЗАПИСЬ', busy: 'РАЗБИРАЮ', ready: 'РАЗОБРАЛ', idle: 'ЖДУ', error: 'НЕ ВЫШЛО' };
const CORE_LED: Record<DialState, string> = {
  live: 'kb-led kb-led-run', busy: 'kb-led kb-led-wait', ready: 'kb-led kb-led-ok', idle: 'kb-led kb-led-idle', error: 'kb-led kb-led-warn',
};

/**
 * Used by the desktop voice overlay (DarkVoice 01 «Слушаю»): the one-minute dial with
 * rippling rings, the filling arc, the second hand, the live wave and the timer.
 */
export function VoiceDial({ elapsedMs, levels, state }: DialProps) {
  const progress = Math.min(elapsedMs, VOICE_MAX_MS) / VOICE_MAX_MS;
  const timer = formatTimer(elapsedMs);
  return (
    <div className="kb-vo-dialcol">
      <div className="kb-vo-dial">
        {state === 'live' && (
          <>
            <span className="kb-vo-ripple" aria-hidden="true" />
            <span className="kb-vo-ripple" data-n="2" aria-hidden="true" />
            <span className="kb-vo-ripple" data-n="3" aria-hidden="true" />
          </>
        )}
        <svg viewBox="0 0 280 280" width="280" height="280" role="img" aria-label={`Запись: ${timer} из минуты`}>
          <path d={DIAL_MINOR} fill="none" stroke="rgba(255,236,210,0.26)" strokeWidth="1" />
          <path d={DIAL_MAJOR} fill="none" stroke="rgba(255,236,210,0.62)" strokeWidth="1.4" />
          <circle cx="140" cy="140" r="116" fill="none" stroke="rgba(255,236,210,0.07)" strokeWidth="4" />
          <circle
            className="kb-vo-arc"
            cx="140"
            cy="140"
            r="116"
            fill="none"
            stroke="#FF6A2B"
            strokeWidth="4"
            strokeDasharray={ARC_LENGTH}
            strokeDashoffset={(ARC_LENGTH * (1 - progress)).toFixed(1)}
            transform="rotate(-90 140 140)"
          />
          <g className="kb-vo-spin">
            <circle cx="140" cy="140" r="104" fill="none" stroke="rgba(255,236,210,0.12)" strokeWidth="1" strokeDasharray="2 6" />
          </g>
          <g fill="#948C7E" fontFamily="Martian Mono, monospace" fontSize="9" textAnchor="middle">
            <text x="140" y="14">0</text>
            <text x="272" y="143">15</text>
            <text x="140" y="275">30</text>
            <text x="8" y="143">45</text>
          </g>
          <g className="kb-vo-hand" style={{ transform: `rotate(${(progress * 360).toFixed(1)}deg)` }}>
            <path d="M140 140 L140 30" stroke="#FF8A55" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="140" cy="30" r="2.5" fill="#FF6A2B" />
          </g>
          <circle cx="140" cy="140" r="86" fill="#12110F" stroke="rgba(255,236,210,0.12)" strokeWidth="1" />
        </svg>
        <div className="kb-vo-dial-core" aria-hidden="true">
          <VoiceLiveWave heights={DESKTOP_HEIGHTS} durations={DESKTOP_DURATIONS} peak={6} delayStep={0.13} levels={levels} mode={waveMode(state)} />
          <span className="kb-m kb-vo-coretag" data-tone={state === 'ready' ? 'ok' : state === 'error' ? 'warn' : undefined}>
            <span className={CORE_LED[state]} />
            {CORE_LABEL[state]}
          </span>
        </div>
      </div>
      <div className="kb-vo-timer">
        <span className="kb-t kb-vo-timer-big">{timer}</span>
        <span className="kb-m kb-vo-timer-of">/ 1:00</span>
      </div>
    </div>
  );
}

function phoneTicks(litSeconds: number) {
  let dim = '';
  let dimMajor = '';
  let lit = '';
  for (let index = 0; index < 60; index += 1) {
    const major = index % 5 === 0;
    const inner = major ? 106 : 110;
    const angle = (index * 6 * Math.PI) / 180;
    const path = `M${(132 + inner * Math.sin(angle)).toFixed(1)} ${(132 - inner * Math.cos(angle)).toFixed(1)}`
      + `L${(132 + 120 * Math.sin(angle)).toFixed(1)} ${(132 - 120 * Math.cos(angle)).toFixed(1)}`;
    if (index < litSeconds) lit += path;
    else if (major) dimMajor += path;
    else dim += path;
  }
  return { dim, dimMajor, lit };
}

const PHONE_CORE: Record<DialState, string> = { live: 'СЛУШАЮ', busy: 'РАЗБИРАЮ', ready: 'РАЗОБРАЛ', idle: 'ЖДУ', error: 'НЕ ВЫШЛО' };

/**
 * Used by the phone voice screen (DarkPhoneVoice «Слушаю»): 60 ticks that light up
 * second by second, the language tag, the live wave and «СЛУШАЮ».
 */
export function PhoneVoiceDial({ elapsedMs, levels, state }: DialProps) {
  const { dim, dimMajor, lit } = phoneTicks(Math.round(Math.min(elapsedMs, VOICE_MAX_MS) / 1000));
  return (
    <div className="kb-vo-ph-dial kb-rise">
      <svg width="264" height="264" viewBox="0 0 264 264" aria-hidden="true">
        <path d={dim} fill="none" stroke="rgba(255,236,210,0.2)" strokeWidth="1.4" strokeLinecap="round" />
        <path d={dimMajor} fill="none" stroke="rgba(255,236,210,0.42)" strokeWidth="1.8" strokeLinecap="round" />
        <path d={lit} fill="none" stroke="#FF6A2B" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="132" cy="132" r="98" fill="#161512" stroke="rgba(255,236,210,0.1)" strokeWidth="1" />
        <circle cx="132" cy="132" r="88" fill="none" stroke="rgba(255,236,210,0.05)" strokeWidth="1" strokeDasharray="2 4" />
        <g fill="#948C7E" fontFamily="Martian Mono, monospace" fontSize="9" textAnchor="middle">
          <text x="132" y="12">0:00</text>
          <text x="256" y="135">0:15</text>
          <text x="132" y="262">0:30</text>
          <text x="8" y="135">0:45</text>
        </g>
      </svg>
      <div className="kb-vo-ph-dial-core">
        <span className="kb-m kb-vo-eyebrow" style={{ fontSize: 9.5, letterSpacing: '0.18em' }}>РУС · АВТО</span>
        <div role="img" aria-label="Уровень голоса">
          <VoiceLiveWave heights={PHONE_HEIGHTS} durations={PHONE_DURATIONS} peak={7} delayStep={0.11} levels={levels} mode={waveMode(state)} />
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className={CORE_LED[state]} />
          <span
            className="kb-m kb-vo-ph-coretag"
            style={state === 'ready' ? { color: 'var(--kb-sage)' } : state === 'error' ? { color: 'var(--kb-sand)' } : undefined}
          >
            {PHONE_CORE[state]}
          </span>
        </span>
      </div>
    </div>
  );
}
