import { TypeIcon } from '@/modules/kabina-calendar/CalendarIcons';
import { TYPE_LABELS, TYPE_ORDER } from '@/modules/kabina-calendar/utils/calendarModel';
import type { CalendarEventType } from '@/shared/types';

type CalendarFiltersProps = {
  hiddenTypes: ReadonlySet<CalendarEventType>;
  typeCounts: Record<CalendarEventType, number>;
  projects: Array<{ id: string; name: string }>;
  /** `all`, `none` (events without a project) or a project id. */
  project: string;
  onToggleType: (type: CalendarEventType) => void;
  onProject: (project: string) => void;
};

/** DarkCalendar's filter toolbar: type chips (with counts) and one project at a time. */
export default function CalendarFilters({ hiddenTypes, typeCounts, projects, project, onToggleType, onProject }: CalendarFiltersProps) {
  return (
    <div className="kc-filters kb-rise kb-d2" role="toolbar" aria-label="Фильтры">
      <span className="kb-m kc-filter-label">ТИП</span>
      {TYPE_ORDER.map((type) => {
        const on = !hiddenTypes.has(type);
        return (
          <button
            key={type}
            type="button"
            className="kc-chip"
            data-kind="type"
            data-dashed={type === 'server_schedule' ? '' : undefined}
            aria-pressed={on}
            onClick={() => onToggleType(type)}
          >
            <span className="kc-chip-icon"><TypeIcon type={type} size={14} /></span>
            <span>{TYPE_LABELS[type].many}</span>
            <span className="kb-m kc-chip-count">{typeCounts[type]}</span>
          </button>
        );
      })}
      <span className="kc-filter-sep" aria-hidden="true" />
      <span className="kb-m kc-filter-label">ПРОЕКТ</span>
      {[{ id: 'all', name: 'Все' }, ...projects].map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="kc-chip"
          aria-pressed={project === entry.id}
          onClick={() => onProject(entry.id)}
        >
          {entry.name}
        </button>
      ))}
    </div>
  );
}
