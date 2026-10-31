import { getConnection } from '@/modules/database/connection.js';

/** The linked Telegram chat, exactly as the single-row `telegram_link` table holds it. */
export type TelegramLinkRow = {
  chat_id: string;
  chat_username: string | null;
  chat_title: string | null;
  linked_at: string;
};

/**
 * Mirage Telegram bot persistence: the one linked chat and the one-time link
 * codes (stored as hashes only). Used by the notifications module's Telegram
 * link service; nothing else reads these tables.
 */
export const telegramLinkDb = {
  /** Returns the linked chat, or null when the bot is not linked yet. */
  getLink(): TelegramLinkRow | null {
    const row = getConnection()
      .prepare('SELECT chat_id, chat_username, chat_title, linked_at FROM telegram_link WHERE id = 1')
      .get() as TelegramLinkRow | undefined;
    return row ?? null;
  },

  /** Replaces the linked chat (there is only ever one). */
  saveLink(link: TelegramLinkRow): void {
    getConnection()
      .prepare(`
        INSERT INTO telegram_link (id, chat_id, chat_username, chat_title, linked_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          chat_id = excluded.chat_id,
          chat_username = excluded.chat_username,
          chat_title = excluded.chat_title,
          linked_at = excluded.linked_at
      `)
      .run(link.chat_id, link.chat_username, link.chat_title, link.linked_at);
  },

  /** Forgets the linked chat; returns whether one was linked. */
  clearLink(): boolean {
    return getConnection().prepare('DELETE FROM telegram_link WHERE id = 1').run().changes > 0;
  },

  /** Stores a new code hash; expired and used codes are purged on the way. */
  createCode(codeHash: string, createdAtMs: number, expiresAtMs: number): void {
    const db = getConnection();
    db.prepare('DELETE FROM telegram_link_codes WHERE expires_at <= ? OR used_at IS NOT NULL').run(createdAtMs);
    db.prepare('INSERT INTO telegram_link_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(codeHash, createdAtMs, expiresAtMs);
  },

  /**
   * Marks a code used if it exists, is unused and has not expired. One
   * conditional UPDATE, so two racing `/start` messages cannot both win.
   */
  consumeCode(codeHash: string, nowMs: number): boolean {
    return getConnection()
      .prepare('UPDATE telegram_link_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(nowMs, codeHash, nowMs).changes === 1;
  },

  /** Voids every outstanding code (after a successful link or an unlink). */
  clearCodes(): void {
    getConnection().prepare('DELETE FROM telegram_link_codes').run();
  },
};
