import type { KabinaStatusKind } from '@/shared/types';

const STATUS_LABELS: Record<KabinaStatusKind, string> = {
  run: 'работает',
  wait: 'ждёт тебя',
  idle: 'тихо',
  ok: 'готово',
  warn: 'предупреждение',
  error: 'ошибка',
  cal: 'событие',
};

type StatusShapeProps = {
  kind: KabinaStatusKind;
  /** Announce the meaning to screen readers; off when the text next to it already says it. */
  labelled?: boolean;
  className?: string;
};

/**
 * Used by the home screen, toasts and shell: the 8px signal — breathing circle
 * (работает), blinking diamond (ждёт тебя), dark dot (тихо), sage dot (готово),
 * sand diamond (предупреждение), brick square (ошибка), ring (событие).
 */
export function StatusShape({ kind, labelled = false, className }: StatusShapeProps) {
  return (
    <span
      className={`kb-led kb-led-${kind}${className ? ` ${className}` : ''}`}
      data-status={kind}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? STATUS_LABELS[kind] : undefined}
      aria-hidden={labelled ? undefined : true}
    />
  );
}
