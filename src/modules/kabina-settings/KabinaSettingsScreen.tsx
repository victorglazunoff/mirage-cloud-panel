import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import '@/modules/kabina-settings/kabinaSettings.css';
import { lockPageScroll, Skeleton, toPanelWall, usePanelTimeZone } from '@/modules/kabina';
import { usePlugins } from '@/modules/plugins';
import { APP_VERSION } from '@/shared/constants';
import { voiceHotkeyLabel } from '@/shared/utils';
import { useAccountSecurity } from '@/modules/kabina-settings/hooks/useAccountSecurity';
import { useMirageSettings } from '@/modules/kabina-settings/hooks/useMirageSettings';
import AccountSection from '@/modules/kabina-settings/sections/AccountSection';
import ClaudeSection from '@/modules/kabina-settings/sections/ClaudeSection';
import HomeSection from '@/modules/kabina-settings/sections/HomeSection';
import MoreSection from '@/modules/kabina-settings/sections/MoreSection';
import NotifySection from '@/modules/kabina-settings/sections/NotifySection';
import PluginsSection from '@/modules/kabina-settings/sections/PluginsSection';
import ThemeSection from '@/modules/kabina-settings/sections/ThemeSection';
import VoiceSection from '@/modules/kabina-settings/sections/VoiceSection';

type SectionId = 'claude' | 'voice' | 'home' | 'notify' | 'account' | 'plugins' | 'theme' | 'more';

const SECTIONS: Array<{ id: SectionId; name: string; title: string; desc: string }> = [
  { id: 'claude', name: 'Claude', title: 'Claude', desc: 'Как Claude работает по умолчанию: права, модель, фоновые задачи и что делать с сообщением посреди хода.' },
  { id: 'voice', name: 'Голос', title: 'Голос', desc: 'Говоришь вместо того, чтобы печатать. Клавиша, язык и где распознавать.' },
  { id: 'home', name: 'Главный экран', title: 'Главный экран', desc: 'Что показывать на командном пункте и в каком порядке.' },
  { id: 'notify', name: 'Уведомления', title: 'Уведомления', desc: 'Куда и когда писать, если ты не смотришь в панель.' },
  { id: 'account', name: 'Аккаунт', title: 'Аккаунт', desc: 'Как тебя называть, пароль, второй фактор и где ты сейчас вошёл.' },
  { id: 'plugins', name: 'Плагины', title: 'Плагины', desc: 'Свои вкладки и виджеты. Включаются без перезапуска панели.' },
  { id: 'theme', name: 'Тема', title: 'Тема', desc: 'Как выглядит панель.' },
  { id: 'more', name: 'Ещё', title: 'Ещё', desc: 'MCP, провайдеры, git-учётка и остальное из классических настроек.' },
];

/** Old section names (the authors' tabs, ПЛАН-КАБИНА links) that land on a Kabina section. */
const SECTION_ALIASES: Record<string, SectionId> = {
  notifications: 'notify',
  appearance: 'theme',
  security: 'account',
  password: 'account',
  '2fa': 'account',
};

/**
 * Used by project-workspace for the header trail «Настройки // Голос»: the section an address
 * opens (aliases resolved, the first section when none is named).
 */
export function describeSettingsSection(section: string | null): { id: string; name: string } {
  const requested = section ? SECTION_ALIASES[section] ?? section : 'claude';
  const entry = SECTIONS.find((candidate) => candidate.id === requested) ?? SECTIONS[0];
  return { id: entry.id, name: entry.name };
}

const CLASSIC_TABS = new Set(['agents', 'git', 'api', 'tasks', 'browser', 'about']);

function SectionIcon({ id }: { id: SectionId }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const;
  switch (id) {
    case 'claude':
      return <svg {...common} strokeLinecap="round"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" /></svg>;
    case 'voice':
      return <svg {...common}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
    case 'home':
      return <svg {...common}><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" /><rect x="13.5" y="13.5" width="7" height="7" rx="1" /></svg>;
    case 'notify':
      return <svg {...common} strokeLinejoin="round"><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg>;
    case 'account':
      return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
    case 'plugins':
      return <svg {...common} strokeLinecap="round"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" /></svg>;
    case 'theme':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" fillOpacity="0.35" /></svg>;
    default:
      return <svg {...common} strokeLinecap="round"><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></svg>;
  }
}

const pad2 = (value: number) => String(value).padStart(2, '0');

