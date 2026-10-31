import type { ReactNode } from 'react';

import { useTelegramLink } from '@/modules/kabina-notifications/hooks/useTelegramLink';
import { Button, Panel, StatusShape, Toggle } from '@/modules/kabina';
import { cn } from '@/shared/utils';

import '@/modules/kabina-notifications/kabinaNotifications.css';

/** The link state and actions of `useTelegramLink`, shared by the card and the settings section around it. */
export type TelegramLink = ReturnType<typeof useTelegramLink>;

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

type TelegramLinkCardViewProps = {
  link: TelegramLink;
  className?: string;
  /**
   * Inside the settings plate (DarkSettings 04.1): a plain row among the other
   * channels instead of a framed panel.
   */
  bare?: boolean;
  /** The channel switch («писать в Telegram») at the end of the row. */
  channel?: { checked: boolean; onChange: (next: boolean) => void };
};

/**
 * Used by the Kabina settings screen («Уведомления → Куда писать») with its own
 * `useTelegramLink`, so «Прислать тестовое» knows whether a chat is linked: the
 * Telegram channel row of DarkSettings 04.1 — the TG mark, the bot's state, its
 * one action and the channel switch. States: bot not configured on the server ·
 * «Привязать Telegram» (one-time code, t.me opens in a new tab, countdown,
 * waits for /start) · «Привязан @username · Отвязать».
 */
export function TelegramLinkCardView({ link, className, bare = false, channel }: TelegramLinkCardViewProps) {
  const { status, pendingCode, secondsLeft, isBusy, error, startLink, cancelLink, unlink } = link;
  const codeExpired = Boolean(pendingCode) && secondsLeft === 0;

  const linkedByBot = Boolean(status?.linked && status.linkSource === 'bot');
  const chatName = status?.chat?.username ? `@${status.chat.username}` : (status?.chat?.title ?? 'чат');
  const linked = Boolean(status?.configured && status.linked);
  // Without a bot or a chat nothing can go out: the switch is off and locked, whatever was saved.
  const channelOn = Boolean(channel?.checked) && linked;
  // DarkSettings: the mark glows when the channel is on (like the plugins' marks).
  const live = linked && (channel ? channel.checked : true);

  let sub: string;
  let led: 'ok' | 'idle' | 'wait' | 'warn' = 'idle';
  if (!status) {
    sub = 'Проверяю…';
  } else if (!status.configured) {
    sub = 'Не подключено · бот не настроен на сервере';
  } else if (linkedByBot) {
    sub = `Привязан ${chatName}${status.botUsername ? ` · бот @${status.botUsername}` : ''}`;
    led = live ? 'ok' : 'idle';
  } else if (pendingCode && !codeExpired) {
    sub = 'Открой ссылку в Telegram и нажми «Старт»';
    led = 'wait';
  } else if (pendingCode && codeExpired) {
    sub = 'Код истёк — получи новый';
    led = 'warn';
  } else if (status.linked) {
    sub = 'Чат задан на сервере · привяжи свой через бота';
    led = live ? 'ok' : 'idle';
  } else {
    sub = 'Не подключено · привяжи чат, и бот начнёт писать';
  }

  const content: ReactNode = (
    <>
      <div className="kb-tgl-row">
        <span className={cn('kb-tgl-mono kb-m', live && 'is-live')} aria-hidden="true">TG</span>
        <div className="kb-tgl-text">
          <span className="kb-tgl-name">Telegram</span>
          <span className="kb-tgl-sub" data-tone={led}>
            <StatusShape kind={led} className="kb-tgl-led" />
            <span>{sub}</span>
          </span>
        </div>
        {status?.configured && linkedByBot && (
          <Button variant="ghost" className="kb-tgl-action" disabled={isBusy} onClick={() => void unlink()}>
            Отвязать
          </Button>
        )}
        {status?.configured && !linkedByBot && (!pendingCode || codeExpired) && (
          <Button variant="ghost" className="kb-tgl-action" disabled={isBusy} onClick={() => void startLink()}>
            {codeExpired ? 'Новый код' : 'Привязать Telegram'}
          </Button>
        )}
        {channel && (
          <span className="kb-tgl-switch">
            <Toggle checked={channelOn} onChange={channel.onChange} ariaLabel="Telegram" disabled={!linked} />
          </span>
        )}
      </div>

      {pendingCode && !codeExpired && !linkedByBot && (
        <div className="kb-tgl-pending" role="status">
          <div className="kb-tgl-code">
            <span className="kb-m kb-tgl-label">КОД</span>
            <code className="kb-m kb-tgl-code-value">{pendingCode.code}</code>
            <span className="kb-m kb-tgl-timer" aria-label={`Код действует ещё ${formatCountdown(secondsLeft)}`}>
              {formatCountdown(secondsLeft)}
            </span>
          </div>
          <p className="kb-tgl-hint">
            Ссылка открылась в новой вкладке. Не открылась —{' '}
            <a href={pendingCode.url} target="_blank" rel="noopener noreferrer" className="kb-tgl-link">
              открой @{pendingCode.botUsername}
            </a>
            {' '}и отправь боту <span className="kb-m">/start {pendingCode.code}</span>.
          </p>
          {!status?.polling && (
            <p className="kb-tgl-hint" data-tone="warn">
              Сервер сейчас не принимает ответы бота (опрос выключен) — привязка не завершится.
            </p>
          )}
          <div>
            <Button variant="ghost" size="sm" onClick={cancelLink}>Отмена</Button>
          </div>
        </div>
      )}

      {error && <p className="kb-tgl-error" role="alert">{error}</p>}
    </>
  );

  if (bare) {
    return <section className={cn('kb-tgl', 'kb-tgl-bare', className)} aria-label="Telegram">{content}</section>;
  }
  return (
    <Panel as="section" corners={false} className={cn('kb-tgl', className)} aria-label="Telegram">
      {content}
    </Panel>
  );
}

/** A standalone Telegram card with its own link state (DarkStates and other places without a settings plate). */
export function TelegramLinkCard({ className }: { className?: string }) {
  const link = useTelegramLink();
  return <TelegramLinkCardView link={link} className={className} />;
}
