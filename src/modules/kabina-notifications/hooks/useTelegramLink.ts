import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch, readApiJson } from '@/shared/api';

/** Mirrors `TelegramLinkStatus` of `GET /api/notifications/telegram/status` (server/shared/types.ts). */
type TelegramLinkStatus = {
  configured: boolean;
  polling: boolean;
  botUsername: string | null;
  linked: boolean;
  linkSource: 'bot' | 'env' | null;
  chat: { username: string | null; title: string | null } | null;
  linkedAt: string | null;
};

/** Mirrors `TelegramLinkCode` of `POST /api/notifications/telegram/link`. */
type TelegramLinkCode = { code: string; url: string; botUsername: string; expiresAt: string };

/** While a code is out, the status is re-read this often until the chat is linked. */
const LINK_POLL_MS = 3_000;
const STATUS_URL = '/api/notifications/telegram/status';
const LINK_URL = '/api/notifications/telegram/link';
const TEST_URL = '/api/notifications/telegram/test';

/**
 * Used by TelegramLinkCard and the settings «Уведомления»: the bot's link status and the actions around it —
 * issue a one-time code (opening t.me in a new tab), wait for `/start` by
 * polling the status, unlink, and send the test message.
 */
export function useTelegramLink() {
  const [status, setStatus] = useState<TelegramLinkStatus | null>(null);
  const [pendingCode, setPendingCode] = useState<TelegramLinkCode | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Clock for the code's countdown: set when the code arrives, ticked every second after.
  const [now, setNow] = useState(0);
  // Ignore answers that land after unmount.
  const mountedRef = useRef(true);

  // Ticks the countdown while a code is out.
  useEffect(() => {
    if (!pendingCode) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pendingCode]);

  const refresh = useCallback((): Promise<TelegramLinkStatus | null> => authenticatedFetch(STATUS_URL)
    .then((response) => readApiJson<{ data: TelegramLinkStatus }>(response))
    .then((body) => {
      if (mountedRef.current) setStatus(body.data);
      return body.data;
    }, (requestError: unknown) => {
      if (mountedRef.current) setError(requestError instanceof Error ? requestError.message : 'Не удалось узнать статус Telegram');
      return null;
    }), []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // Waits for the /start: re-reads the status until the chat is linked.
  useEffect(() => {
    if (!pendingCode) return undefined;
    const timer = window.setInterval(() => {
      void refresh().then((next) => {
        if (next?.linked && next.linkSource === 'bot' && mountedRef.current) setPendingCode(null);
      });
    }, LINK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pendingCode, refresh]);

  const startLink = useCallback(async () => {
    setError(null);
    setIsBusy(true);
    // Opened inside the click so popup blockers allow it; pointed at t.me once the code is in.
    const telegramTab = window.open('', '_blank');
    try {
      const body = await readApiJson<{ data: TelegramLinkCode }>(await authenticatedFetch(LINK_URL, { method: 'POST' }));
      if (!mountedRef.current) return;
      setNow(Date.now());
      setPendingCode(body.data);
      if (telegramTab) {
        telegramTab.opener = null;
        telegramTab.location.href = body.data.url;
      }
    } catch (requestError) {
      telegramTab?.close();
      if (mountedRef.current) setError(requestError instanceof Error ? requestError.message : 'Не удалось получить код');
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }, []);

  const cancelLink = useCallback(() => {
    setPendingCode(null);
  }, []);

  const unlink = useCallback(async () => {
    setError(null);
    setIsBusy(true);
    try {
      await readApiJson(await authenticatedFetch(LINK_URL, { method: 'DELETE' }));
      await refresh();
    } catch (requestError) {
      if (mountedRef.current) setError(requestError instanceof Error ? requestError.message : 'Не удалось отвязать');
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }, [refresh]);

  /**
   * «Прислать тестовое»: a real bot message to the linked chat. Resolves true when
   * Telegram took it; on failure the server's reason lands in `error`.
   */
  const sendTest = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      await readApiJson(await authenticatedFetch(TEST_URL, { method: 'POST' }));
      return true;
    } catch (requestError) {
      if (mountedRef.current) setError(requestError instanceof Error ? requestError.message : 'Telegram не ответил');
      return false;
    }
  }, []);

  const secondsLeft = pendingCode ? Math.max(0, Math.ceil((Date.parse(pendingCode.expiresAt) - now) / 1_000)) : 0;

  return { status, pendingCode, secondsLeft, isBusy, error, startLink, cancelLink, unlink, sendTest };
}
