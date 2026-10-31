import { toPanelWall } from '@/modules/kabina';
import { getServerHomeDir, pluralRu, splitMatch, tildePath } from '@/shared/utils';
import type { CommandCatalogEntry, MatchParts, SearchResponse, SearchResultItem, SearchResultType } from '@/shared/types';

/** Tab of the ⌘K screen: everything, or one result type (DarkSearch «Где искать»). */
export type SearchScope = 'all' | SearchResultType;

/** Row kinds: the five result types plus the closing «Спросить Claude» row. */
export type SearchRowKind = SearchResultType | 'ask';

/** Status shape of a project row and preview: working, waiting for the user, quiet. */
export type ProjectLiveState = 'run' | 'wait' | 'idle';

/** One rendered row of the results list. */
export type SearchRow = {
  key: string;
  kind: SearchRowKind;
  title: MatchParts;
  sub: MatchParts;
  meta: string;
  /** Project chip next to a dialog title. */
  projectChip: string | null;
  led: ProjectLiveState | null;
  item: SearchResultItem | null;
};

/** One labelled group of rows; `more` is how many matches the group hides behind «ещё N →». */
export type SearchRowGroup = {
  id: SearchRowKind;
  label: string;
  rows: SearchRow[];
  count: number;
  more: number;
};

/** Order, tab names, group captions and the «Всё» limits of DarkSearch. */
export const SEARCH_GROUPS: Array<{ type: SearchResultType; tab: string; label: string; limit: number }> = [
  { type: 'project', tab: 'Проекты', label: 'ПРОЕКТЫ', limit: 3 },
  { type: 'session', tab: 'Диалоги', label: 'ДИАЛОГИ · ВСЕ ПРОЕКТЫ', limit: 4 },
  { type: 'file', tab: 'Файлы', label: 'ФАЙЛЫ', limit: 3 },
  { type: 'command', tab: 'Команды', label: 'КОМАНДЫ', limit: 3 },
  { type: 'action', tab: 'Действия', label: 'ДЕЙСТВИЯ', limit: 3 },
];

/** Tab order for Tab / Shift+Tab. */
export const SEARCH_SCOPES: SearchScope[] = ['all', ...SEARCH_GROUPS.map((group) => group.type)];

/** What a panel action does, for its row note and preview (actions come from the server by `actionId`). */
export const ACTION_INFO: Record<string, { note: string; what: string; steps: string[] }> = {
  new_session: {
    note: 'Claude откроет проект и спросит задачу',
    what: 'Открою новый диалог в проекте и подставлю запрос в поле ввода — останется дописать и отправить.',
    steps: ['Откроется чат проекта', 'В поле ввода — твой запрос, можно дописать', 'Модель и права — как в проекте'],
  },
  open_calendar: {
    note: 'звонки, встречи и отложенные сообщения',
    what: 'Календарь звонков и сообщений клиентам и отложенных сообщений Claude.',
    steps: ['Откроется календарь на сегодня', 'События и отложенные сообщения — по часам', 'Новое событие — кнопкой или голосом'],
  },
  compact_session: {
    note: '/compact · текущий диалог',
    what: 'Сожму беседу открытого диалога в сводку. Идущий ход не прервётся — сжатие встанет после текущего шага.',
    steps: ['Встанет после текущего шага', 'Решения и список правок сохранятся', 'Можно дописать инструкцию в /compact'],
  },
  open_agents: {
    note: 'кто работает прямо сейчас',
    what: 'Экран агентов: фоновые задачи, субагенты и воркфлоу всех диалогов.',
    steps: ['Откроется экран агентов', 'Видно, кто работает и кто ждёт тебя', 'Остановить или разрешить — там же'],
  },
  open_files: {
    note: 'файлы проектов на сервере',
    what: 'Файлы проектов на сервере: дерево, просмотр и правка.',
    steps: ['Откроется экран файлов', 'Слева — проекты и папки', 'Файл можно упомянуть @ в чате'],
  },
  open_projects: {
    note: 'все проекты и мастер нового',
    what: 'Все проекты: избранное, архив и мастер нового проекта из папки на сервере.',
    steps: ['Откроется список проектов', 'Звёздочка — в избранное на главный', 'Новый проект — из папки на сервере'],
  },
  open_settings: {
    note: 'Claude, режимы, пароль и уведомления',
    what: 'Настройки панели и Claude: пароль и вход по коду, режимы, голос, уведомления.',
    steps: ['Откроются настройки', 'Слева — разделы', 'Изменения сохраняются сразу'],
  },
  show_usage: {
    note: 'неделя и облачные кредиты',
    what: 'Лимиты тарифа на главном экране: неделя и облачные кредиты.',
    steps: ['Откроется главный экран', 'Приборы лимитов — справа', 'Обновляются раз в минуту'],
  },
  voice_input: {
    note: 'или удерживай ⌥ Пробел',
    what: 'Скажи задачу голосом — Claude разберёт её в действия: событие, задачу проекту или сообщение.',
    steps: ['Откроется голосовой ввод', 'Говори, пока держишь кнопку', 'Проверь карточки «Понял» и подтверди'],
  },
  toggle_theme: {
    note: 'тёмная «Кабина» · светлая — скоро',
    what: 'Сейчас у панели одна тема — тёмная «Кабина». Светлая появится позже.',
    steps: ['Тема не переключится', 'Светлая — в настройках, когда будет готова'],
  },
};