function clockOf(iso: string | null): string | null {
  if (!iso) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  const date = toPanelWall(instant);
  return Number.isNaN(date.getTime()) ? null : `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

type KabinaSettingsScreenProps = {
  /** `/settings/:section?` */
  section: string | null;
  /** The authors' settings dialog on a tab, for «Ещё» and plugin configuration; null when closed. */
  renderClassic: (tab: string, onClose: () => void) => ReactNode;
};

/**
 * Used by the project-workspace module for `/settings/:section?`: the «Кабина»
 * settings screen — section list with
 * live summaries on the left, the open section on the right, every change saved
 * on the spot with a quiet «СОХРАНЕНО · время» mark.
 */
export default function KabinaSettingsScreen({ section, renderClassic }: KabinaSettingsScreenProps) {
  usePanelTimeZone();
  const navigate = useNavigate();
  const { view, loadError, saveState, saveError, update } = useMirageSettings();
  const account = useAccountSecurity();
  const { plugins } = usePlugins();
  // The authors' dialog opened from «Ещё» / «Настроить», on this tab.
  const [classicTab, setClassicTab] = useState<string | null>(null);
  // The settings page under the classic dialog neither scrolls nor jumps (the dialog is the authors').
  const isClassicOpen = classicTab !== null;
  useEffect(() => (isClassicOpen ? lockPageScroll() : undefined), [isClassicOpen]);

  const requested = section ? SECTION_ALIASES[section] ?? section : 'claude';
  const routed: SectionId = SECTIONS.some((entry) => entry.id === requested) ? (requested as SectionId) : 'claude';
  // The section just clicked: the menu and the content follow the click at once, not the route's re-render.
  const [clicked, setClicked] = useState<SectionId | null>(null);
  const current: SectionId = clicked ?? routed;
  useEffect(() => setClicked(null), [routed]);
  // The first section rises in with the page; switching shows the next one at once (no 0.3–0.6 s blank).
  const firstSectionRef = useRef<SectionId>(current);
  const [switched, setSwitched] = useState(false);
  useEffect(() => {
    if (current !== firstSectionRef.current) setSwitched(true);
  }, [current]);
  const navRef = useRef<HTMLElement>(null);

  // Phone strip: the active section scrolls into view (the strip is wider than the screen).
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    const target = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, target), behavior: switched ? 'smooth' : 'auto' });
  }, [current, switched]);

  // An authors' tab in the address (an old link) opens that dialog over «Ещё».
  useEffect(() => {
    if (section && CLASSIC_TABS.has(section)) {
      setClassicTab(section);
      navigate('/settings/more', { replace: true });
    }
  }, [navigate, section]);

  const head = SECTIONS.find((entry) => entry.id === current)!;
  const headIndex = SECTIONS.indexOf(head) + 1;
  const settings = view?.settings ?? null;

  const metas: Record<SectionId, string> = settings
    ? {
      claude: `${({ default: 'Default', auto: 'Auto', plan: 'Plan', acceptEdits: 'Принимать правки' } as const)[settings.claude.permissionMode]} · ${settings.claude.model.replace(/^./, (letter) => letter.toUpperCase())} · ${settings.claude.effort}`,
      voice: `${voiceHotkeyLabel(settings.voice.hotkey)} · ${settings.voice.engine === 'yandex' ? 'SpeechKit' : 'Whisper'}`,
      home: `${settings.home.widgets.filter((widget) => widget.enabled).length} из ${settings.home.widgets.length} виджетов`,
      notify: (() => {
        const names = [
          settings.notifications.channels.telegram ? 'Telegram' : null,
          settings.notifications.channels.max ? 'MAX' : null,
          settings.notifications.channels.browser ? 'браузер' : null,
        ].filter(Boolean);
        const events = Object.values(settings.notifications.events).filter(Boolean).length;
        return `${names.length ? names.join(', ') : 'никуда'} · ${events} соб.`;
      })(),
      account: account.sessions
        ? `${account.sessions.length} ${account.sessions.length === 1 ? 'вход' : account.sessions.length < 5 ? 'входа' : 'входов'} · 2FA ${account.twoFactor?.enabled ? 'вкл' : 'выкл'}`
        : '…',
      plugins: `${plugins.filter((plugin) => plugin.enabled).length} из ${plugins.length} включены`,
      theme: `${settings.appearance.theme === 'light' ? 'Светлая (скоро)' : 'Кабина'} · ${settings.appearance.density === 'compact' ? 'компактная' : 'обычная'}`,
      more: 'MCP, git · классика',
    }
    : { claude: '…', voice: '…', home: '…', notify: '…', account: '…', plugins: '…', theme: '…', more: 'MCP, git · классика' };

  const savedClock = clockOf(view?.savedAt ?? null);
  const savedText = saveState === 'error'
    ? 'НЕ СОХРАНЕНО'
    : saveState === 'saving'
      ? 'СОХРАНЯЮ…'
      : saveState === 'fresh'
        ? 'СОХРАНЕНО · ТОЛЬКО ЧТО'
        : savedClock ? `СОХРАНЕНО · ${savedClock}` : 'СОХРАНЯЕТСЯ САМО';
  // The server runs as root — Claude Code refuses Bypass then. Locked until the server answered.
  const runsAsRoot = view?.server ? view.server.isRoot : true;

  let content: ReactNode;
  if (current === 'account') {
    content = (
      <AccountSection
        twoFactor={account.twoFactor}
        sessions={account.sessions}
        devices={account.devices}
        refresh={account.refresh}
        displayName={settings ? settings.profile?.displayName ?? '' : null}
        onDisplayNameChange={(displayName) => update({ profile: { displayName } })}
      />
    );
  } else if (current === 'plugins') {
    content = <PluginsSection onConfigure={() => setClassicTab('plugins')} />;
  } else if (current === 'more') {
    content = <MoreSection onOpenClassic={setClassicTab} />;
  } else if (loadError) {
    content = <div role="alert" className="kb-alert"><span className="kb-alert-title">Настройки не загрузились: {loadError}</span></div>;
  } else if (!settings) {
    content = (
      <div className="kb-set-group" aria-busy="true">
        <Skeleton height={180} />
        <Skeleton height={140} />
      </div>
    );
  } else if (current === 'claude') {
    content = <ClaudeSection settings={settings.claude} update={update} runsAsRoot={runsAsRoot} />;
  } else if (current === 'voice') {
    content = <VoiceSection settings={settings.voice} update={update} />;
  } else if (current === 'home') {
    content = <HomeSection settings={settings.home} update={update} />;
  } else if (current === 'notify') {
    content = <NotifySection settings={settings.notifications} update={update} />;
  } else {
    content = <ThemeSection settings={settings.appearance} update={update} />;
  }

  return (
    <div className="kb-set" data-switched={switched ? '' : undefined}>
      <aside className="kb-rise kb-set-aside" aria-label="Разделы настроек">
        <div className="kb-set-navcap">
          <h2 className="kb-m kb-ruler-title">РАЗДЕЛЫ</h2>
          <span className="kb-ruler-scale" data-minor="" aria-hidden="true" />
          <span className="kb-m" style={{ fontSize: 10.5, color: '#948C7E' }}>{pad2(SECTIONS.length)}</span>
        </div>
        <nav className="kb-set-nav" aria-label="Разделы" ref={navRef}>
          {SECTIONS.map((entry, index) => {
            const on = entry.id === current;
            return (
              <button
                key={entry.id}
                type="button"
                className={`kb-set-navitem${on ? ' kb-bz' : ''}`}
                aria-current={on ? 'page' : undefined}
                onClick={() => {
                  if (entry.id === current) return;
                  setClicked(entry.id);
                  navigate(`/settings/${entry.id}`);
                }}
              >
                <span className="kb-m kb-set-navnum" aria-hidden="true">{pad2(index + 1)}</span>
                <span className="kb-set-navicon" aria-hidden="true"><SectionIcon id={entry.id} /></span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span className="kb-set-navname">{entry.name}</span>
                  <span className="kb-m kb-set-navmeta">{metas[entry.id]}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="kb-m kb-set-navfoot">
          <span>MIRAGE {APP_VERSION ? `v${APP_VERSION}` : ''}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className="kb-led kb-led-ok" style={{ width: 6, height: 6, boxShadow: 'none' }} />
            всё сохраняется само
          </span>
        </div>
      </aside>

      <main className="kb-set-main">
        <div className="kb-rise kb-set-head">
          <div style={{ flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span className="kb-m" style={{ fontSize: 10, letterSpacing: '0.22em', color: '#948C7E' }}>
              <span style={{ color: '#FF6A2B' }}>{pad2(headIndex)}</span> / НАСТРОЙКИ
            </span>
            <h1 className="kb-t kb-set-title">{head.title}</h1>
            <p className="kb-set-lead">{head.desc}</p>
          </div>
          <button
            type="button"
            role="status"
            aria-live="polite"
            className={`kb-m kb-set-saved${saveState === 'fresh' ? ' kb-fadein' : ''}`}
            data-state={saveState}
            title={saveState === 'error' ? saveError ?? undefined : undefined}
            onClick={saveState === 'error' ? () => window.location.reload() : undefined}
            tabIndex={saveState === 'error' ? 0 : -1}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={saveState === 'error' ? '#FF8A55' : '#9CC49A'} strokeWidth="2.2" aria-hidden="true">
              {saveState === 'error' ? <path d="M12 7v6M12 17v.5" /> : <path d="M5 12l5 5 9-10" />}
            </svg>
            {savedText}
          </button>
        </div>
        {saveState === 'error' && saveError && (
          <span role="alert" style={{ marginTop: -18, fontSize: 13, color: '#FF8A55' }}>{saveError}</span>
        )}

        {content}
      </main>

      {classicTab && <div className="kb-set-classic">{renderClassic(classicTab, () => setClassicTab(null))}</div>}
    </div>
  );
}
