import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

type SegmentedOption<T extends string> = { value: T; label: string };

type SegmentedProps<T extends string> = {
  ariaLabel: string;
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** `sm` — the 28px inline switcher (DarkStates), `md` — the 38px settings control. */
  size?: 'sm' | 'md';
  /** Mono caption and a fixed minimum width per segment (DarkSettings «Effort»: low … max). */
  mono?: boolean;
  /** Minimum segment width in px, so short labels line up (Opus / Sonnet / Haiku). */
  minItemWidth?: number;
  /** Extra control inside the same frame after the options (DarkSettings: the locked «Bypass»). */
  trailing?: ReactNode;
};

/** Used by settings-like controls across the Kabina layer (kabina-settings, states): a radiogroup of segments with arrow-key movement. */
export function Segmented<T extends string>({ ariaLabel, options, value, onChange, size = 'md', mono = false, minItemWidth, trailing }: SegmentedProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[options.indexOf(next)]?.focus();
  };

  return (
    <div ref={groupRef} className="kb-segmented" role="radiogroup" aria-label={ariaLabel} data-size={size === 'md' ? undefined : size}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            className={mono ? 'kb-seg kb-m' : 'kb-seg'}
            style={mono || minItemWidth ? { minWidth: minItemWidth, ...(mono ? { fontSize: 12, padding: '0 10px' } : {}) } : undefined}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={handleKeyDown}
          >
            {option.label}
          </button>
        );
      })}
      {trailing}
    </div>
  );
}
