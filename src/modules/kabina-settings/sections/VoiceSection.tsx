import { Fragment, useEffect, useState } from 'react';

import { Segmented } from '@/modules/kabina';
import type { MirageSettings, MirageSettingsPatch } from '@/shared/types';
import { RadioCards, SettingRow, SettingsBlock, SwitchRow } from '@/modules/kabina-settings/SettingsParts';

type VoiceSectionProps = {
  settings: MirageSettings['voice'];
  update: (patch: MirageSettingsPatch) => void;
};

const MODIFIER_KEYS = ['Alt', 'Control', 'Meta', 'Shift'] as const;
const KEY_CAPS: Record<string, string> = { Alt: '⌥', Control: '⌃', Meta: '⌘', Shift: '⇧', Space: 'ПРОБЕЛ' };

/** «Alt+Space» → ['⌥', 'ПРОБЕЛ'] for the key caps. */
function keyCaps(hotkey: string): string[] {
  return hotkey.split('+').map((part) => KEY_CAPS[part] ?? part.toUpperCase());
}

/**
 * DarkSettings 02 «Голос»: the push-to-talk hotkey (with a recorder for a new
 * combination), recognition language and engine, and what happens after a recording.
 * Rendered by KabinaSettingsScreen.
 */
export default function VoiceSection({ settings, update }: VoiceSectionProps) {
  // Waiting for a new key combination («Нажми новое сочетание…»).
  const [recording, setRecording] = useState(false);
  const patch = (next: Partial<MirageSettings['voice']>) => update({ voice: next });

  useEffect(() => {
    if (!recording) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(false);
        return;
      }
      // A bare modifier is not a combination yet — wait for the main key.
      if ((MODIFIER_KEYS as readonly string[]).includes(event.key)) return;
      const parts = [
        event.ctrlKey ? 'Control' : null,
        event.metaKey ? 'Meta' : null,
        event.altKey ? 'Alt' : null,
        event.shiftKey ? 'Shift' : null,
        event.code === 'Space' ? 'Space' : event.code.replace(/^Key/, '').replace(/^Digit/, ''),
      ].filter(Boolean);
      if (parts.length < 2) return;
      patch({ hotkey: parts.join('+') });
      setRecording(false);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
    // `patch` is recreated each render; the listener only lives while recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const caps = keyCaps(settings.hotkey);

  return (
    <div className="kb-set-group">
      <SettingsBlock id="h-key" index="02.1" title="ГОРЯЧАЯ КЛАВИША" major delay={1}>
        <div className="kb-bz kb-set-plate" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '16px 24px', padding: 18 }}>
          <div className="kb-set-text" style={{ flex: '1 1 260px' }}>
            <span className="kb-set-name">Говорить с Claude</span>
            <span className="kb-set-desc">Удерживаешь — говоришь, отпустил — текст в поле ввода. Работает на любом экране панели.</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
            {recording ? (
              <span className="kb-fadein" role="status" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 10, padding: '0 16px', border: '1px dashed rgba(255,106,43,0.55)', borderRadius: 6, fontSize: 14, color: '#FF8A55' }}>
                <span className="kb-led kb-led-wait" style={{ borderRadius: '50%', transform: 'none' }} />
                Нажми новое сочетание…
              </span>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} aria-label={`Сочетание: ${settings.hotkey}, удерживать`}>
                {caps.map((cap, index) => (
                  <Fragment key={`${cap}-${index}`}>
                    {index > 0 && <span className="kb-m" aria-hidden="true" style={{ fontSize: 12, color: '#948C7E' }}>+</span>}
                    <span
                      className="kb-m kb-set-keycap"
                      aria-hidden="true"
                      style={cap.length > 1 ? { minWidth: 120, padding: '0 14px', fontSize: 12, letterSpacing: '0.08em' } : undefined}
                    >
                      {cap}
                    </span>
                  </Fragment>
                ))}
                <span className="kb-m" aria-hidden="true" style={{ fontSize: 10, letterSpacing: '0.14em', color: '#948C7E' }}>УДЕРЖИВАТЬ</span>
              </span>
            )}
            <button type="button" className="kb-btn kb-ghost" onClick={() => setRecording((value) => !value)} style={{ minHeight: 44, padding: '0 16px', fontSize: 14, borderRadius: 6 }}>
              {recording ? 'Отмена' : 'Изменить'}
            </button>
          </div>
        </div>
      </SettingsBlock>

      <SettingsBlock id="h-asr" index="02.2" title="РАСПОЗНАВАНИЕ" delay={2}>
        <div className="kb-set-plate" data-clip="">
          <SettingRow title="Язык" desc="Английские термины внутри русской речи понимает в любом режиме.">
            <Segmented
              ariaLabel="Язык распознавания"
              options={[
                { value: 'ru', label: 'Русский' },
                { value: 'en', label: 'English' },
                { value: 'auto', label: 'Авто' },
              ]}
              value={settings.language}
              onChange={(language) => patch({ language })}
            />
          </SettingRow>
          <div className="kb-set-sub">
            <div className="kb-set-text">
              <span className="kb-set-name">Движок</span>
              <span className="kb-set-desc">Где превращать голос в текст.</span>
            </div>
            <RadioCards
              ariaLabel="Движок распознавания"
              tagTone="sand"
              value={settings.engine}
              onChange={(engine) => patch({ engine })}
              options={[
                { value: 'yandex', label: 'Яндекс SpeechKit', tag: '~0,3 с', desc: 'Облако. Лучше всех понимает русский, названия проектов и термины.' },
                { value: 'whisper', label: 'Whisper на сервере', tag: '~2 с', desc: 'Локально на твоём сервере — звук никуда не уходит. Медленнее, грузит процессор.' },
              ]}
            />
          </div>
        </div>
      </SettingsBlock>

      <SettingsBlock id="h-after" index="02.3" title="ПОСЛЕ ЗАПИСИ" delay={3}>
        <div className="kb-set-plate" data-clip="">
          <SwitchRow
            title="Отправлять сразу после отпускания"
            desc="Выключи, если хочешь сначала поправить текст в поле."
            checked={settings.sendOnRelease}
            onChange={(sendOnRelease) => patch({ sendOnRelease })}
          />
          <SwitchRow
            title="Озвучивать ответы"
            desc="Claude читает вслух короткий итог хода, у длинных ответов — первый абзац."
            checked={settings.speakReplies}
            onChange={(speakReplies) => patch({ speakReplies })}
          />
        </div>
      </SettingsBlock>
    </div>
  );
}
