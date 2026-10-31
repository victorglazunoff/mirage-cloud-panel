import type { VoiceCardView } from '@/modules/kabina-voice/utils/voiceActionPlan';

type VoiceCardsProps = {
  cards: VoiceCardView[];
  unchecked: Set<string>;
  onToggle: (id: string) => void;
  variant: 'desktop' | 'phone';
  /** Disables toggling while «Выполнить» runs or after it finished. */
  locked?: boolean;
};

function CheckBox() {
  return (
    <span className="kb-vo-box" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    </span>
  );
}

function CalendarGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function TaskGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
    </svg>
  );
}

function MessageGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M4 5h16v11H8l-4 4z" />
    </svg>
  );
}

function MirageGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="11" stroke="currentColor" strokeWidth="2.2" />
      <path d="M2 15h22" stroke="currentColor" strokeWidth="2.4" />
    </svg>
  );
}

/**
 * Used by both voice layouts for «Что сделаю»: one checkbox card per parsed action
 * (calendar event, task for Claude, message). Cards that cannot run as is (no time,
 * no addressee) are shown unticked and locked, with the reason in sand.
 */
export function VoiceCards({ cards, unchecked, onToggle, variant, locked = false }: VoiceCardsProps) {
  if (variant === 'phone') {
    return (
      <>
        {cards.map((card, index) => {
          const checked = card.runnable && !unchecked.has(card.id);
          const disabled = locked || !card.runnable;
          return (
            <button
              key={card.id}
              className={`kb-vo-ph-card kb-bz kb-rise kb-d${Math.min(index + 1, 5)}`}
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-disabled={disabled}
              onClick={() => {
                if (!disabled) onToggle(card.id);
              }}
            >
              <CheckBox />
              <span className="kb-vo-ph-card-main">
                <span className="kb-m kb-vo-kicker" style={{ letterSpacing: '0.16em' }}>{card.kicker}</span>
                <span className="kb-vo-ph-card-title">{card.title}</span>
                {card.meta && <span className="kb-vo-ph-card-meta" style={card.runnable ? undefined : { color: 'var(--kb-sand)' }}>{card.meta}</span>}
                <span className="kb-m kb-vo-ph-chip">
                  {card.kind === 'calendar_event' ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <rect x="3" y="5" width="18" height="16" rx="2" />
                      <path d="M3 10h18M8 3v4M16 3v4" />
                    </svg>
                  ) : <MirageGlyph />}
                  {card.whenChip}
                </span>
              </span>
            </button>
          );
        })}
      </>
    );
  }

  return (
    <div className="kb-vo-cards" role="group" aria-label="Что сделаю">
      {cards.map((card, index) => {
        const checked = card.runnable && !unchecked.has(card.id);
        const disabled = locked || !card.runnable;
        return (
          <button
            key={card.id}
            className={`kb-vo-card kb-bz kb-rise kb-d${Math.min(index + 2, 5)}`}
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled) onToggle(card.id);
            }}
          >
            <CheckBox />
            <span className="kb-vo-card-ic" aria-hidden="true">
              {card.kind === 'calendar_event' ? <CalendarGlyph size={18} /> : card.kind === 'project_task' ? <TaskGlyph /> : <MessageGlyph />}
            </span>
            <span className="kb-vo-card-main">
              <span className="kb-m kb-vo-kicker">{card.kicker}</span>
              <span className="kb-vo-card-title">{card.title}</span>
              {card.meta && <span className="kb-vo-card-meta" data-warn={card.runnable ? undefined : ''}>{card.meta}</span>}
            </span>
            <span className="kb-vo-when">
              <span className="kb-t kb-vo-when-big">{card.whenBig}</span>
              <span className="kb-m kb-vo-when-small">{card.whenSmall}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
