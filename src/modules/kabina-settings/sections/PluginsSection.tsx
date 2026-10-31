import { useState } from 'react';
import type { FormEvent } from 'react';

import { NO_AUTOFILL, Toggle } from '@/modules/kabina';
import { usePlugins } from '@/modules/plugins';
import { SettingsBlock } from '@/modules/kabina-settings/SettingsParts';

type PluginsSectionProps = {
  /** Opens the authors' plugin settings (config, update, remove) over the screen. */
  onConfigure: () => void;
};

/** «PR» for prism, «SM» for session-manager. */
function monogram(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

/**
 * DarkSettings 06 «Плагины»: installed plugins from the authors' plugin API —
 * name, slug and version, whether its server runs, on/off without a restart,
 * and installing a new one from a git URL. Rendered by KabinaSettingsScreen.
 */
export default function PluginsSection({ onConfigure }: PluginsSectionProps) {
  const { plugins, loading, pluginsError, togglePlugin, installPlugin } = usePlugins();
  // The «Добавить плагин» field is unfolded.
  const [adding, setAdding] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (name: string, enabled: boolean) => {
    setBusy(name);
    setError(null);
    const result = await togglePlugin(name, enabled);
    if (!result.success) setError(result.error ?? 'Не получилось переключить плагин');
    setBusy(null);
  };

  const install = async (event: FormEvent) => {
    event.preventDefault();
    if (!repoUrl.trim()) return;
    setBusy('install');
    setError(null);
    const result = await installPlugin(repoUrl.trim());
    if (result.success) {
      setRepoUrl('');
      setAdding(false);
    } else {
      setError(result.error ?? 'Не получилось установить плагин');
    }
    setBusy(null);
  };

  return (
    <div className="kb-set-group">
      <SettingsBlock
        id="h-plg"
        index="06.1"
        title={`УСТАНОВЛЕНО · ${plugins.length}`}
        major
        delay={1}
        aside={<span className="kb-m kb-ruler-meta">~/.mirage/plugins/</span>}
      >
        {(error || pluginsError) && <span role="alert" style={{ fontSize: 13, color: '#FF8A55' }}>{error ?? pluginsError}</span>}
        <div className="kb-set-plate" data-clip="">
          {plugins.map((plugin) => {
            const on = plugin.enabled;
            // A plugin with a server part that is switched on but not running needs attention.
            const warn = on && Boolean(plugin.server) && !plugin.serverRunning;
            const status = !on
              ? 'Выключен · не грузится'
              : warn
                ? 'Сервер плагина не запущен — открой «Настроить»'
                : plugin.server
                  ? 'Работает · свой процесс запущен'
                  : 'Работает';
            return (
              <div key={plugin.name} className="kb-set-row" data-hover="" style={{ gap: '10px 14px', minHeight: 96, padding: '14px 18px' }}>
                <span
                  className="kb-m kb-set-mono-badge"
                  aria-hidden="true"
                  style={{ fontSize: 11, color: on ? (warn ? '#D9A35B' : '#FF8A55') : '#948C7E', borderColor: on ? (warn ? 'rgba(217,163,91,0.45)' : 'rgba(255,106,43,0.4)') : 'rgba(255,236,210,0.12)' }}
                >
                  {monogram(plugin.name)}
                </span>
                <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 10px' }}>
                    <span style={{ fontSize: 15, fontWeight: 500, color: on ? '#EDE6DA' : '#948C7E' }}>{plugin.displayName || plugin.name}</span>
                    <span className="kb-m" style={{ fontSize: 10.5, color: '#948C7E' }}>{plugin.name} · v{plugin.version}</span>
                  </span>
                  <span className="kb-set-status" style={{ color: warn ? '#D9A35B' : on ? '#B3AA9B' : '#948C7E' }}>
                    <span className={`kb-led ${warn ? 'kb-led-warn' : on ? 'kb-led-ok' : 'kb-led-idle'}`} />
                    {status}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    type="button"
                    className="kb-btn kb-ghost"
                    onClick={onConfigure}
                    style={warn ? { color: '#D9A35B', borderColor: 'rgba(217,163,91,0.5)' } : undefined}
                  >
                    Настроить
                  </button>
                  <Toggle checked={on} showState={false} ariaLabel={plugin.displayName || plugin.name} disabled={busy === plugin.name} onChange={(next) => void toggle(plugin.name, next)} />
                </div>
              </div>
            );
          })}
          {!loading && plugins.length === 0 && (
            <div className="kb-set-row"><span className="kb-set-hint">Плагинов пока нет — добавь первый по ссылке на git-репозиторий.</span></div>
          )}
          {loading && plugins.length === 0 && <div className="kb-set-row"><span className="kb-set-hint">Загружаю плагины…</span></div>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px' }}>
          {adding ? (
            <form onSubmit={install} autoComplete="off" className="kb-fadein" style={{ flex: '1 1 100%', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <input
                {...NO_AUTOFILL}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="kb-set-field"
                type="url"
                placeholder="https://github.com/автор/плагин"
                aria-label="Ссылка на git-репозиторий плагина"
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                disabled={busy === 'install'}
                style={{ flex: '1 1 320px', minWidth: 0 }}
                autoFocus
              />
              <button type="submit" className="kb-btn kb-pri" disabled={busy === 'install'} style={{ minHeight: 44, padding: '0 18px', fontSize: 14, borderRadius: 6 }}>
                {busy === 'install' ? 'Ставлю…' : 'Установить'}
              </button>
              <button type="button" className="kb-btn kb-ghost" onClick={() => setAdding(false)} style={{ minHeight: 44, borderRadius: 6 }}>Отмена</button>
            </form>
          ) : (
            <button type="button" className="kb-btn kb-ghost" onClick={() => setAdding(true)} style={{ minHeight: 44, padding: '0 16px', fontSize: 14, borderRadius: 6, borderStyle: 'dashed', borderColor: 'rgba(255,236,210,0.22)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              Добавить плагин
            </button>
          )}
          <span style={{ flex: '1 1 300px', fontSize: 13, lineHeight: 1.5, color: '#948C7E', textWrap: 'pretty' }}>
            Плагин — своя вкладка и свой процесс. Выключенный не грузится и не мешает обновлениям панели.
          </span>
        </div>
      </SettingsBlock>
    </div>
  );
}
