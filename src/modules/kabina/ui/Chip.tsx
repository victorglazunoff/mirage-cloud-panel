import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '@/shared/utils';

type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Orange index before the label, e.g. "01". */
  index?: string;
  /** Pressed/selected filter chip. */
  active?: boolean;
  children: ReactNode;
};

/** Used by filters and quick links of the Kabina layer: the 32px mono chip («01 Тосты»). */
export function Chip({ index, active, className, children, type = 'button', ...rest }: ChipProps) {
  return (
    <button type={type} className={cn('kb-chip kb-m', className)} aria-pressed={active} {...rest}>
      {index && <span className="kb-chip-n">{index}</span>}
      {children}
    </button>
  );
}

/** Used by the shell search field, overlays and hints: a mono keycap («⌘K», «Esc», «⌥ Пробел»). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('kb-m kb-kbd', className)}>{children}</kbd>;
}
