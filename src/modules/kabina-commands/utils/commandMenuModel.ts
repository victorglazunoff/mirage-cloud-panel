import type { CommandCatalogEntry, CommandCatalogGroupId, CommandCatalogResponse } from '@/shared/types';

/** Group captions of DarkCommands, in menu order (the catalog's own labels are sentence case). */
export const MENU_GROUP_LABELS: Record<CommandCatalogGroupId, string> = {
  session: 'СЕССИЯ',
  context: 'КОНТЕКСТ И СТОИМОСТЬ',
  model: 'МОДЕЛЬ И РЕЖИМЫ',
  agents: 'АГЕНТЫ И ВОРКФЛОУ',
  tools: 'ИНСТРУМЕНТЫ',
  project: 'ПРОЕКТ И ПАМЯТЬ',
  account: 'АККАУНТ И ПАНЕЛЬ',
  mine: 'МОИ · НАВЫКИ',
};

const GROUP_ORDER: CommandCatalogGroupId[] = ['session', 'context', 'model', 'agents', 'tools', 'project', 'account', 'mine'];

/** What the preview shows under the description: the context bar, a radio list, or facts. */
export type CommandSpecial = 'context' | 'cost' | 'usage' | 'model' | 'effort' | 'skill' | null;

/** Hand-written preview texts of DarkCommands for the commands that deserve more than one line. */
export const COMMAND_DETAILS: Record<string, { what: string; example?: string; args?: Array<{ a: string; d: string }>; special?: CommandSpecial }> = {
  '/context': {
    what: 'Покажет, чем занято окно: системный промпт, инструменты и MCP, память, навыки и сама беседа. Подскажет, что выкинуть и когда сжать.',
    example: '/context',
    special: 'context',
  },
  '/compact': {
    what: 'Сожмёт беседу в сводку и освободит контекст. Идущий ход не прерывается: сжатие встанет после текущего шага.',
    args: [{ a: 'инструкция', d: 'что сохранить обязательно' }],
    example: '/compact оставь решения по ценам и список правок',
    special: 'context',
  },
  '/autocompact': {
    what: 'Задаёт, на каком заполнении контекста Claude сожмёт беседу сам. Отметка видна на полосе.',
    args: [{ a: 'auto', d: 'порог по умолчанию' }, { a: 'число', d: 'свой порог в токенах, например 170000' }],
    example: '/autocompact 170000',
    special: 'context',
  },
  '/cost': {
    what: 'Токены и деньги по этой сессии. В ленту не попадает и ход не трогает.',
    example: '/cost',
    special: 'cost',
  },
  '/usage': {
    what: 'Сколько осталось по плану: неделя и облачные кредиты.',
    example: '/usage',
    special: 'usage',
  },
  '/model': {
    what: 'Переключит модель со следующего хода. Набранный текст и очередь сообщений не потеряются.',
    args: [{ a: 'модель', d: 'opus, sonnet, haiku или полный id' }],
    example: '/model sonnet',
    special: 'model',
  },
  '/effort': {
    what: 'Сколько Claude думает над ходом. Выше — точнее и дольше; ultracode включает воркфлоу.',
    args: [{ a: 'уровень', d: 'low, medium, high, xhigh, max, ultracode' }],
    example: '/effort xhigh',
    special: 'effort',
  },
  '/copy': { what: 'Скопирует ответ Claude в буфер. Без аргумента — последний.', args: [{ a: 'N', d: 'какой по счёту с конца' }], example: '/copy 2' },
  '/review': { what: 'Проверит текущий дифф на ошибки. Результат придёт обычным ответом, правки — только по твоей команде.', example: '/review' },
  '/config': { what: 'Откроет настройки: панель и settings.json Claude рядом, с подсказкой, где что лежит.', example: '/config' },
  '/rewind': { what: 'Покажет сообщения беседы — выбери, к какому вернуться. Откатит и беседу, и правки файлов по чекпоинтам.', example: '/rewind' },
  '/clear': { what: 'Начнёт новый диалог с пустым контекстом. Этот останется в списке — к нему можно вернуться.', example: '/clear' },
  '/btw': { what: 'Спросит сбоку: ответ придёт, но в беседу не запишется и ход не прервёт.', example: '/btw какой порт у стенда?' },
};

/** Russian Claude Code-style args hint split into named arguments. Exported for tests. */
export function parseArgs(args: string): Array<{ a: string; d: string }> {
  const out: Array<{ a: string; d: string }> = [];
  const pattern = /([[<])([^\]>]+)[\]>]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) {
    out.push({ a: match[2], d: match[1] === '<' ? 'обязательный' : 'необязательный' });
  }
  return out;
}

/** True when the command cannot run without an argument (`<задача>`): Enter completes instead. */
export function needsArgument(entry: CommandCatalogEntry): boolean {
  return entry.args.includes('<');
}

/** Which preview block a command gets. */
export function commandSpecial(entry: CommandCatalogEntry): CommandSpecial {
  const detail = COMMAND_DETAILS[entry.name];
  if (detail?.special) return detail.special;
  return entry.group === 'mine' || entry.execution === 'skill' ? 'skill' : null;
}

/** The filter word: what follows the leading «/» up to the first space, lower-cased. */
export function menuTerm(query: string): string {
  return query.replace(/^\s*\//, '').replace(/^\s+/, '').split(/\s/)[0].toLowerCase();
}

/** One visible group of the menu. */
export type MenuGroup = { id: CommandCatalogGroupId; label: string; commands: CommandCatalogEntry[] };

/**
 * Filters the catalog by name, description and args and keeps the menu's group order;
 * within a group names that start with the term come first. Exported for tests.
 */
export function filterCatalog(catalog: CommandCatalogResponse | null, term: string): MenuGroup[] {
  if (!catalog) return [];
  const needle = term.toLowerCase();
  const matches = (entry: CommandCatalogEntry) => !needle
    || entry.name.slice(1).toLowerCase().includes(needle)
    || entry.description.toLowerCase().includes(needle)
    || entry.args.toLowerCase().includes(needle);
  return GROUP_ORDER.map((id) => {
    const commands = catalog.commands.filter((entry) => entry.group === id && matches(entry));
    if (needle) {
      commands.sort((a, b) => Number(b.name.slice(1).toLowerCase().startsWith(needle)) - Number(a.name.slice(1).toLowerCase().startsWith(needle)));
    }
    return { id, label: MENU_GROUP_LABELS[id], commands };
  }).filter((group) => group.commands.length > 0);
}

/** `104400` → `104,4k`, `1900000` → `1,9M` (DarkCommands context bar). */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace('.', ',').replace(/,0$/, '')}k`;
  return `${(value / 1_000_000).toFixed(1).replace('.', ',').replace(/,0$/, '')}M`;
}

/** Russian names of the SDK context categories. */
export const CONTEXT_CATEGORY_NAMES: Record<string, string> = {
  messages: 'Беседа',
  mcp_tools: 'Инструменты MCP',
  system_tools: 'Инструменты',
  system_prompt: 'Системный промпт',
  memory_files: 'Память · CLAUDE.md',
  skills: 'Навыки',
  custom_agents: 'Агенты',
};
