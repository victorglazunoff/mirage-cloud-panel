import type { ReactNode } from 'react';

import { Panel } from '@/modules/kabina/ui/Panel';
import { SectionRuler } from '@/modules/kabina/ui/SectionRuler';

type KabinaSoonScreenProps = {
  /** Mono eyebrow, e.g. "АГЕНТЫ". */
  code: string;
  title: string;
  lead: string;
  /** What the finished screen will do — the mock-up's promises, one per line. */
  plans: string[];
  /** Where the same job can be done today in the classic interface. */
  classicHint?: string;
  /** Optional working part shown above the plan (e.g. a plain project list). */
  children?: ReactNode;
};

/** Rendered by KabinaApp for screens of later waves: a calm «скоро» page in the Kabina style with a way to the classic interface. */
export default function KabinaSoonScreen({ code, title, lead, plans, classicHint, children }: KabinaSoonScreenProps) {
  const headingId = `kb-soon-${code.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-')}`;
  return (
    <div className="kb-soon">
      <section className="kb-rise" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-labelledby={`${headingId}-h`}>
        <span className="kb-m kb-soon-eyebrow">{code} · СКОРО</span>
        <h1 id={`${headingId}-h`} className="kb-t kb-soon-title">{title}</h1>
        <p className="kb-soon-lead">{lead}</p>
      </section>

      {children}

      <Panel as="section" className="kb-rise kb-d2" aria-labelledby={`${headingId}-plan`} style={{ padding: '18px 18px 16px', gap: 14 }}>
        <SectionRuler id={`${headingId}-plan`} index="01" title="ЧТО ЗДЕСЬ БУДЕТ" scale="minor" />
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {plans.map((plan) => (
            <li key={plan} style={{ display: 'flex', alignItems: 'baseline', gap: 12, fontSize: 14, lineHeight: 1.5, color: 'var(--kb-soft)' }}>
              <span aria-hidden="true" className="kb-led kb-led-idle" style={{ transform: 'translateY(-1px)' }} />
              <span className="kb-pretty">{plan}</span>
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px', paddingTop: 12, borderTop: '1px solid var(--kb-line-soft)' }}>
          <a className="kb-btn kb-ghost" href="/classic">Открыть классический интерфейс</a>
          {classicHint && <span className="kb-pretty" style={{ fontSize: 12.5, color: 'var(--kb-mute)' }}>{classicHint}</span>}
        </div>
      </Panel>
    </div>
  );
}
