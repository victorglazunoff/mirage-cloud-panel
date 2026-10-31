import type { ReactNode } from 'react';

type SectionRulerProps = {
  /** Heading id, referenced by the section's aria-labelledby. */
  id: string;
  /** Two-digit section number, "01". */
  index: string;
  title: string;
  /** Right-hand slot: a counter, a link or a button. */
  children?: ReactNode;
  /** `major` — long ticks every 48px over 8px minor ones; `minor` — only fine ticks (calendar); `none` — a plain spacer (limits). */
  scale?: 'major' | 'minor' | 'none';
  /** Phone variant: 44px row and 14px link text. */
  touch?: boolean;
};

/** Used by the home screen and every Kabina screen: the "01 / НАЗВАНИЕ" title with the instrument scale. */
export function SectionRuler({ id, index, title, children, scale = 'major', touch = false }: SectionRulerProps) {
  return (
    <div className="kb-heading" data-touch={touch ? '' : undefined}>
      <span className="kb-m kb-ruler-n" aria-hidden="true">{index}</span>
      <h2 id={id} className="kb-m kb-ruler-title">{title}</h2>
      {scale === 'none'
        ? <div className="kb-spacer" />
        : <span className="kb-ruler-scale" data-minor={scale === 'minor' ? '' : undefined} aria-hidden="true" />}
      {children}
    </div>
  );
}
