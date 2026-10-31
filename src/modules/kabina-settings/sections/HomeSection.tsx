import { useState } from 'react';

import { Toggle } from '@/modules/kabina';
import { isSubscriptionLimitsEnabled, useSubscriptionLimits } from '@/shared/hooks/useSubscriptionLimits';
import type { MirageSettings, MirageSettingsPatch, MirageWidgetId } from '@/shared/types';
import { SettingsBlock } from '@/modules/kabina-settings/SettingsParts';

type HomeSectionProps = {
  settings: MirageSettings['home'];
  update: (patch: MirageSettingsPatch) => void;
};

/** Name, explanation and the preview bar height of each home widget (DarkSettings 03). */
const WIDGETS: Record<MirageWidgetId, { name: string; desc: string; height: number }> = {
  fav: { name: 'Избранное', desc: 'Закреплённые проекты и их статус', height: 44 },
  work: { name: 'В работе', desc: 'Идущие агенты и что ждёт твоего ответа', height: 36 },
  cal: { name: 'Календарь', desc: 'Неделя и события на сегодня', height: 40 },
  lim: { name: 'Лимиты', desc: 'неделя, кредиты · плагин claude-usage', height: 32 },
  leads: { name: 'Заявки и Директ', desc: 'Новые заявки и расход за сутки', height: 32 },
  server: { name: 'Сервер', desc: 'Нагрузка, диск, службы', height: 28 },
  deploy: { name: 'Кнопки выкладки', desc: 'Выложить на прод в одно нажатие', height: 28 },
};

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * DarkSettings 03 «Главный экран»: which widgets the home screen shows and in
 * which order (drag by the dots or the arrows), with a live schematic preview.
 * Rendered by KabinaSettingsScreen.
 */
export default function HomeSection({ settings, update }: HomeSectionProps) {
  // Index of the row being dragged and the row it hovers over.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const widgets = settings.widgets;
  // Without the limits counter (server MIRAGE_SUBSCRIPTION_LIMITS) the «Лимиты» widget is not offered;
  // its saved place in the order is kept. Rows keep their index in the full list for moving.
  const limitsEnabled = isSubscriptionLimitsEnabled(useSubscriptionLimits());
  const rows = widgets
    .map((widget, index) => ({ widget, index }))
    .filter(({ widget }) => limitsEnabled || widget.id !== 'lim');
  const enabled = rows.map(({ widget }) => widget).filter((widget) => widget.enabled);

  const save = (next: MirageSettings['home']['widgets']) => update({ home: { widgets: next } });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= widgets.length || from === to) return;
    const next = [...widgets];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    save(next);
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '30px 28px', alignItems: 'flex-start' }}>
      <SettingsBlock
        id="h-wid"
        index="03.1"
        title={`ВИДЖЕТЫ · ${enabled.length} ИЗ ${rows.length}`}
        delay={1}
        style={{ flex: '999 1 460px', minWidth: 0 }}
      >
        <span className="kb-set-hint">Тяни за точки или жми стрелки · сверху вниз = порядок на главном</span>
        <div className="kb-set-plate" data-clip="">
          {rows.map(({ widget, index }, position) => {
            const info = WIDGETS[widget.id];
            // The neighbours on screen (a hidden widget between them is jumped over).
            const above = rows[position - 1]?.index;
            const below = rows[position + 1]?.index;
            const on = widget.enabled;
            return (
              <div
                key={widget.id}
                className="kb-set-row kb-set-widget"
                data-hover=""
                data-on={on ? '' : undefined}
                data-dragging={dragIndex === index ? '' : undefined}
                data-drop={dropIndex === index && dragIndex !== null && dragIndex !== index ? '' : undefined}
                draggable
                onDragStart={(event) => {
                  setDragIndex(index);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDropIndex(index);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragIndex !== null) move(dragIndex, index);
                  setDragIndex(null);
                  setDropIndex(null);
                }}
              >
                <span className="kb-set-grip" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" /></svg>
                </span>
                <span className="kb-m kb-set-widget-num">{pad2(position + 1)}</span>
                <div className="kb-set-widget-text">
                  <span className="kb-set-widget-name">{info.name}</span>
                  <span className="kb-set-widget-desc">{info.desc}</span>
                </div>
                <div className="kb-set-widget-arrows">
                  <button type="button" className="kb-set-iconbtn" aria-label={`Поднять «${info.name}»`} disabled={above === undefined} onClick={() => above !== undefined && move(index, above)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
                  </button>
                  <button type="button" className="kb-set-iconbtn" aria-label={`Опустить «${info.name}»`} disabled={below === undefined} onClick={() => below !== undefined && move(index, below)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
                  </button>
                </div>
                <Toggle
                  checked={on}
                  showState={false}
                  ariaLabel={`Показывать «${info.name}»`}
                  onChange={(next) => save(widgets.map((entry) => (entry.id === widget.id ? { ...entry, enabled: next } : entry)))}
                />
              </div>
            );
          })}
        </div>
      </SettingsBlock>

      <SettingsBlock id="h-prev" index="03.2" title="ТАК БУДЕТ НА ГЛАВНОМ" delay={2} style={{ flex: '1 1 320px', minWidth: 0 }}>
        <div
          className="kb-bz"
          role="img"
          aria-label={`Схема главного экрана: ${enabled.map((widget) => WIDGETS[widget.id].name).join(', ') || 'только сводка'}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14, background: '#161512', border: '1px solid rgba(255,236,210,0.09)', borderRadius: 6, backgroundImage: 'linear-gradient(rgba(255,236,210,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,236,210,0.03) 1px, transparent 1px)', backgroundSize: '16px 16px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, borderBottom: '1px dashed rgba(255,236,210,0.1)' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', border: '1px solid rgba(237,230,218,0.5)' }} />
            <span style={{ height: 5, width: 54, background: 'rgba(237,230,218,0.35)', borderRadius: 1 }} />
            <span style={{ flex: 1 }} />
            <span style={{ height: 12, width: 90, border: '1px solid rgba(255,236,210,0.14)', borderRadius: 2 }} />
          </div>
          <span className="kb-m" style={{ fontSize: 9.5, letterSpacing: '0.16em', color: '#948C7E' }}>СВОДКА · ВСЕГДА СВЕРХУ</span>
          {enabled.map((widget, index) => (
            <div key={widget.id} className="kb-fadein" style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: WIDGETS[widget.id].height, padding: '0 12px', background: '#1A1916', border: '1px solid rgba(255,236,210,0.1)', borderRadius: 4 }}>
              <span className="kb-m" style={{ fontSize: 10, color: '#FF6A2B' }}>{pad2(index + 1)}</span>
              <span style={{ fontSize: 13, color: '#EDE6DA' }}>{WIDGETS[widget.id].name}</span>
              <span style={{ flex: 1, height: 1, background: 'repeating-linear-gradient(90deg, rgba(255,236,210,0.18) 0 2px, transparent 2px 6px)' }} />
            </div>
          ))}
          {enabled.length === 0 && (
            <span style={{ padding: '18px 0', fontSize: 13, color: '#948C7E', textAlign: 'center' }}>Все виджеты выключены — останется только сводка.</span>
          )}
        </div>
      </SettingsBlock>
    </div>
  );
}
