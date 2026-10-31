import { useState } from 'react';

import { Segmented } from '@/modules/kabina';
import type { MirageSettings, MirageSettingsPatch } from '@/shared/types';
import { RadioCards, SettingRow, SettingsBlock, SwitchRow } from '@/modules/kabina-settings/SettingsParts';

type ClaudeSectionProps = {
  settings: MirageSettings['claude'];
  update: (patch: MirageSettingsPatch) => void;
  /** The panel runs as root (the server reports uid 0): Bypass is refused by Claude Code. */
  runsAsRoot: boolean;
};

const MODES: Array<{ value: MirageSettings['claude']['permissionMode']; label: string; tag: string; desc: string }> = [
  { value: 'default', label: 'Default', tag: 'DEFAULT', desc: 'Спрашивает перед каждой правкой файла и каждой командой.' },
  { value: 'auto', label: 'Auto', tag: 'AUTO', desc: 'Безопасное делает сам, спрашивает только про рискованное — удаление, выкладку, сеть.' },
  { value: 'plan', label: 'Plan', tag: 'PLAN', desc: 'Только читает и составляет план. Ничего не меняет, пока не одобришь.' },
  { value: 'acceptEdits', label: 'Принимать правки', tag: 'ПРИНИМАТЬ ПРАВКИ', desc: 'Правки файлов принимает сам, команды терминала — с подтверждением.' },
];

const EFFORTS: Array<MirageSettings['claude']['effort']> = ['low', 'medium', 'high', 'xhigh', 'max'];
const SILENCE_STEPS = [15, 30, 45, 60, 90, 120];

