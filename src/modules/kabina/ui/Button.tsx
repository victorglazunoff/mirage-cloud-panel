import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

import { StopSquareIcon } from '@/modules/kabina/ui/KabinaIcons';
import { cn } from '@/shared/utils';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `pri` — orange signal, `ghost` — outlined, `out` — orange outline (DarkPhoneMain «Разрешить 1 раз»). */
  variant?: 'pri' | 'ghost' | 'out';
  /** `sm` 32px (toasts, rulers), `md` 36px (rows), `lg` 52px (phone cards). */
  size?: 'sm' | 'md' | 'lg';
};

/** Used across the Kabina layer and home: the mock-ups' text buttons with their hover/press states. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('kb-btn', `kb-${variant}`, className)}
      data-size={size === 'md' ? undefined : size}
      {...rest}
    />
  );
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Required: icon buttons have no visible text. */
  'aria-label': string;
  /** `md` 44px header tool, `sm` 32px toast/close. */
  size?: 'sm' | 'md';
  /** Borderless muted variant (close buttons). */
  quiet?: boolean;
  children: ReactNode;
};

/** Used by the shell header (Files, Settings), toasts, modals and sheets: the square "ib" icon button. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = 'md', quiet = false, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('kb-ib', className)}
      data-size={size === 'md' ? undefined : size}
      data-quiet={quiet ? '' : undefined}
      {...rest}
    />
  );
});

type HoldButtonProps = {
  /** Fires once the button has been held for `holdMs`. */
  onConfirm: () => void;
  label?: string;
  /** Spoken name, e.g. «Остановить ход — удерживай полторы секунды». */
  ariaLabel: string;
  holdMs?: number;
  disabled?: boolean;
  className?: string;
  /** Mono caption after the label: «УДЕРЖИВАЙ» on desktop, «ДЕРЖИ» on the phone composer. */
  tag?: string;
  /** Tooltip, e.g. why a disabled hold cannot be used. */
  title?: string;
};

/**
 * Used by the chat (wave 2) and any destructive action: the "Стоп · УДЕРЖИВАЙ"
 * button. The orange fill grows while the pointer or Space/Enter is held and
 * the action fires only after `holdMs`; releasing early cancels it.
 */
export function HoldButton({ onConfirm, label = 'Стоп', ariaLabel, holdMs = 1500, disabled = false, className, tag = 'УДЕРЖИВАЙ', title }: HoldButtonProps) {
  // Whether a press is in progress; drives the fill transition.
  const [isHolding, setIsHolding] = useState(false);
  const timerRef = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsHolding(false);
  }, []);

  const start = useCallback(() => {
    if (disabled || timerRef.current !== null) return;
    setIsHolding(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setIsHolding(false);
      onConfirm();
    }, holdMs);
  }, [disabled, holdMs, onConfirm]);

  useEffect(() => cancel, [cancel]);

  return (
    <button
      type="button"
      className={cn('kb-btn kb-hold', className)}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      data-holding={isHolding ? '' : undefined}
      style={{ '--kb-hold-ms': `${holdMs}ms` } as CSSProperties}
      onPointerDown={(event) => {
        // Primary button only; right-click and pen barrel buttons do not start a hold.
        if (event.button > 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onKeyDown={(event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
          event.preventDefault();
          start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === ' ' || event.key === 'Enter') cancel();
      }}
      onBlur={cancel}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="kb-hold-fill" aria-hidden="true" />
      <StopSquareIcon />
      <span>{label}</span>
      <span className="kb-m kb-hold-tag">{tag}</span>
    </button>
  );
}
