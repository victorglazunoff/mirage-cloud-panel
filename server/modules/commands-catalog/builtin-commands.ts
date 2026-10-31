import type { CommandCatalogGroupId } from '@/shared/types.js';

/** Built-in catalog row: [name, args, description (ru), group, shortcut, execution, panelAction]. */
type BuiltinRow = [
  name: string,
  args: string,
  description: string,
  group: Exclude<CommandCatalogGroupId, 'mine'>,
  shortcut: string | null,
  execution: 'sdk' | 'panel',
  panelAction: string | null,
];

/**
 * Display order and Russian labels of the catalog groups. Used by the catalog service to
 * build the grouped response and by nothing else.
 */
export const COMMAND_GROUP_LABELS: Array<{ id: CommandCatalogGroupId; label: string }> = [
  { id: 'session', label: 'Сессия' },
  { id: 'context', label: 'Контекст и стоимость' },
  { id: 'model', label: 'Модель и режимы' },
  { id: 'agents', label: 'Агенты и воркфлоу' },
  { id: 'tools', label: 'Инструменты' },
  { id: 'project', label: 'Проект и память' },
  { id: 'account', label: 'Аккаунт и панель' },
  { id: 'mine', label: 'Мои' },
];

/**
 * Slash commands of Claude Code that make sense in the web panel (
 * terminal-only commands are left out on purpose). `sdk` rows are sent to the Claude SDK
 * unchanged; `panel` rows are handled by the panel UI through `panelAction`.
 * Consumed by the catalog service only.
 */
export const BUILTIN_COMMAND_ROWS: BuiltinRow[] = [
  ['/clear', '[имя]', 'Начать новый диалог с пустым контекстом', 'session', null, 'panel', 'new_session'],
  ['/compact', '[инструкция]', 'Сжать контекст диалога, сохранив главное', 'session', null, 'sdk', null],
  ['/resume', '[сессия]', 'Продолжить один из прошлых диалогов', 'session', null, 'panel', 'open_sessions'],
  ['/rename', '[имя]', 'Переименовать текущий диалог', 'session', null, 'panel', 'rename_session'],
  ['/branch', '[имя]', 'Ответвить диалог от текущего места', 'session', null, 'panel', 'fork_session'],
  ['/rewind', '', 'Вернуть диалог и файлы к выбранному сообщению', 'session', null, 'panel', 'rewind'],
  ['/export', '[файл]', 'Выгрузить диалог в HTML', 'session', null, 'panel', 'export_session'],
  ['/copy', '[N]', 'Скопировать последний ответ Claude', 'session', null, 'panel', 'copy_last_reply'],
  ['/btw', '[вопрос]', 'Задать побочный вопрос, не записывая его в диалог', 'session', null, 'panel', 'side_question'],
  ['/background', '[задача]', 'Отправить диалог работать в фоне', 'session', null, 'panel', 'background_session'],
  ['/recap', '', 'Краткая сводка того, что сделано в диалоге', 'session', null, 'sdk', null],

  ['/context', '', 'Показать, чем занято окно контекста', 'context', null, 'panel', 'show_context'],
  ['/cost', '', 'Расход токенов и стоимость диалога', 'context', null, 'panel', 'show_cost'],
  ['/usage', '', 'Лимиты тарифа: неделя и кредиты', 'context', null, 'panel', 'show_usage'],
  ['/diff', '', 'Показать изменения файлов в рабочем дереве', 'context', null, 'panel', 'show_diff'],
  ['/autocompact', '[auto|число]', 'Порог автоматического сжатия контекста', 'context', null, 'panel', 'autocompact'],

  ['/model', '[модель]', 'Выбрать модель для диалога', 'model', 'Alt+P', 'panel', 'model_menu'],
  ['/effort', '[уровень]', 'Уровень усилия: low, medium, high, ultracode', 'model', null, 'panel', 'effort_menu'],
  ['/plan', '[описание]', 'Включить режим планирования без правок', 'model', 'Shift+Tab', 'panel', 'mode_plan'],
  ['/permissions', '', 'Режим разрешений и правила allow/ask/deny', 'model', null, 'panel', 'permissions'],
  ['/fast', '[on|off]', 'Быстрый режим ответов', 'model', null, 'panel', 'fast_mode'],
  ['/output-style', '[стиль]', 'Стиль подачи ответов', 'model', null, 'panel', 'output_style'],
  ['/focus', '', 'Свернуть вызовы инструментов, оставить итог', 'model', null, 'panel', 'focus_mode'],

  ['/agents', '', 'Субагенты: запущенные и доступные', 'agents', null, 'panel', 'open_agents'],
  ['/tasks', '', 'Фоновые задачи диалога', 'agents', 'Ctrl+B', 'panel', 'open_tasks'],
  ['/workflows', '', 'Ход воркфлоу: смотреть и останавливать', 'agents', null, 'panel', 'open_workflows'],
  ['/goal', '[условие]', 'Работать, пока цель не достигнута', 'agents', null, 'sdk', null],
  ['/loop', '[интервал] [задача]', 'Повторять задачу по интервалу', 'agents', null, 'sdk', null],
  ['/batch', '<инструкция>', 'Раскидать правку на много фоновых агентов', 'agents', null, 'sdk', null],
  ['/subtask', '<задача>', 'Запустить подзадачу в фоне', 'agents', null, 'sdk', null],
  ['/deep-research', '<тема>', 'Исследование с источниками и сводкой', 'agents', null, 'sdk', null],

  ['/mcp', '', 'Подключённые MCP-серверы', 'tools', null, 'panel', 'open_mcp'],
  ['/hooks', '', 'Хуки из settings.json', 'tools', null, 'panel', 'open_hooks'],
  ['/plugin', '', 'Плагины Claude Code', 'tools', null, 'panel', 'open_plugins'],
  ['/skills', '', 'Список навыков', 'tools', null, 'panel', 'open_skills'],
  ['/add-dir', '<путь>', 'Добавить рабочий каталог в диалог', 'tools', null, 'panel', 'add_dir'],
  ['/artifacts', '', 'Артефакты диалога', 'tools', null, 'panel', 'open_artifacts'],
  ['/review', '[PR]', 'Проверить изменения кода', 'tools', null, 'sdk', null],
  ['/security-review', '', 'Проверка безопасности текущей ветки', 'tools', null, 'sdk', null],
  ['/simplify', '', 'Упростить изменённый код', 'tools', null, 'sdk', null],

  ['/memory', '', 'Править CLAUDE.md и память', 'project', null, 'panel', 'open_memory'],
  ['/init', '', 'Создать CLAUDE.md для проекта', 'project', null, 'sdk', null],
  ['/config', '', 'Настройки', 'project', null, 'panel', 'open_settings'],

  ['/help', '', 'Справка по командам панели', 'account', '?', 'panel', 'open_help'],
  ['/status', '', 'Версия, модель, аккаунт', 'account', null, 'panel', 'show_status'],
  ['/login', '', 'Войти в аккаунт Claude', 'account', null, 'panel', 'open_account'],
  ['/theme', '', 'Тема оформления', 'account', null, 'panel', 'theme'],
  ['/voice', '', 'Голосовой ввод', 'account', null, 'panel', 'voice_input'],
];
