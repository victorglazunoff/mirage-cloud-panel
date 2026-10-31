import { useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

import { HudPopover, useClaimKabinaCrumbs, useKabinaHeaderSlot } from '@/modules/kabina';
import { CalIcon, ChatTabIcon, ChevronDown, FolderIcon, TerminalIcon } from '@/modules/kabina-chat/ChatIcons';
import type { AppTab } from '@/shared/types';

/**
 * The project tabs, in ChatLayoutB's order; «Календарь» leads to the calendar screen. Git is
 * left out of the navigation — the authors' Git screen stays in the code and
 * still opens from «/diff».
 */
const PROJECT_TABS: Array<{ id: AppTab | 'calendar'; label: string; Icon: (props: { size?: number }) => JSX.Element }> = [
  { id: 'chat', label: 'Чат', Icon: ChatTabIcon },
  { id: 'files', label: 'Файлы', Icon: FolderIcon },
  { id: 'shell', label: 'Терминал', Icon: TerminalIcon },
  { id: 'calendar', label: 'Календарь', Icon: CalIcon },
];

type ChatHeaderBarProps = {
  projectName: string;
  title: string;
  activeTab: AppTab;
  onTab: (tab: AppTab) => void;
  /** The navigator (ChatNavigator) shown under the crumbs. */
  dialogs: ReactNode;
  /** Which crumb opened the navigator: the project (all projects, this one unfolded) or the dialog. */
  openFrom: 'project' | 'dialog' | null;
  onOpenFrom: (from: 'project' | 'dialog') => void;
  onCloseDialogs: () => void;
};

/**
 * Rendered by the kabina-chat screen into the shell header's slot (ChatLayoutB's one-row
 * header): «// Проект // <диалог ⌄>» — both crumbs open the navigator
 * (the project on «Все проекты» with this project unfolded, the dialog on «Этот проект») —
 * and the project tabs. The shell drops its own static crumb while this is mounted.
 * Nothing outside the shell (tests, the classic interface).
 */
export default function ChatHeaderBar({ projectName, title, activeTab, onTab, dialogs, openFrom, onOpenFrom, onCloseDialogs }: ChatHeaderBarProps) {
  const slot = useKabinaHeaderSlot();
  const crumbsRef = useRef<HTMLDivElement>(null);
  useClaimKabinaCrumbs();
  if (!slot) return null;
  const toggle = (from: 'project' | 'dialog') => (openFrom === from ? onCloseDialogs() : onOpenFrom(from));

  return createPortal(
    <>
      <div ref={crumbsRef} className="kbc-hcrumbs">
        <span className="kb-m kb-crumb-sep" aria-hidden="true">//</span>
        <button
          type="button"
          className="kbc-hcrumb"
          aria-haspopup="dialog"
          aria-expanded={openFrom === 'project'}
          title={`${projectName} — другие проекты и их диалоги`}
          onClick={() => toggle('project')}
        >
          <span className="kbc-htitle-text">{projectName}</span>
        </button>
        <span className="kb-m kb-crumb-sep" aria-hidden="true">//</span>
        <div className="kbc-htitle-wrap">
          <button
            type="button"
            className="kbc-htitle"
            aria-haspopup="dialog"
            aria-expanded={openFrom === 'dialog'}
            title={`${title} — другие диалоги`}
            onClick={() => toggle('dialog')}
          >
            <span className="kbc-htitle-text">{title}</span>
            <ChevronDown size={12} className="kbc-chev" />
          </button>
        </div>
        <HudPopover
          open={openFrom !== null}
          onClose={onCloseDialogs}
          anchorRef={crumbsRef}
          align="left"
          direction="down"
          label={openFrom === 'project' ? 'Проекты и диалоги' : 'Диалоги проекта'}
          className="kbc-dlg-pop kbn-pop"
        >
          {dialogs}
        </HudPopover>
      </div>
      <span className="kb-spacer" />
      <nav className="kbc-htabs" aria-label="Разделы проекта">
        {PROJECT_TABS.map(({ id, label, Icon }) => (
          id === 'calendar' ? (
            <Link key={id} className="kbc-htab" to="/calendar" title={label}>
              <Icon size={14} />
              <span className="kbc-htab-label">{label}</span>
            </Link>
          ) : (
            <button
              key={id}
              type="button"
              className="kbc-htab"
              aria-current={activeTab === id ? 'page' : undefined}
              title={label}
              onClick={() => onTab(id)}
            >
              <Icon size={14} />
              <span className="kbc-htab-label">{label}</span>
            </button>
          )
        ))}
      </nav>
    </>,
    slot,
  );
}
