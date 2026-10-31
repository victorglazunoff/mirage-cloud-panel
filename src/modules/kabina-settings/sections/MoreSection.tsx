import { Link } from 'react-router-dom';

import { SettingsBlock } from '@/modules/kabina-settings/SettingsParts';

type MoreSectionProps = {
  /** Opens the authors' settings dialog on the given tab over the Kabina screen. */
  onOpenClassic: (tab: string) => void;
};

/** The authors' settings tabs the Kabina mock-up has no place for. */
const CLASSIC_TABS = [
  { tab: 'agents', name: 'Агенты и провайдеры', desc: 'Claude, Codex, Gemini: вход в аккаунт, MCP-серверы, разрешения инструментов.' },
  { tab: 'git', name: 'Git', desc: 'Имя и почта для коммитов, учётка для push.' },
  { tab: 'api', name: 'API-ключи и учётки', desc: 'Ключи доступа к панели по API, сохранённые токены сервисов.' },
  { tab: 'tasks', name: 'Задачи (TaskMaster)', desc: 'Подключение TaskMaster и его настройки.' },
  { tab: 'browser', name: 'Браузер для агента', desc: 'Встроенный браузер, которым Claude управляет сам.' },
  { tab: 'notifications', name: 'Звуки и пуш (классика)', desc: 'Старые настройки уведомлений браузера и звуков.' },
  { tab: 'about', name: 'О панели', desc: 'Версия, обновления, ссылки на исходный код (AGPL-3.0).' },
];

/**
 * «08 Ещё»: everything the authors' settings can do that the Kabina mock-up
 * does not cover (MCP, providers, git account…), opened as the classic dialog.
 * Rendered by KabinaSettingsScreen.
 */
export default function MoreSection({ onOpenClassic }: MoreSectionProps) {
  return (
    <div className="kb-set-group">
      <SettingsBlock id="h-more" index="08.1" title="КЛАССИЧЕСКИЕ НАСТРОЙКИ" major delay={1}>
        <span className="kb-set-hint">Открываются поверх Кабины тем же окном, что в классическом интерфейсе. Ничего не теряется.</span>
        <div className="kb-set-plate" data-clip="">
          {CLASSIC_TABS.map((entry) => (
            <div key={entry.tab} className="kb-set-row" data-hover="" data-tight="">
              <div className="kb-set-text">
                <span className="kb-set-name">{entry.name}</span>
                <span className="kb-set-desc">{entry.desc}</span>
              </div>
              <button type="button" className="kb-btn kb-ghost" onClick={() => onOpenClassic(entry.tab)}>Открыть</button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px' }}>
          <Link className="kb-btn kb-ghost" to="/classic" style={{ minHeight: 44, padding: '0 16px', fontSize: 14, borderRadius: 6 }}>
            Весь классический интерфейс
          </Link>
          <span style={{ fontSize: 13, color: '#948C7E' }}>Запасной путь, пока все экраны не перенесены в Кабину.</span>
        </div>
      </SettingsBlock>
    </div>
  );
}
