import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { NO_AUTOFILL, Toggle } from '@/modules/kabina';
import { TelegramLinkCardView, useTelegramLink } from '@/modules/kabina-notifications';
import { useWebPush } from '@/modules/settings';
import { isSubscriptionLimitsEnabled, useSubscriptionLimits } from '@/shared/hooks/useSubscriptionLimits';
import type { MirageSettings, MirageSettingsPatch } from '@/shared/types';
import { SettingsBlock, SettingsTag } from '@/modules/kabina-settings/SettingsParts';

type NotifySectionProps = {
  settings: MirageSettings['notifications'];
  update: (patch: MirageSettingsPatch) => void;
};

type EventKey = keyof MirageSettings['notifications']['events'];

const EVENTS: Array<{ key: EventKey; name: string; desc: string; isDefault: boolean }> = [
  { key: 'turnComplete', name: 'Ход закончен', desc: 'Claude ответил и ждёт следующего сообщения.', isDefault: false },
  { key: 'backgroundDone', name: 'Фоновая работа завершена', desc: 'Агент, сборка или генерация досчитались.', isDefault: false },
  { key: 'approvalNeeded', name: 'Нужно подтверждение', desc: 'Без тебя Claude дальше не пойдёт — права, выкладка, вопрос.', isDefault: true },
  { key: 'limit80', name: 'Лимит больше 80 %', desc: 'Недельный лимит — чтобы успеть переключить модель.', isDefault: false },
];

/** «Прислать тестовое»: where it went, or why it could not go. */
type TestState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; where: string }
  | { kind: 'failed'; reason: string };

const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

type ChannelRowProps = {
  mono: string;
  name: string;
  sub: string;
  /** The channel is on: its mark turns orange (as the plugins' marks do). */
  on: boolean;
  /** Messages can actually go out now (permission given): the dot turns green. */
  live: boolean;
  /** The switch; a row without one shows `action` instead (MAX: «Подключить»). */
  toggle?: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean };
  action?: ReactNode;
};

function ChannelRow({ mono, name, sub, on, live, toggle, action }: ChannelRowProps) {
  return (
    <div className="kb-set-row kb-set-channel" data-hover="">
      <span className="kb-m kb-set-mono-badge" data-on={on ? '' : undefined} aria-hidden="true">{mono}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="kb-set-name">{name}</span>
        <span className="kb-set-status" style={{ color: live || on ? '#B3AA9B' : '#948C7E' }}>
          <span className={`kb-led ${live ? 'kb-led-ok' : 'kb-led-idle'}`} />
          {sub}
        </span>
      </div>
      {action}
      {toggle && <Toggle checked={toggle.checked} onChange={toggle.onChange} ariaLabel={name} disabled={toggle.disabled} />}
    </div>
  );
}

/** «с 23:00 до 08:00»: a clock field that saves a valid HH:MM on blur or Enter. */
function ClockField({ label, value, onSave }: { label: string; value: string; onSave: (next: string) => void }) {
  // The text being typed; synced back when the saved value changes.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = CLOCK_PATTERN.test(draft);
  const commit = () => {
    if (valid && draft !== value) onSave(draft);
    if (!valid) setDraft(value);
  };
  return (
    <label className="kb-set-quiet-field">
      <span className="kb-m kb-set-quiet-label">{label}</span>
      <input
        {...NO_AUTOFILL}
        autoCorrect="off"
        className="kb-set-field kb-m kb-set-quiet-input"
        type="text"
        inputMode="numeric"
        maxLength={5}
        value={draft}
        aria-label={`Тихие часы ${label}`}
        aria-invalid={valid ? undefined : 'true'}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d:]/g, ''))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

/**
 * DarkSettings 04 «Уведомления»: channels (Telegram bot, MAX, this browser's
 * push) and which events are worth a message, plus the quiet hours. The
 * server's Telegram notifier reads these same settings before every message.
 * Rendered by KabinaSettingsScreen.
 */
