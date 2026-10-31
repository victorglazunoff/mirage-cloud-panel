import { createHash, randomBytes } from 'node:crypto';

import type { TelegramLinkRow } from '@/modules/database/index.js';
import type { TelegramChat, TelegramLinkCode, TelegramTargetChat } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** A link code is good for 15 minutes and for one `/start` only. */
const LINK_CODE_TTL_MS = 15 * 60_000;
/** 16 random bytes = 128 bits, base64url → 22 characters, inside the deep-link alphabet. */
const LINK_CODE_BYTES = 16;

/** Bot replies. Texts follow DarkStates N1 / DarkSettings 04 (bot «Мираж», only you). */
export const TELEGRAM_REPLY = {
  linked: 'Привязано. Сюда будут приходить уведомления панели Mirage: нужно решение, ход закончен, фон, лимиты. '
    + 'Что присылать — Настройки панели → Уведомления.',
  needCode: 'Пришли код привязки: Настройки панели → Уведомления → Привязать Telegram. '
    + 'Кнопка откроет этот чат с кодом — останется нажать «Старт».',
  codeRejected: 'Код не подошёл: он одноразовый и живёт 15 минут. '
    + 'Получи новый: Настройки панели → Уведомления → Привязать Telegram.',
  alreadyLinked: 'Этот чат уже привязан к панели Mirage. Отвязать — Настройки панели → Уведомления.',
  noAccess: 'Нет доступа. Этот бот отвечает только владельцу панели Mirage.',
} as const;

type TelegramLinkStore = {
  getLink(): TelegramLinkRow | null;
  saveLink(link: TelegramLinkRow): void;
  clearLink(): boolean;
  createCode(codeHash: string, createdAtMs: number, expiresAtMs: number): void;
  consumeCode(codeHash: string, nowMs: number): boolean;
  clearCodes(): void;
};

type TelegramLinkDependencies = {
  store: TelegramLinkStore;
  /** `MIRAGE_TELEGRAM_CHAT_ID`: used only while no chat is linked through the bot. */
  fallbackChatId: string | null;
  now(): number;
  generateCode?(): string;
};

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function describeChatTitle(chat: TelegramChat): string | null {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
  return name || null;
}

/** Reads the start parameter of `/start <code>` (also `/start@bot <code>`); null for any other text. */
function parseStartCommand(text: string | undefined): { code: string | null } | null {
  const match = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec((text ?? '').trim());
  if (!match) return null;
  return { code: match[1] ?? null };
}

/**
 * Linking the bot to the owner's chat: one-time codes issued from the
 * settings screen, redeemed by `/start <code>` in the bot chat, and the
 * resolved target chat. Used by the Telegram notifications service.
 */
export function createTelegramLinkService(dependencies: TelegramLinkDependencies) {
  const { store } = dependencies;
  const generateCode = dependencies.generateCode ?? (() => randomBytes(LINK_CODE_BYTES).toString('base64url'));

  const resolveTargetChat = (): TelegramTargetChat | null => {
    const link = store.getLink();
    if (link) {
      return { chatId: link.chat_id, source: 'bot', username: link.chat_username, title: link.chat_title, linkedAt: link.linked_at };
    }
    if (dependencies.fallbackChatId) {
      return { chatId: dependencies.fallbackChatId, source: 'env', username: null, title: null, linkedAt: null };
    }
    return null;
  };

  return {
    resolveTargetChat,

    /**
     * Issues a fresh one-time code. Refused while a chat is linked through the
     * bot: re-linking goes through «Отвязать» first, so a leaked code can
     * never move notifications to someone else's chat.
     */
    issueCode(botUsername: string): TelegramLinkCode {
      if (store.getLink()) {
        throw new AppError('Telegram уже привязан — сначала отвяжи его', { code: 'TELEGRAM_ALREADY_LINKED', statusCode: 409 });
      }
      const nowMs = dependencies.now();
      const code = generateCode();
      const expiresAtMs = nowMs + LINK_CODE_TTL_MS;
      store.createCode(hashCode(code), nowMs, expiresAtMs);
      return {
        code,
        url: `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(code)}`,
        botUsername,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    /** Forgets the linked chat and voids outstanding codes; returns whether a chat was linked. */
    unlink(): boolean {
      store.clearCodes();
      return store.clearLink();
    },

    /**
     * Answers a text message sent to the bot. Returns the reply to send, or
     * null to stay silent (group chats, the owner chatting with the bot).
     *
     * - A chat is linked: the owner's chat hears «already linked» on /start,
     *   everyone else hears «нет доступа» whatever they send.
     * - Nothing is linked yet: `/start <valid code>` from a private chat links
     *   it; anything else gets the «пришли код» hint.
     */
    handleMessage(chat: TelegramChat, text: string | undefined): string | null {
      if (chat.type !== 'private') {
        return null;
      }
      const chatId = String(chat.id);
      const start = parseStartCommand(text);
      const link = store.getLink();
      if (link) {
        if (link.chat_id !== chatId) return TELEGRAM_REPLY.noAccess;
        return start ? TELEGRAM_REPLY.alreadyLinked : null;
      }
      if (!start) {
        return TELEGRAM_REPLY.needCode;
      }
      if (!start.code) {
        return TELEGRAM_REPLY.needCode;
      }
      const nowMs = dependencies.now();
      if (!store.consumeCode(hashCode(start.code), nowMs)) {
        return TELEGRAM_REPLY.codeRejected;
      }
      store.saveLink({
        chat_id: chatId,
        chat_username: chat.username ?? null,
        chat_title: describeChatTitle(chat),
        linked_at: new Date(nowMs).toISOString(),
      });
      store.clearCodes();
      return TELEGRAM_REPLY.linked;
    },
  };
}

/** The link service's shape, for the notifications service that wires it. */
export type TelegramLinkService = ReturnType<typeof createTelegramLinkService>;
