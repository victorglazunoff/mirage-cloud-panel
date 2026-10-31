import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, test, vi } from 'vitest';

import { filterCatalog, formatTokens, menuTerm, parseArgs } from '@/modules/kabina-commands/utils/commandMenuModel';
import type { CommandCatalogEntry, CommandCatalogResponse } from '@/shared/types';

function entry(name: string, group: CommandCatalogEntry['group'], description: string, extra: Partial<CommandCatalogEntry> = {}): CommandCatalogEntry {
  return {
    id: `builtin:${name}`, name, args: '', description, group, groupLabel: group, shortcut: null,
    execution: 'sdk', panelAction: null, source: 'builtin', path: null, ...extra,
  };
}

const COMMANDS: CommandCatalogEntry[] = [
  entry('/compact', 'session', 'Сжать контекст диалога', { args: '[инструкция]' }),
  entry('/context', 'context', 'Показать, чем занято окно контекста', { execution: 'panel', panelAction: 'show_context' }),
  entry('/cost', 'context', 'Расход токенов и стоимость диалога', { execution: 'panel', panelAction: 'show_cost' }),
  entry('/model', 'model', 'Выбрать модель для диалога', { args: '[модель]', execution: 'panel', panelAction: 'model_menu', shortcut: 'Alt+P' }),
  entry('/batch', 'agents', 'Раскидать правку на много фоновых агентов', { args: '<инструкция>' }),
  entry('/seo', 'mine', 'SEO-аудит сайта', { id: 'skill:seo', execution: 'skill', source: 'skill', path: '/home/user/.claude/skills/seo/SKILL.md' }),
];

const CATALOG: CommandCatalogResponse = {
  groups: [],
  commands: COMMANDS,
  count: COMMANDS.length,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

vi.mock('@/shared/api', () => ({
  api: {
    commandsCatalog: vi.fn(async () => json(CATALOG)),
    contextUsage: vi.fn(async () => json({
      data: {
        sessionId: 's1', source: 'live', estimated: false, model: 'opus', totalTokens: 104_400, maxTokens: 200_000, percentage: 52.2,
        autoCompactThreshold: 170_000,
        categories: [
          { id: 'messages', name: 'Messages', tokens: 74_300, percentage: 37.2, kind: 'used' },
          { id: 'mcp_tools', name: 'MCP tools', tokens: 18_400, percentage: 9.2, kind: 'used' },
          { id: 'free_space', name: 'Free', tokens: 80_000, percentage: 40, kind: 'free' },
        ],
        session: { inputTokens: 412_000, outputTokens: 38_600, cacheReadTokens: 1_900_000, cacheCreationTokens: 0, assistantTurns: 3, costUsd: 4.12 },
        compactQueued: false,
      },
    })),
    home: { limits: vi.fn(async () => json({ data: null })) },
    providers: {
      models: vi.fn(async () => json({ data: { models: { OPTIONS: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }] } } })),
      sessionActiveModel: vi.fn(async () => json({ data: { model: 'opus', effort: 'high' } })),
    },
  },
}));

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function renderMenu(query: string, props: { sessionId?: string | null; onComplete?: (text: string) => void } = {}) {
  const { SlashCommandMenu } = await import('@/modules/kabina-commands');
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<SlashCommandMenu query={query} projectId={null} onPick={onPick} onClose={onClose} {...props} />);
  await flush();
  await flush();
  return { onPick, onClose };
}

beforeAll(async () => {
  await import('@/modules/kabina-commands');
}, 30_000);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('model: the filter word, args hints, token format and grouped filtering', () => {
  assert.equal(menuTerm('/co'), 'co');
  assert.equal(menuTerm('/compact оставь цены'), 'compact');
  assert.deepEqual(parseArgs('[интервал] <задача>'), [{ a: 'интервал', d: 'необязательный' }, { a: 'задача', d: 'обязательный' }]);
  assert.equal(formatTokens(104_400), '104,4k');
  assert.equal(formatTokens(1_900_000), '1,9M');
  const groups = filterCatalog(CATALOG, 'co');
  assert.deepEqual(groups.map((group) => group.id), ['session', 'context']);
  assert.deepEqual(groups[1].commands.map((command) => command.name), ['/context', '/cost']);
});

