// «Уведомления» of the Kabina settings screen: the Telegram bot channel row.
export { TelegramLinkCard, TelegramLinkCardView } from '@/modules/kabina-notifications/TelegramLinkCard';
export type { TelegramLink } from '@/modules/kabina-notifications/TelegramLinkCard';
// useTelegramLink: the settings section (link state for the row and «Прислать тестовое»)
// and the calendar («пришлю в Telegram за N мин» only when a chat is linked).
export { useTelegramLink } from '@/modules/kabina-notifications/hooks/useTelegramLink';
