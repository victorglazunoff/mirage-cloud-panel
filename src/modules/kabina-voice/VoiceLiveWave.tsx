import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

type VoiceLiveWaveProps = {
  /** Bar heights in px from the mock-ups (symmetric envelope). */
  heights: number[];
  /** Animation lengths of the idle wave (s), one per bar. */
  durations: number[];
  /** Index of the brightest (centre) bar. */
  peak: number;
  /** Delay step of the idle wave (s). */
  delayStep: number;
  /** Microphone levels, newest first, 0..1 (useVoiceRecorder). */
  levels: MutableRefObject<number[]>;
  /** `live` follows the microphone; `idle` is the mock's breathing wave (waiting for the server); `still` is flat. */
  mode: 'live' | 'idle' | 'still';
};

/**
 * Used by the voice dials (desktop and phone): the orange bars. While recording each
 * bar follows the real microphone level — the centre bar is the newest sample and
 * older samples move outwards — written straight to the DOM every frame so the
 * overlay does not re-render at 60 fps.
 */
export function VoiceLiveWave({ heights, durations, peak, delayStep, levels, mode }: VoiceLiveWaveProps) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    if (mode !== 'live') {
      barsRef.current.forEach((bar) => {
        if (bar) bar.style.transform = '';
      });
      return undefined;
    }
    let frame = 0;
    const draw = () => {
      const history = levels.current;
      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        const distance = Math.abs(index - peak);
        const level = history[Math.min(distance, history.length - 1)] ?? 0;
        // A floor keeps silence visible as a low line; the curve lifts quiet speech.
        const scale = Math.min(1, 0.14 + Math.pow(level, 0.8) * 1.1);
        bar.style.transform = `scaleY(${scale.toFixed(3)})`;
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levels, mode, peak]);

  return (
    <span className="kb-vo-bars" data-idle={mode === 'idle' ? '' : undefined} data-still={mode === 'still' ? '' : undefined} aria-hidden="true">
      {heights.map((height, index) => (
        <span
          // The bar list never reorders.
          key={index}
          ref={(node) => {
            barsRef.current[index] = node;
          }}
          className="kb-vo-wv"
          style={{
            height,
            opacity: index === peak ? 1 : 0.82,
            animationDuration: `${durations[index] ?? 1}s`,
            animationDelay: `${(-delayStep * index).toFixed(2)}s`,
          }}
        />
      ))}
    </span>
  );
}