/** «Opus» for `opus` or a full id such as `claude-opus-4-1`. */
function modelFamily(model: string): 'opus' | 'sonnet' | 'haiku' | null {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

/**
 * DarkSettings 01 «Claude»: default permission mode (Bypass explained under root),
 * model and effort, artifacts and workflows (settings.json), the silence ceiling
 * of background work and what a message sent mid-turn does. Rendered by KabinaSettingsScreen.
 */
export default function ClaudeSection({ settings, update, runsAsRoot }: ClaudeSectionProps) {
  // The «Как включить» explanation under the Bypass note.
  const [bypassOpen, setBypassOpen] = useState(false);
  const patch = (next: Partial<MirageSettings['claude']>) => update({ claude: next });
  const mode = MODES.find((entry) => entry.value === settings.permissionMode) ?? MODES[0];
  const effortIndex = EFFORTS.indexOf(settings.effort);
  const family = modelFamily(settings.model);

  const silence = settings.silenceCeilingMin;
  const stepIndex = SILENCE_STEPS.findIndex((step) => step >= silence);
  const lower = [...SILENCE_STEPS].reverse().find((step) => step < silence);
  const higher = SILENCE_STEPS.find((step) => step > silence);
  const silenceWidth = `${Math.min(100, Math.round((silence / 120) * 100))}%`;

  return (
    <div className="kb-set-group">
      <SettingsBlock id="h-perm" index="01.1" title="РЕЖИМ ПРАВ" major delay={1}>
        <div className="kb-bz kb-set-plate">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 18 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '14px 24px' }}>
              <div className="kb-set-text">
                <span className="kb-set-name">Режим по умолчанию</span>
                <span className="kb-set-desc">
                  С ним открывается каждый новый диалог. В самом диалоге меняешь на ходу —{' '}
                  <span className="kb-m" style={{ fontSize: 11.5, color: '#EDE6DA' }}>⇧ Tab</span>.
                </span>
              </div>
              <div className="kb-set-modes">
                <Segmented
                  ariaLabel="Режим прав по умолчанию"
                  options={MODES.map(({ value, label }) => ({ value, label }))}
                  value={settings.permissionMode}
                  onChange={(permissionMode) => patch({ permissionMode })}
                  trailing={runsAsRoot ? (
                    <button
                      type="button"
                      className="kb-seg"
                      aria-disabled="true"
                      aria-expanded={bypassOpen}
                      aria-label="Bypass — недоступен под root, показать почему"
                      onClick={() => setBypassOpen((open) => !open)}
                      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '0 12px', border: '1px dashed rgba(255,236,210,0.16)', color: '#948C7E', cursor: 'help' }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <rect x="5" y="11" width="14" height="10" rx="1.5" />
                        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                      </svg>
                      <span style={{ textDecoration: 'line-through', textDecorationColor: 'rgba(148,140,126,0.6)' }}>Bypass</span>
                    </button>
                  ) : undefined}
                />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '12px 14px', background: '#161512', border: '1px solid rgba(255,236,210,0.07)', borderRadius: 4 }}>
              <span className="kb-m" style={{ flex: 'none', fontSize: 10, letterSpacing: '0.16em', color: '#FF8A55' }}>{mode.tag}</span>
              <span style={{ fontSize: 13.5, lineHeight: 1.5, color: '#EDE6DA', textWrap: 'pretty' }}>{mode.desc}</span>
            </div>
          </div>
          {runsAsRoot && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '12px 16px', padding: '16px 18px', borderTop: '1px solid rgba(255,236,210,0.07)', backgroundImage: 'repeating-linear-gradient(135deg, rgba(217,163,91,0.05) 0 6px, transparent 6px 14px)', borderRadius: '0 0 6px 6px' }}>
              <span aria-hidden="true" style={{ width: 30, height: 30, flex: 'none', display: 'grid', placeItems: 'center', border: '1px solid rgba(217,163,91,0.5)', borderRadius: 4, color: '#D9A35B', background: '#1A1916' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17h.01" /></svg>
              </span>
              <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 13.5, lineHeight: 1.55, color: '#B3AA9B', textWrap: 'pretty' }}>
                  <span style={{ color: '#D9A35B', fontWeight: 500 }}>Bypass недоступен под root.</span> Claude Code не даёт пропускать все подтверждения, когда панель запущена от root, — иначе любая команда пройдёт с полными правами сервера. Поэтому кнопка выключена, а не молча ломает диалог.
                </span>
                {bypassOpen && (
                  <div className="kb-fadein" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', background: '#12110F', border: '1px solid rgba(255,236,210,0.09)', borderRadius: 4 }}>
                    <span style={{ fontSize: 13, lineHeight: 1.5, color: '#EDE6DA' }}>Как включить: запусти службу mirage от отдельного пользователя без root — режим появится здесь сам.</span>
                    <span className="kb-m" style={{ fontSize: 11, lineHeight: 1.7, color: '#B3AA9B' }}>
                      <span style={{ color: '#948C7E' }}>$</span> sudo systemctl edit mirage<br />
                      <span style={{ color: '#948C7E' }}>#</span> [Service] → <span style={{ color: '#D9A35B' }}>User=mirage</span>
                    </span>
                    <span style={{ fontSize: 12, color: '#948C7E' }}>Перезапуск службы оборвёт открытые диалоги — делай, когда всё сохранено.</span>
                  </div>
                )}
              </div>
              <button type="button" className="kb-btn kb-ghost" aria-expanded={bypassOpen} onClick={() => setBypassOpen((open) => !open)} style={{ flex: 'none' }}>
                {bypassOpen ? 'Скрыть' : 'Как включить'}
              </button>
            </div>
          )}
        </div>
      </SettingsBlock>

      <SettingsBlock id="h-model" index="01.2" title="МОДЕЛЬ ПО УМОЛЧАНИЮ" delay={2}>
        <div className="kb-set-plate" data-clip="">
          <SettingRow title="Модель" desc={family ? 'Для новых диалогов. Субагентам модель задаётся отдельно.' : `Сейчас задана модель ${settings.model}. Для новых диалогов; субагентам — отдельно.`}>
            <Segmented
              ariaLabel="Модель"
              minItemWidth={76}
              options={[
                { value: 'opus', label: 'Opus' },
                { value: 'sonnet', label: 'Sonnet' },
                { value: 'haiku', label: 'Haiku' },
              ]}
              value={family ?? ('' as 'opus')}
              onChange={(model) => patch({ model })}
            />
          </SettingRow>
          <SettingRow title="Effort" desc="Сколько думать перед ответом. Выше — точнее, но быстрее тратит лимит.">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <Segmented
                ariaLabel="Effort"
                mono
                minItemWidth={60}
                options={EFFORTS.map((effort) => ({ value: effort, label: effort }))}
                value={settings.effort}
                onChange={(effort) => patch({ effort })}
              />
              <span aria-hidden="true" style={{ display: 'flex', gap: 2, width: '100%', maxWidth: 320 }}>
                {Array.from({ length: 10 }, (_, index) => (
                  <span
                    key={index}
                    style={{
                      flex: 1,
                      height: 3,
                      borderRadius: 1,
                      background: index < (effortIndex + 1) * 2 ? (effortIndex >= 3 ? '#FF6A2B' : '#B3AA9B') : 'rgba(255,236,210,0.1)',
                      transition: 'background-color 0.2s ease',
                    }}
                  />
                ))}
              </span>
            </div>
          </SettingRow>
        </div>
      </SettingsBlock>

      <SettingsBlock id="h-feat" index="01.3" title="ВОЗМОЖНОСТИ" delay={3}>
        <div className="kb-set-plate" data-clip="">
          <SwitchRow
            title="Артефакты"
            desc="Claude публикует страницы и отчёты на claude.ai и присылает ссылку в чат."
            checked={settings.artifacts}
            onChange={(artifacts) => patch({ artifacts })}
          />
          <SwitchRow
            title="Воркфлоу"
            desc="Многошаговые сценарии с параллельными агентами — pipeline и parallel."
            checked={settings.workflows}
            onChange={(workflows) => patch({ workflows })}
          />
        </div>
      </SettingsBlock>

      <SettingsBlock id="h-turn" index="01.4" title="ХОД И ФОНОВАЯ РАБОТА" delay={4}>
        <div className="kb-set-plate" data-clip="">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px 32px', padding: 18 }}>
            <div className="kb-set-text" style={{ flex: '1 1 260px' }}>
              <span className="kb-set-name">Потолок тишины фоновой работы</span>
              <span className="kb-set-desc">Молчит дольше — панель считает агента зависшим и пишет тебе. Для долгих сборок и генераций ставь больше.</span>
            </div>
            <div style={{ flex: '1 1 340px', minWidth: 0, maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div role="group" aria-label="Потолок тишины, минут" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: 3, background: '#12110F', border: '1px solid rgba(255,236,210,0.1)', borderRadius: 6 }}>
                  <button type="button" className="kb-set-iconbtn" aria-label="Меньше" disabled={lower === undefined} onClick={() => lower !== undefined && patch({ silenceCeilingMin: lower })} style={{ width: 38, height: 38, border: '1px solid transparent', color: '#EDE6DA' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 12h14" /></svg>
                  </button>
                  <span aria-live="polite" style={{ minWidth: 86, display: 'inline-flex', alignItems: 'baseline', justifyContent: 'center', gap: 6 }}>
                    <span className="kb-t" style={{ fontSize: 26, fontWeight: 500, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{silence}</span>
                    <span className="kb-m" style={{ fontSize: 10.5, color: '#948C7E' }}>мин</span>
                  </span>
                  <button type="button" className="kb-set-iconbtn" aria-label="Больше" disabled={higher === undefined} onClick={() => higher !== undefined && patch({ silenceCeilingMin: higher })} style={{ width: 38, height: 38, border: '1px solid transparent', color: '#EDE6DA' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                </div>
                <div style={{ display: 'inline-flex', gap: 6 }}>
                  {[30, 60, 120].map((minutes) => {
                    const on = minutes === silence;
                    return (
                      <button
                        key={minutes}
                        type="button"
                        className="kb-seg kb-m"
                        aria-pressed={on}
                        onClick={() => patch({ silenceCeilingMin: minutes })}
                        style={{ minHeight: 36, minWidth: 48, padding: '0 10px', background: on ? 'rgba(255,106,43,0.14)' : 'transparent', border: `1px solid ${on ? 'rgba(255,106,43,0.5)' : 'rgba(255,236,210,0.1)'}`, fontSize: 12, color: on ? '#FF8A55' : '#B3AA9B' }}
                      >
                        {minutes}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ position: 'relative', height: 18 }}>
                  <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 10, background: 'repeating-linear-gradient(90deg, rgba(255,236,210,0.32) 0 1px, transparent 1px 25%) left bottom / calc(100% + 1px) 10px no-repeat, repeating-linear-gradient(90deg, rgba(255,236,210,0.14) 0 1px, transparent 1px 12.5%) left bottom / calc(100% + 1px) 5px no-repeat' }} />
                  <span style={{ position: 'absolute', left: 0, bottom: 0, height: 2, width: silenceWidth, background: '#FF6A2B', boxShadow: '0 0 8px rgba(255,106,43,0.6)', transition: 'width .25s cubic-bezier(.2,.7,.2,1)' }} />
                  <svg width="10" height="8" viewBox="0 0 10 8" style={{ position: 'absolute', top: 0, left: silenceWidth, marginLeft: -5, transition: 'left .25s cubic-bezier(.2,.7,.2,1)' }}><path d="M0 0h10L5 8z" fill="#FF6A2B" /></svg>
                </div>
                <div className="kb-m" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: '#948C7E' }}>
                  <span>0</span><span>30</span><span>60</span><span>90</span><span>120 мин</span>
                </div>
              </div>
              {stepIndex === -1 && <span className="kb-set-hint">Сейчас {silence} мин — больше шкалы; минус вернёт к 120.</span>}
            </div>
          </div>
          <div className="kb-set-sub" style={{ borderTop: '1px solid rgba(255,236,210,0.07)', padding: 18 }}>
            <div className="kb-set-text">
              <span className="kb-set-name">Сообщение во время хода</span>
              <span className="kb-set-desc">Что делать, если пишешь, пока Claude ещё работает. Ход не обрывается ни в одном из вариантов.</span>
            </div>
            <RadioCards
              ariaLabel="Сообщение во время хода"
              value={settings.midTurnMessage}
              onChange={(midTurnMessage) => patch({ midTurnMessage })}
              options={[
                { value: 'inject', label: 'Вклинить сразу', tag: 'КАК В ТЕРМИНАЛЕ', desc: 'Claude увидит сообщение на следующем шаге и учтёт его, не дожидаясь конца хода.' },
                { value: 'queue', label: 'Поставить в очередь', tag: 'ПОСЛЕ ХОДА', desc: 'Уйдёт следующим сообщением, когда ход закончится. Очередь видна над полем ввода.' },
              ]}
            />
          </div>
        </div>
      </SettingsBlock>
    </div>
  );
}