test('the menu lists matches with the hit highlighted and hides filtered skills behind a note', async () => {
  await renderMenu('/co');
  const options = screen.getAllByRole('option');
  assert.deepEqual(options.map((option) => option.querySelector('.kbm-name')?.textContent), ['/compact', '/context', '/cost']);
  assert.equal(options[0].querySelector('.kbm-hit')?.textContent, 'co');
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  assert.ok(screen.getByText(/1 навык скрыт фильтром: seo/));
  assert.ok(screen.getByText('ход не обрывает'));
});

test('↓ then Enter runs the command; typed arguments travel with it', async () => {
  const { onPick } = await renderMenu('/co');
  fireEvent.keyDown(window, { key: 'ArrowDown' });
  fireEvent.keyDown(window, { key: 'Enter' });
  assert.deepEqual(onPick.mock.calls[0][0], { name: '/context', insertText: '/context', execution: 'panel', panelAction: 'show_context' });

  cleanup();
  const second = await renderMenu('/compact оставь цены');
  fireEvent.keyDown(window, { key: 'Enter' });
  assert.equal(second.onPick.mock.calls[0][0].insertText, '/compact оставь цены');
});

test('Tab completes; a command with a required argument completes on Enter too', async () => {
  const onComplete = vi.fn();
  await renderMenu('/batch', { onComplete });
  fireEvent.keyDown(window, { key: 'Enter' });
  fireEvent.keyDown(window, { key: 'Tab' });
  assert.deepEqual(onComplete.mock.calls.map((call) => call[0]), ['/batch ', '/batch ']);
});

test('Esc closes only the menu and does not reach the composer', async () => {
  const composerKeys = vi.fn();
  document.addEventListener('keydown', composerKeys);
  const { onClose } = await renderMenu('/');
  fireEvent.keyDown(document.body, { key: 'Escape' });
  document.removeEventListener('keydown', composerKeys);
  assert.equal(onClose.mock.calls.length, 1);
  assert.equal(composerKeys.mock.calls.length, 0);
});

test('a modal over the composer (⌘K search) keeps its own arrows, Enter and Esc', async () => {
  const { onPick, onClose } = await renderMenu('/co');
  const modal = document.createElement('section');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const input = document.createElement('input');
  modal.appendChild(input);
  document.body.appendChild(modal);
  const searchKeys = vi.fn();
  modal.addEventListener('keydown', searchKeys);
  try {
    for (const key of ['ArrowDown', 'Enter', 'Escape']) fireEvent.keyDown(input, { key });
    assert.equal(onPick.mock.calls.length, 0, 'Enter in the search does not run a command behind it');
    assert.equal(onClose.mock.calls.length, 0, 'Esc closes the search, not the menu');
    assert.equal(searchKeys.mock.calls.length, 3, 'the search gets every key');
  } finally {
    modal.remove();
  }
});

test('/context previews the live context bar of the session; /model offers a choice', async () => {
  await renderMenu('/context', { sessionId: 's1' });
  await flush();
  assert.ok(screen.getByRole('img', { name: /Занято 52% контекста: Беседа 37%/ }));
  assert.ok(screen.getByText('104,4k / 200k'));
  assert.ok(screen.getByText('авто-сжатие 85%'));

  cleanup();
  const { onPick } = await renderMenu('/model', { sessionId: 's1' });
  await flush();
  const current = screen.getByRole('radio', { checked: true });
  assert.match(current.textContent ?? '', /Opus/);
  fireEvent.click(screen.getByRole('radio', { name: /Sonnet/ }));
  assert.equal(onPick.mock.calls[0][0].insertText, '/model sonnet');
});