/** `<home>/x/y` → `~/x/y` (the server user's home); other paths unchanged. */
export function shortenHome(path: string | null | undefined, home: string | null = getServerHomeDir()): string {
  if (!path) return '';
  return tildePath(path, home);
}

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Short time of a message as DarkSearch shows it: `14:31` today, `вчера`, `пт` this week, else `24 окт`. */
export function shortWhen(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const date = toPanelWall(instant);
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(toPanelWall(now)) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (days === 1) return 'вчера';
  if (days < 7) return WEEKDAYS[date.getDay()];
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** The snippet as «…» with the server's match offsets kept (the quotes shift them by one). */
function snippetParts(item: SearchResultItem, query: string): MatchParts {
  const snippet = item.snippet;
  if (!snippet) return splitMatch(item.subtitle ?? '', query);
  const { text, matchStart, matchEnd } = snippet;
  if (matchStart >= 0 && matchEnd > matchStart && matchEnd <= text.length) {
    // Like the mock-up: a long lead-in is cut so the match stays inside the one-line row.
    const lead = text.slice(0, matchStart);
    const before = lead.length > 36 ? `…${lead.slice(-28).trimStart()}` : lead;
    return { before: `«${before}`, match: text.slice(matchStart, matchEnd), after: `${text.slice(matchEnd)}»` };
  }
  return splitMatch(`«${text}»`, query);
}

/** Relative path of a file hit inside its project, prefixed with the project folder (`demo-villa/docs/a.md`). */
export function fileDisplayPath(item: SearchResultItem, projectPath: string | null): string {
  const full = item.path ?? item.title;
  if (projectPath && full.startsWith(`${projectPath}/`)) {
    const folder = projectPath.split('/').filter(Boolean).pop() ?? '';
    return `${folder}/${full.slice(projectPath.length + 1)}`;
  }
  return shortenHome(full);
}

type RowContext = {
  query: string;
  projectPaths: Map<string, string>;
  liveByProject: Map<string, ProjectLiveState>;
  catalogById: Map<string, CommandCatalogEntry>;
};

const LIVE_META: Record<ProjectLiveState, string> = { run: 'Работает', wait: 'Ждёт тебя', idle: 'Тихо' };

/** Turns one API hit into a row. Exported for tests. */
/**
 * Project folder as the other Kabina screens write it: `Проекты/site-2` for a project
 * deep under the home (its folder and the one holding it), `~/demo-site` near the home.
 */
export function shortProjectPath(path: string | null | undefined, home: string | null = getServerHomeDir()): string {
  if (!path) return '';
  const tilde = shortenHome(path, home);
  const parts = path.split('/').filter(Boolean);
  if (tilde === '~' || (tilde.startsWith('~/') && tilde.split('/').length <= 3)) return tilde;
  return parts.length >= 2 ? parts.slice(-2).join('/') : path;
}

export function toRow(item: SearchResultItem, context: RowContext): SearchRow {
  const { query } = context;
  const base: SearchRow = {
    key: `${item.type}:${item.id}`,
    kind: item.type,
    title: splitMatch(item.title, query),
    sub: splitMatch(item.subtitle ?? '', query),
    meta: '',
    projectChip: null,
    led: null,
    item,
  };
  switch (item.type) {
    case 'project': {
      const live = (item.projectId && context.liveByProject.get(item.projectId)) || 'idle';
      return { ...base, sub: splitMatch(shortProjectPath(item.path), query), meta: LIVE_META[live], led: live };
    }
    case 'session':
      return {
        ...base,
        sub: snippetParts(item, query),
        // One date per dialog everywhere: its last activity, as the chat list shows it.
        meta: shortWhen(item.lastActivity ?? item.timestamp),
        projectChip: item.projectName ?? item.subtitle ?? null,
      };
    case 'file': {
      const projectPath = item.projectId ? context.projectPaths.get(item.projectId) ?? null : null;
      return { ...base, title: splitMatch(fileDisplayPath(item, projectPath), query), sub: splitMatch(item.projectName ?? '', query) };
    }
    case 'command': {
      const entry = context.catalogById.get(item.id);
      return { ...base, meta: entry?.execution === 'skill' || entry?.source === 'skill' ? 'навык' : '' };
    }
    case 'action': {
      const info = item.actionId ? ACTION_INFO[item.actionId] : undefined;
      return { ...base, sub: splitMatch(info?.note ?? '', query) };
    }
    default:
      return base;
  }
}

/** The closing «Спросить Claude» row: always last, ⌘↵ from anywhere. */
export function askRow(query: string): SearchRow {
  const trimmed = query.trim();
  return {
    key: 'ask',
    kind: 'ask',
    title: { before: trimmed ? `Спросить Claude: «${trimmed}»` : 'Спросить Claude…', match: '', after: '' },
    sub: { before: 'главный ассистент · по смыслу во всех проектах', match: '', after: '' },
    meta: '⌘↵',
    projectChip: null,
    led: null,
    item: null,
  };
}

/**
 * Builds the visible groups for a scope: in «Всё» each group is cut to its DarkSearch limit
 * and offers «ещё N →»; a single tab shows everything the server returned. The ask row
 * closes every list. Exported for tests and KabinaSearch.
 */
export function buildGroups(response: SearchResponse | null, scope: SearchScope, context: RowContext): SearchRowGroup[] {
  const groups: SearchRowGroup[] = [];
  for (const definition of SEARCH_GROUPS) {
    if (scope !== 'all' && scope !== definition.type) continue;
    const group = response?.groups.find((candidate) => candidate.type === definition.type);
    if (!group || group.items.length === 0) continue;
    const limit = scope === 'all' ? definition.limit : group.items.length;
    const rows = group.items.slice(0, limit).map((item) => toRow(item, context));
    groups.push({ id: definition.type, label: definition.label, rows, count: group.count, more: Math.max(0, group.count - rows.length) });
  }
  groups.push({ id: 'ask', label: 'CLAUDE', rows: [askRow(context.query)], count: 1, more: 0 });
  return groups;
}

/** Counter for a tab: the server's match count of that type, or the total for «Всё». */
export function scopeCount(response: SearchResponse | null, scope: SearchScope): number {
  if (!response) return 0;
  if (scope === 'all') return response.total;
  return response.groups.find((group) => group.type === scope)?.count ?? 0;
}

/** «12 совпадений» next to the input, «недавнее» while it is empty. */
export function countLabel(query: string, total: number): string {
  if (!query.trim()) return 'недавнее';
  return `${total} ${pluralRu(total, ['совпадение', 'совпадения', 'совпадений'])}`;
}
