import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import '@/modules/kabina/kabina.css';
import { KabinaToastProvider } from '@/modules/kabina/context/KabinaToastContext';
import KabinaShell from '@/modules/kabina/shell/KabinaShell';
import KabinaSoonScreen from '@/modules/kabina/shell/KabinaSoonScreen';
import KabinaStatesShowcase from '@/modules/kabina/showcase/KabinaStatesShowcase';
import { useLimitWarningToasts } from '@/modules/kabina/hooks/useLimitWarningToasts';
import { matchKabinaRoute } from '@/modules/kabina/utils/kabinaRoutes';
import type { KabinaCrumb, KabinaProjectRef, KabinaVoiceSlot } from '@/shared/types';

type KabinaAppProps = {
  isPhone: boolean;
  projects: KabinaProjectRef[];
  /**
   * The open chat: project for the trail while the chat loads (then the chat draws its own
   * clickable crumbs) and project · dialog for «Вернуться в …» from Files / Settings.
   */
  chatTitle: { projectName: string | null; sessionTitle: string | null; dialogTitle?: string | null };
  /** A settings section of the address (aliases resolved) for the trail «Настройки // Голос». */
  describeSettingsSection?: (section: string | null) => { id: string; name: string } | null;
  renderHome: () => ReactNode;
  renderChat: () => ReactNode;
  /** The «Агенты» screen (DarkAgents) for `/agents`. */
  renderAgents: () => ReactNode;
  /** «Все проекты» (DarkProjects, module kabina-projects). */
  renderProjects: () => ReactNode;
  /** «Файлы» (DarkFiles, module kabina-files) for `/files?project=`. */
  renderFiles: (projectId: string | null) => ReactNode;
  /** The settings screen for `/settings/:section?` (DarkSettings, module kabina-settings). */
  renderSettings: (section: string | null) => ReactNode;
  /** The ⌘K overlay (DarkSearch, module kabina-search), rendered while the address has `?search`. */
  renderSearch: (onClose: () => void) => ReactNode;
  /** The voice overlay for `?voice` (kabina-voice, mounted by project-workspace). */
  renderVoice?: (slot: KabinaVoiceSlot) => ReactNode;
  /** `/calendar` (DarkCalendar, module kabina-calendar). */
  renderCalendar?: () => ReactNode;
};

/** Raises the limits warnings (DarkStates 04) as one-time toasts; renders nothing. */
function LimitWarningToasts() {
  useLimitWarningToasts();
  return null;
}

/**
 * Used by the project-workspace module as the whole «Кабина» interface: picks
 * the screen from the URL and frames it in KabinaShell. Screens of later waves
 * render a «скоро» page; the chat is the kabina-chat screen (DarkChat).
 */
