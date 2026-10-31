import { createPortal } from 'react-dom';

import { usePressOrHold } from '@/modules/kabina/hooks/usePressOrHold';
import { MicIcon } from '@/modules/kabina/ui/KabinaIcons';
import { primeMicrophone } from '@/modules/kabina/utils/micPrimer';

type VoiceButtonProps = {
  onActivate: () => void;
  /** A press held this long is push-to-talk: the phrase is sent on release (onHoldEnd). */
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
  /** Phone size (64px button, 84px ring) docked above the bottom navigation. */
  isPhone?: boolean;
  /** Chat layout: the hint sits above the button instead of to its left (DarkChat). */
  stacked?: boolean;
  /** True while the voice overlay is open; keeps the pressed look. */
  active?: boolean;
  /** The microphone records: the button pulses, the ring spins fast, the hint says «отпусти — отправить». */
  live?: boolean;
  /** Rendered above the voice overlay's scrim (DarkVoice keeps the button on top). */
  raised?: boolean;
  /** Push-to-talk combination from settings, for `aria-keyshortcuts` (`Alt+Space`). */
  hotkey?: string;
  /** The same combination as the hint writes it («⌥ Пробел»). */
  hotkeyLabel?: string;
};

/**
 * Used by KabinaShell on every screen: the orange voice button with the rotating tick
 * ring and the «удерживай ⌥ Пробел» hint (the combination from settings; on the phone «нажми или удерживай»).
 * A tap opens voice (or, while it is open, stops and sends); a press held over 300 ms records
 * until the finger is lifted. The microphone is requested inside the press (iOS).
 */
export function VoiceButton({
  onActivate,
  onHoldStart,
  onHoldEnd,
  isPhone = false,
  stacked = false,
  active = false,
  live = false,
  raised = false,
  hotkey = 'Alt+Space',
  hotkeyLabel = '⌥ Пробел',
}: VoiceButtonProps) {
  const size = isPhone ? 84 : 78;
  const radius = isPhone ? 40 : 37;
  // Dash pattern of the mock-ups: 36 one-pixel ticks round the ring ("1 5.457" at r=37).
  const gap = ((2 * Math.PI * radius) / 36 - 1).toFixed(3);
  const press = usePressOrHold({
    onTap: onActivate,
    onHoldStart,
    onHoldEnd,
    // While it records, a press stops and sends: no new microphone then.
    onPressStart: live ? undefined : primeMicrophone,
  });

  // Under a thumb «нажми или удерживай»: the key combination is a keyboard hint (.kb-keys).
  const hint = live
    ? 'отпусти — отправить'
    : isPhone
      ? <>нажми или удерживай<span className="kb-keys"> · {hotkeyLabel}</span></>
      : <>удерживай<span className="kb-keys"> {hotkeyLabel}</span></>;

  const dock = (
    <div
      className="kb-voice-dock"
      data-phone={isPhone ? '' : undefined}
      data-stacked={stacked ? '' : undefined}
      data-raised={raised ? '' : undefined}
      data-live={live ? '' : undefined}
    >
      <span className="kb-m kb-voice-hint" aria-hidden="true">{hint}</span>
      <span className="kb-voice-ringbox">
        <svg className="kb-voice-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(255,106,43,0.6)"
            strokeWidth="3"
            strokeDasharray={`1 ${gap}`}
          />
        </svg>
        <button
          type="button"
          className="kb-voice kb-press"
          data-active={active ? '' : undefined}
          data-live={live ? '' : undefined}
          aria-label={live
            ? 'Отправить запись на разбор'
            : isPhone ? 'Сказать Claude голосом — нажми или удерживай кнопку' : `Сказать Claude голосом — или удерживай ${hotkeyLabel}`}
          aria-keyshortcuts={hotkey}
          aria-pressed={active}
          {...press}
        >
          <MicIcon size={isPhone ? 26 : 24} />
        </button>
      </span>
    </div>
  );

  // The shell is a fixed stacking context, so above an overlay the dock must live in a portal.
  return raised && typeof document !== 'undefined'
    ? createPortal(<div className="kb-portal">{dock}</div>, document.body)
    : dock;
}
