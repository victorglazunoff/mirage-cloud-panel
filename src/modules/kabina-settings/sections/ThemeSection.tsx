import { Segmented } from '@/modules/kabina';
import type { MirageSettings, MirageSettingsPatch } from '@/shared/types';
import { SettingsBlock, SettingsTag } from '@/modules/kabina-settings/SettingsParts';

type ThemeSectionProps = {
  settings: MirageSettings['appearance'];
  update: (patch: MirageSettingsPatch) => void;
};

const THEMES = [
  { value: 'cabin', label: 'Кабина (тёмная)', desc: 'Приборная панель: графит, сигнальный оранжевый', bg: '#12110F', grid: 'rgba(255,236,210,0.04)', ink: 'rgba(237,230,218,0.55)', line: 'rgba(255,236,210,0.12)', card: '#1A1916', soon: false },
  { value: 'light', label: 'Светлая', desc: 'Для дня у окна · те же сигналы, бумажный фон', bg: '#F1ECE3', grid: 'rgba(27,25,22,0.05)', ink: 'rgba(27,25,22,0.6)', line: 'rgba(27,25,22,0.16)', card: '#FBF8F2', soon: true },
] as const;

const SAMPLE = [
  { name: 'Карта участков', time: '12 мин', led: 'run' },
  { name: 'Сайт клиента', time: '2 мин', led: 'wait' },
  { name: 'DemoVilla', time: '24 окт', led: 'idle' },
] as const;

/**
 * DarkSettings 07 «Тема»: «Кабина» or the light theme (marked «скоро» — the choice
 * is kept and applies once it exists) and the interface density with a sample.
 * Rendered by KabinaSettingsScreen.
 */
export default function ThemeSection({ settings, update }: ThemeSectionProps) {
  // Mock-up: three sample rows of ~43px under the «ОБРАЗЕЦ» cap, ~160px in all.
  const rowPad = settings.density === 'compact' ? '6px 12px' : '11px 12px';
  return (
    <div className="kb-set-group">
      <SettingsBlock id="h-th" index="07.1" title="ТЕМА" major delay={1}>
        <div role="radiogroup" aria-label="Тема" className="kb-set-themes">
          {THEMES.map((theme) => (
            <button
              key={theme.value}
              type="button"
              role="radio"
              aria-checked={settings.theme === theme.value}
              className="kb-set-theme"
              onClick={() => update({ appearance: { theme: theme.value } })}
            >
              <span aria-hidden="true" style={{ height: 150, display: 'flex', flexDirection: 'column', gap: 9, padding: 14, boxSizing: 'border-box', backgroundColor: theme.bg, backgroundImage: `linear-gradient(${theme.grid} 1px, transparent 1px), linear-gradient(90deg, ${theme.grid} 1px, transparent 1px)`, backgroundSize: '14px 14px', borderBottom: '1px solid rgba(255,236,210,0.08)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, paddingBottom: 8, borderBottom: `1px solid ${theme.line}` }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', border: `1px solid ${theme.ink}` }} />
                  <span style={{ height: 4, width: 38, background: theme.ink, borderRadius: 1 }} />
                  <span style={{ flex: 1 }} />
                  <span style={{ height: 10, width: 70, border: `1px solid ${theme.line}`, borderRadius: 2 }} />
                </span>
                <span style={{ height: 12, width: '52%', background: theme.ink, borderRadius: 1 }} />
                <span style={{ display: 'flex', gap: 6 }}>
                  <span style={{ flex: 1, height: 44, background: theme.card, border: `1px solid ${theme.line}`, borderRadius: 3, display: 'flex', alignItems: 'flex-end', padding: 6, boxSizing: 'border-box' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#FF6A2B' }} />
                  </span>
                  <span style={{ flex: 1, height: 44, background: theme.card, border: '1px solid #FF6A2B', borderRadius: 3, display: 'flex', alignItems: 'flex-end', padding: 6, boxSizing: 'border-box' }}>
                    <span style={{ width: 6, height: 6, background: '#FF6A2B', transform: 'rotate(45deg)' }} />
                  </span>
                  <span style={{ flex: 1, height: 44, background: theme.card, border: `1px solid ${theme.line}`, borderRadius: 3 }} />
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px' }}>
                <span className="kb-set-radio" aria-hidden="true"><span /></span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 15, fontWeight: 500 }}>{theme.label}</span>
                  <span style={{ fontSize: 12.5, color: '#B3AA9B' }}>{theme.desc}</span>
                </span>
                {theme.soon && <SettingsTag tone="sand">СКОРО</SettingsTag>}
              </span>
            </button>
          ))}
        </div>
        {settings.theme === 'light' && (
          <div className="kb-fadein" role="note" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', background: '#1A1916', border: '1px solid rgba(217,163,91,0.35)', borderRadius: 6, fontSize: 13.5, lineHeight: 1.5, color: '#B3AA9B' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D9A35B" strokeWidth="1.7" aria-hidden="true" style={{ flex: 'none', marginTop: 2 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
            <span style={{ textWrap: 'pretty' }}>Светлая тема ещё в работе. Выбор запомнили — включится сама, когда будет готова. Пока панель остаётся «Кабиной».</span>
          </div>
        )}
      </SettingsBlock>

      <SettingsBlock id="h-den" index="07.2" title="ПЛОТНОСТЬ ИНТЕРФЕЙСА" delay={2}>
        <div className="kb-set-plate" style={{ display: 'flex', flexWrap: 'wrap', gap: '18px 28px', padding: 18 }}>
          <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14, alignSelf: 'flex-start' }}>
            {/* flex: none — in a column the text's 240px basis would turn into a 240px height. */}
            <div className="kb-set-text" style={{ flex: 'none' }}>
              <span className="kb-set-name">Отступы в списках и чатах</span>
              <span className="kb-set-desc">Компактная вмещает больше строк на экран, кнопки остаются удобными для пальца.</span>
            </div>
            <div style={{ alignSelf: 'flex-start' }}>
              <Segmented
                ariaLabel="Плотность интерфейса"
                options={[
                  { value: 'normal', label: 'Обычная' },
                  { value: 'compact', label: 'Компактная' },
                ]}
                value={settings.density}
                onChange={(density) => update({ appearance: { density } })}
              />
            </div>
          </div>
          <div aria-hidden="true" style={{ flex: '1 1 280px', minWidth: 0, alignSelf: 'flex-start', display: 'flex', flexDirection: 'column', background: '#12110F', border: '1px solid rgba(255,236,210,0.08)', borderRadius: 5, overflow: 'hidden' }}>
            <span className="kb-m" style={{ padding: '8px 12px', fontSize: 9.5, letterSpacing: '0.16em', color: '#948C7E', borderBottom: '1px solid rgba(255,236,210,0.07)' }}>ОБРАЗЕЦ</span>
            {SAMPLE.map((row, index) => (
              <div key={row.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: rowPad, borderTop: index === 0 ? 'none' : '1px solid rgba(255,236,210,0.07)', transition: 'padding 200ms ease-out' }}>
                <span className={`kb-led kb-led-${row.led}`} />
                <span style={{ flex: 1, fontSize: 14 }}>{row.name}</span>
                <span className="kb-m" style={{ fontSize: 10.5, color: '#948C7E' }}>{row.time}</span>
              </div>
            ))}
          </div>
        </div>
      </SettingsBlock>
    </div>
  );
}