export default function NotifySection({ settings, update }: NotifySectionProps) {
  const push = useWebPush();
  const telegram = useTelegramLink();
  // Result of «Прислать тестовое».
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  // «Подключить» MAX was pressed: the row says why it cannot be yet.
  const [maxAsked, setMaxAsked] = useState(false);
  const channels = settings.channels;
  const setChannel = (key: keyof MirageSettings['notifications']['channels'], value: boolean) =>
    update({ notifications: { channels: { ...channels, [key]: value } } });
  // Without the limits counter (server MIRAGE_SUBSCRIPTION_LIMITS) there is nothing to warn about.
  const limitsEnabled = isSubscriptionLimitsEnabled(useSubscriptionLimits());
  const events = limitsEnabled ? EVENTS : EVENTS.filter((event) => event.key !== 'limit80');
  const eventsOn = events.filter((event) => settings.events[event.key]).length;

  const browserLive = push.permission === 'granted' && push.isSubscribed;
  const browserUnsupported = push.permission === 'unsupported';
  // The saved switch and the browser's real state can differ (permission withdrawn, another device):
  // the caption tells what is true now and never asks to «включи» a switch that is already on.
  let browserSub: string;
  if (browserUnsupported) browserSub = 'Этот браузер не умеет пуш-уведомления';
  else if (push.permission === 'denied') browserSub = 'Пуш запрещён в настройках браузера — разреши там';
  else if (browserLive) browserSub = channels.browser ? 'Пуш на этом устройстве · разрешение дано' : 'Выключено · разрешение браузера есть';
  else if (channels.browser) browserSub = 'Включено · браузер ещё не дал разрешения';
  else browserSub = 'Пуш на этом устройстве · после включения браузер спросит разрешение';
  const telegramLinked = Boolean(telegram.status?.configured && telegram.status.linked);

  const toggleBrowser = async (next: boolean) => {
    setChannel('browser', next);
    if (next && !push.isSubscribed) await push.subscribe();
    if (!next && push.isSubscribed) await push.unsubscribe();
  };

  /** Shows a local notification on this device; false when the browser refuses. */
  const showBrowserTest = async (): Promise<boolean> => {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return false;
      const registration = await navigator.serviceWorker?.ready;
      const body = 'Тестовое уведомление панели — так придёт «нужно подтверждение».';
      if (registration) await registration.showNotification('Mirage', { body, tag: 'mirage-test' });
      else new Notification('Mirage', { body });
      return true;
    } catch {
      return false;
    }
  };

  // Telegram gets a real bot message when a chat is linked and the channel is on; the browser a local one.
  const sendTest = async () => {
    setTest({ kind: 'sending' });
    const places: string[] = [];
    if (telegramLinked && channels.telegram && (await telegram.sendTest())) places.push('Telegram');
    if (channels.browser && (await showBrowserTest())) places.push('уведомления браузера');
    if (places.length > 0) {
      setTest({ kind: 'sent', where: places.join(' и ') });
      return;
    }
    let reason = 'Некуда отправить — привяжи Telegram или включи пуш';
    if (telegramLinked && channels.telegram) reason = 'Telegram не принял — причина ниже, у строки Telegram';
    else if (telegramLinked) reason = 'Telegram выключен — включи его выше';
    else if (channels.browser) reason = 'Браузер не дал показать — включи пуш';
    setTest({ kind: 'failed', reason });
  };

  const quiet = settings.quietHours;
  const setQuiet = (patch: Partial<MirageSettings['notifications']['quietHours']>) =>
    update({ notifications: { quietHours: { ...quiet, ...patch } } });

  const testLabel = test.kind === 'sending'
    ? 'Отправляю…'
    : test.kind === 'sent'
      ? `Отправлено — проверь ${test.where}`
      : test.kind === 'failed'
        ? test.reason
        : 'Прислать тестовое';

  return (
    <div className="kb-set-group">
      <SettingsBlock id="h-ch" index="04.1" title="КУДА ПИСАТЬ" major delay={1}>
        <div className="kb-set-plate" data-clip="">
          <TelegramLinkCardView
            link={telegram}
            bare
            channel={{ checked: channels.telegram, onChange: (value) => setChannel('telegram', value) }}
          />
          <ChannelRow
            mono="MX"
            name="MAX"
            sub={maxAsked ? 'Бота для MAX пока нет — подключим, когда он появится' : 'Не подключён'}
            on={false}
            live={false}
            action={(
              <button
                type="button"
                className="kb-btn kb-ghost kb-set-channel-action"
                aria-pressed={maxAsked}
                onClick={() => setMaxAsked(true)}
              >
                Подключить
              </button>
            )}
          />
          <ChannelRow
            mono="WEB"
            name="Браузер"
            sub={browserSub}
            on={channels.browser && !browserUnsupported}
            live={channels.browser && browserLive}
            action={channels.browser && !browserLive && push.permission === 'default' ? (
              <button
                type="button"
                className="kb-btn kb-ghost kb-set-channel-action"
                disabled={push.isLoading}
                onClick={() => void push.subscribe()}
              >
                Разрешить
              </button>
            ) : null}
            toggle={{
              checked: channels.browser && !browserUnsupported,
              onChange: (value) => void toggleBrowser(value),
              disabled: push.isLoading || browserUnsupported,
            }}
          />
        </div>
      </SettingsBlock>

      <SettingsBlock
        id="h-ev"
        index="04.2"
        title="О ЧЁМ ПИСАТЬ"
        delay={2}
        aside={<span className="kb-m kb-ruler-meta">{eventsOn} из {events.length}</span>}
      >
        <span className="kb-set-hint">По умолчанию — только когда без тебя не продолжить.</span>
        <div className="kb-set-plate" data-clip="">
          {events.map((event) => (
            <div key={event.key} className="kb-set-row" data-hover="" data-tight="">
              <div className="kb-set-text">
                <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                  <span className="kb-set-name">{event.name}</span>
                  {event.isDefault && <SettingsTag tone="signal">ПО УМОЛЧАНИЮ</SettingsTag>}
                </span>
                <span className="kb-set-desc">{event.desc}</span>
              </div>
              <Toggle
                checked={settings.events[event.key]}
                ariaLabel={event.name}
                onChange={(value) => update({ notifications: { events: { ...settings.events, [event.key]: value } } })}
              />
            </div>
          ))}
          <div className="kb-set-row" data-hover="" data-tight="" style={{ flexWrap: 'wrap' }}>
            <div className="kb-set-text" style={{ flex: '1 1 220px' }}>
              <span className="kb-set-name">Тихие часы</span>
              <span className="kb-set-desc">В это время молчат все, кроме «нужно подтверждение». Время — по Екатеринбургу.</span>
            </div>
            <div className="kb-set-quiet">
              <ClockField label="с" value={quiet.from} onSave={(from) => setQuiet({ from })} />
              <ClockField label="до" value={quiet.to} onSave={(to) => setQuiet({ to })} />
              <Toggle checked={quiet.enabled} ariaLabel="Тихие часы" onChange={(enabled) => setQuiet({ enabled })} />
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px' }}>
          <button
            type="button"
            className="kb-btn kb-ghost"
            onClick={() => void sendTest()}
            disabled={test.kind === 'sending'}
            style={{
              minHeight: 44,
              padding: '0 16px',
              fontSize: 14,
              borderRadius: 6,
              ...(test.kind === 'sent' ? { color: '#9CC49A', borderColor: 'rgba(156,196,154,0.45)' } : {}),
              ...(test.kind === 'failed' ? { color: '#D9A35B', borderColor: 'rgba(217,163,91,0.45)' } : {}),
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M21 3L10 14M21 3l-7 18-4-7-7-4z" /></svg>
            {testLabel}
          </button>
          <span className="kb-m" style={{ fontSize: 10.5, color: '#948C7E' }}>
            {quiet.enabled ? `тихие часы ${quiet.from}–${quiet.to}` : 'тихих часов нет'} · срочное «нужно подтверждение» приходит всегда
          </span>
        </div>
      </SettingsBlock>
    </div>
  );
}
