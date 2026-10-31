import type { CSSProperties, ReactNode } from 'react';

import { SectionRuler, Toggle } from '@/modules/kabina';

type SettingsBlockProps = {
  id: string;
  /** «01.1» */
  index: string;
  title: string;
  /** The first block of a section carries the long ticks, the rest only the fine ones (as in the mock-up). */
  major?: boolean;
  /** Animation stagger: 1–4. */
  delay?: 1 | 2 | 3 | 4;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
};

/** Used by every kabina-settings section: the «01.1 РЕЖИМ ПРАВ» ruler and its content. */
export function SettingsBlock({ id, index, title, major = false, delay = 1, aside, children, className, style }: SettingsBlockProps) {
  return (
    <section className={`kb-rise kb-d${delay} kb-set-block ${className ?? ''}`} aria-labelledby={id} style={style}>
      <SectionRuler id={id} index={index} title={title} scale={major ? 'major' : 'minor'}>
        {aside}
      </SectionRuler>
      {children}
    </section>
  );
}

type SettingRowProps = {
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  /** Switch rows keep the control on the same line (no wrap) — DarkSettings «srow» with a switch. */
  tight?: boolean;
};

/** Used by kabina-settings sections: one «name + explanation | control» row of a plate. */
export function SettingRow({ title, desc, children, tight = false }: SettingRowProps) {
  return (
    <div className="kb-set-row" data-hover="" data-tight={tight ? '' : undefined}>
      <div className="kb-set-text">
        <span className="kb-set-name">{title}</span>
        {desc && <span className="kb-set-desc">{desc}</span>}
      </div>
      {children}
    </div>
  );
}

/** Used by kabina-settings sections: a row whose control is the ВКЛ/ВЫКЛ switch. */
export function SwitchRow({ title, desc, checked, onChange, disabled }: { title: string; desc: ReactNode; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <SettingRow title={title} desc={desc} tight>
      <Toggle checked={checked} onChange={onChange} ariaLabel={title} disabled={disabled} />
    </SettingRow>
  );
}

type RadioCardOption<T extends string> = { value: T; label: string; tag?: string; desc: string };

/** Used by kabina-settings «Сообщение во время хода» and «Движок»: big radio cards with a tag. */
export function RadioCards<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  tagTone = 'mute',
}: {
  ariaLabel: string;
  options: Array<RadioCardOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /** `mute` — a grey caption («КАК В ТЕРМИНАЛЕ»), `sand` — a framed sand chip («~0,3 с»). */
  tagTone?: 'mute' | 'sand';
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="kb-set-cards">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="kb-set-card"
          onClick={() => onChange(option.value)}
        >
          <span className="kb-set-radio" aria-hidden="true"><span /></span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14.5, fontWeight: 500 }}>{option.label}</span>
              {option.tag && (
                tagTone === 'sand'
                  ? <span className="kb-m" style={{ fontSize: 10, color: '#D9A35B', border: '1px solid rgba(217,163,91,0.4)', borderRadius: 3, padding: '1px 6px' }}>{option.tag}</span>
                  : <span className="kb-m" style={{ fontSize: 9.5, letterSpacing: '0.14em', color: '#948C7E' }}>{option.tag}</span>
              )}
            </span>
            <span className="kb-set-desc">{option.desc}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Used by kabina-settings sections: a small framed mono tag («ПО УМОЛЧАНИЮ», «ВКЛЮЧЁН», «СКОРО»). */
export function SettingsTag({ tone, children }: { tone: 'signal' | 'sage' | 'sand'; children: ReactNode }) {
  const colors = {
    signal: ['#FF8A55', 'rgba(255,106,43,0.4)'],
    sage: ['#9CC49A', 'rgba(156,196,154,0.45)'],
    sand: ['#D9A35B', 'rgba(217,163,91,0.45)'],
  } as const;
  return (
    <span className="kb-m kb-set-tag" style={{ color: colors[tone][0], borderColor: colors[tone][1] }}>
      {children}
    </span>
  );
}
