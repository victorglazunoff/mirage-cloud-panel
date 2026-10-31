import type { MirageSettings, MirageWidgetId } from '@/shared/types';

type WidgetSetting = MirageSettings['home']['widgets'][number];

/** The widgets the home screen can draw today; «Заявки», «Сервер» and «Кнопки выкладки» have no block yet. */
export type HomeWidgetId = Extract<MirageWidgetId, 'fav' | 'work' | 'cal' | 'lim'>;

const DRAWN: ReadonlyArray<HomeWidgetId> = ['fav', 'work', 'cal', 'lim'];
/** Wide blocks live in the left column of the desktop layout, narrow ones in the right. */
const MAIN_COLUMN: ReadonlyArray<HomeWidgetId> = ['fav', 'work'];

/** Settings default (server `DEFAULT_WIDGETS_ON`), used until `/api/mirage-settings` answers or when it fails. */
export const DEFAULT_HOME_WIDGETS: WidgetSetting[] = [
  { id: 'fav', enabled: true },
  { id: 'work', enabled: true },
  { id: 'cal', enabled: true },
  { id: 'lim', enabled: true },
];

/** One block on the home screen with its «01 /» number. */
export type HomeWidgetSlot = { id: HomeWidgetId; index: string };

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * Used by HomeScreen: DarkSettings 03 «Главный экран» applied to the layout.
 * Enabled widgets keep the order of the settings (top to bottom); the phone
 * gets one column, the desktop splits them into the main column (favourites,
 * work) and the side column (calendar, limits), each in settings order. The
 * log («бортовой журнал») is not a setting and always closes the main column.
 * Without the limits counter (`limitsEnabled` false) the «Лимиты» block is left
 * out and the numbers close up.
 */
export function layoutHomeWidgets(widgets: WidgetSetting[] | null | undefined, isPhone: boolean, limitsEnabled = true) {
  const source = widgets && widgets.length ? widgets : DEFAULT_HOME_WIDGETS;
  const seen = new Set<string>();
  const order = source
    .filter((widget) => limitsEnabled || widget.id !== 'lim')
    .filter((widget) => widget.enabled && DRAWN.includes(widget.id as HomeWidgetId) && !seen.has(widget.id) && seen.add(widget.id))
    .map((widget) => widget.id as HomeWidgetId);

  if (isPhone) {
    // The phone has no activity list: «В работе» is the «ждёт тебя» card — urgent, so it stays right
    // under the summary (DarkPhoneMain) and carries no number; the rest follow the settings order.
    let counter = 0;
    const column: HomeWidgetSlot[] = [
      ...(order.includes('work') ? [{ id: 'work' as const, index: '' }] : []),
      ...order.filter((id) => id !== 'work').map((id): HomeWidgetSlot => ({ id, index: pad2(++counter) })),
    ];
    return { column, main: [] as HomeWidgetSlot[], aside: [] as HomeWidgetSlot[], logIndex: null as string | null };
  }

  // Numbers run in reading order, as in DarkMain: the main column (with the log last), then the side column.
  let counter = 0;
  const main = order.filter((id) => MAIN_COLUMN.includes(id)).map((id): HomeWidgetSlot => ({ id, index: pad2(++counter) }));
  const logIndex = pad2(++counter);
  const aside = order.filter((id) => !MAIN_COLUMN.includes(id)).map((id): HomeWidgetSlot => ({ id, index: pad2(++counter) }));
  return { column: [] as HomeWidgetSlot[], main, aside, logIndex: logIndex as string | null };
}
