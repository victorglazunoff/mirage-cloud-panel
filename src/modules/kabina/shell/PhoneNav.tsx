import { Link } from 'react-router-dom';

import { AgentsIcon, CalendarIcon, DialIcon, GridIcon } from '@/modules/kabina/ui/KabinaIcons';

/** The four phone sections of DarkPhoneMain. */
type PhoneSection = 'home' | 'projects' | 'agents' | 'calendar';

const ITEMS: Array<{ key: PhoneSection; to: string; label: string; Icon: typeof DialIcon }> = [
  { key: 'home', to: '/', label: 'Главная', Icon: DialIcon },
  { key: 'projects', to: '/projects', label: 'Проекты', Icon: GridIcon },
  { key: 'agents', to: '/agents', label: 'Агенты', Icon: AgentsIcon },
  { key: 'calendar', to: '/calendar', label: 'Календарь', Icon: CalendarIcon },
];

type PhoneNavProps = {
  current: PhoneSection | null;
  /** Running agents, shown as the orange badge on «Агенты». */
  agentsBadge?: number;
};

/** Rendered by KabinaShell on the phone: the bottom bar Главная / Проекты / Агенты / Календарь with the glowing current marker. */
export default function PhoneNav({ current, agentsBadge = 0 }: PhoneNavProps) {
  return (
    <nav className="kb-phonenav kb-root" aria-label="Разделы">
      {ITEMS.map(({ key, to, label, Icon }) => (
        <Link key={key} className="kb-nav" to={to} aria-current={current === key ? 'page' : undefined}>
          <span className="kb-nav-bar" aria-hidden="true" />
          <Icon />
          <span className="kb-nav-label">{label}</span>
          {key === 'agents' && agentsBadge > 0 && (
            <span className="kb-m kb-nav-badge" aria-label={`в работе: ${agentsBadge}`}>{agentsBadge}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}