export default function KabinaApp({ isPhone, projects, chatTitle, describeSettingsSection, renderHome, renderChat, renderAgents, renderProjects, renderFiles, renderSettings, renderSearch, renderVoice, renderCalendar }: KabinaAppProps) {
  const location = useLocation();
  const route = matchKabinaRoute(location.pathname, location.search);

  if (route.screen === 'unknown') {
    return <Navigate to="/" replace />;
  }

  let content: ReactNode;
  let layout: 'page' | 'app' = 'page';
  let phoneSection: 'home' | 'projects' | 'agents' | 'calendar' | null = null;
  let headerCurrent: 'files' | 'settings' | 'home' | null = null;
  let crumbs: KabinaCrumb[] | undefined;
  // How Files / Settings name this screen in «Вернуться в …».
  let returnLabel = 'главный';
  let searchPlaceholder: string | undefined;
  let filesProjectId: string | null = null;
  let activeSessionId: string | null = null;
  let bare = false;
  let activeProjectId: string | null = null;
  let headerSlot = false;

  switch (route.screen) {
    case 'home':
      content = renderHome();
      phoneSection = 'home';
      headerCurrent = 'home';
      break;
    case 'projects':
      content = renderProjects();
      phoneSection = 'projects';
      crumbs = [{ label: 'Все проекты', to: '/projects' }];
      returnLabel = 'Все проекты';
      break;
    case 'chat': {
      content = renderChat();
      layout = 'app';
      bare = isPhone;
      activeSessionId = route.sessionId;
      activeProjectId = route.projectId;
      filesProjectId = route.projectId;
      const projectName = chatTitle.projectName;
      // ChatLayoutB: «MIRAGE // Сайт клиента // <диалог ⌄>» — the dialog step and the project tabs
      // are the chat's own (the header slot), on the phone the chat draws the whole header.
      // While the chat opens the trail is a plain step; the mounted chat replaces it with buttons.
      crumbs = projectName ? [{ label: projectName }] : [{ label: 'Чат' }];
      returnLabel = [projectName, chatTitle.dialogTitle].filter(Boolean).join(' · ') || 'чат';
      headerSlot = true;
      searchPlaceholder = projectName ? `Найти в диалогах ${projectName}` : undefined;
      break;
    }
    case 'agents':
      phoneSection = 'agents';
      content = renderAgents();
      crumbs = [{ label: 'Агенты', to: '/agents' }];
      returnLabel = 'Агенты';
      searchPlaceholder = 'Найти агента, диалог или файл';
      break;
    case 'calendar':
      phoneSection = 'calendar';
      crumbs = [{ label: 'Календарь', to: '/calendar' }];
      returnLabel = 'Календарь';
      searchPlaceholder = 'Найти событие, человека или спросить Claude';
      content = renderCalendar ? renderCalendar() : (
        <KabinaSoonScreen
          code="КАЛЕНДАРЬ"
          title="Календарь"
          lead="Звонки, встречи, сообщения клиентам и расписания сервера на одной ленте дня. Пока ближайшие дела и отложенные сообщения — на главном экране."
          plans={[
            'Неделя и день, событие голосом: «завтра в 11 позвонить [имя]».',
            'Типы: звонок, сообщение, встреча, задача агента, расписание сервера.',
            'Напоминание в Telegram, Google Календарь — когда будет доступ.',
          ]}
        />
      );
      break;
    case 'files':
      headerCurrent = 'files';
      filesProjectId = route.projectId;
      {
        // «Файлы // Сайт клиента»: the section leads to the server's files, the project to its own.
        const project = route.projectId ? projects.find((entry) => entry.projectId === route.projectId) : null;
        crumbs = [{ label: 'Файлы', to: '/files', hint: 'Файлы всего сервера' }];
        if (route.projectId) {
          crumbs.push({
            label: project?.displayName ?? 'Проект',
            to: `/files?project=${encodeURIComponent(route.projectId)}`,
            hint: project ? `Файлы проекта ${project.displayName}` : undefined,
          });
        }
      }
      searchPlaceholder = 'Найти файл на всём сервере';
      content = renderFiles(route.projectId);
      break;
    case 'settings':
      headerCurrent = 'settings';
      {
        const section = describeSettingsSection?.(route.section) ?? null;
        crumbs = [{ label: 'Настройки', to: '/settings' }];
        if (section) crumbs.push({ label: section.name, to: `/settings/${section.id}` });
      }
      searchPlaceholder = 'Найти настройку, диалог или файл';
      content = renderSettings(route.section);
      break;
    case 'states':
      // Service page: every DarkStates component on demo data, to check them by eye.
      content = <KabinaStatesShowcase isPhone={isPhone} />;
      returnLabel = 'Состояния';
      break;
    default:
      content = null;
  }

  return (
    <KabinaToastProvider>
      <LimitWarningToasts />
      <KabinaShell
        isPhone={isPhone}
        layout={layout}
        crumbs={crumbs}
        returnLabel={returnLabel}
        searchPlaceholder={searchPlaceholder}
        filesProjectId={filesProjectId}
        headerCurrent={headerCurrent}
        phoneSection={phoneSection}
        activeSessionId={activeSessionId}
        renderSearch={renderSearch}
        bare={bare}
        activeProjectId={activeProjectId}
        headerSlot={headerSlot}
        projects={projects}
        renderVoice={renderVoice}
      >
        {content}
      </KabinaShell>
    </KabinaToastProvider>
  );
}
