import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { setPanelTimeZone } from '@/modules/kabina';

// The fixtures are built from local fields, so the panel zone is the process zone here.
beforeAll(() => setPanelTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));

import {
  commonProjectsFolder,
  extensionTag,
  formatBytes,
  formatModified,
  foldersToReveal,
  markdownBlocks,
  previewKindOf,
  resolveRevealPath,
  tokenizeLine,
} from '@/modules/kabina-files/utils/fileKinds';

test('preview kinds by name: secrets never preview, svg is a picture', () => {
  assert.equal(previewKindOf('.env', false), 'secret');
  assert.equal(previewKindOf('.env.local', false), 'secret');
  assert.equal(previewKindOf('id_rsa', false), 'secret');
  assert.equal(previewKindOf('README.md', false), 'md');
  assert.equal(previewKindOf('cabinet.php', false), 'code');
  assert.equal(previewKindOf('logo.svg', false), 'img');
  assert.equal(previewKindOf('отчёт.xlsx', false), 'sheet');
  assert.equal(previewKindOf('аудит.pdf', false), 'pdf');
  assert.equal(previewKindOf('archive.tgz', false), 'none');
  assert.equal(previewKindOf('docs', true), 'folder');
  assert.equal(extensionTag('.env', false), 'ENV');
  assert.equal(extensionTag('LICENSE', false), 'ФАЙЛ');
});

test('sizes and dates in the mock-up wording', () => {
  assert.equal(formatBytes(412), '412 Б');
  assert.equal(formatBytes(18_637), '18,2 КБ');
  assert.equal(formatBytes(4_089_446), '3,9 МБ');
  const now = new Date(2026, 9, 26, 14, 32).getTime();
  assert.equal(formatModified(new Date(2026, 9, 26, 13, 58).toISOString(), now), 'сегодня 13:58');
  assert.equal(formatModified(new Date(2026, 9, 25, 18, 21).toISOString(), now), 'вчера 18:21');
  assert.equal(formatModified(new Date(2026, 9, 22, 9, 0).toISOString(), now), '22 окт');
});

test('markdown becomes title, sand caps, dashes and paragraphs; code fences are skipped', () => {
  const blocks = markdownBlocks('# ТЗ\n\nКабинет **отдела** продаж.\n\n## Роли\n\n- Руководитель\n- [x] Менеджер\n\n```\ncode\n```');
  assert.deepEqual(blocks, [
    { kind: 'h1', text: 'ТЗ' },
    { kind: 'p', text: 'Кабинет отдела продаж.' },
    { kind: 'h2', text: 'РОЛИ' },
    { kind: 'li', text: 'Руководитель' },
    { kind: 'li', text: 'Менеджер' },
  ]);
});

test('the code tokenizer colours keywords, strings, comments, calls and numbers', () => {
  const tokens = tokenizeLine("const hold = plots(72); // бронь", 'js');
  assert.deepEqual(tokens.filter((token) => token.kind !== 'v').map((token) => [token.text, token.kind]), [
    ['const', 'k'], ['plots', 'f'], ['72', 'n'], ['// бронь', 'c'],
  ]);
  assert.deepEqual(tokenizeLine('HOST="demo-site.example" # прод', 'sh').filter((token) => token.kind !== 'v').map((token) => token.kind), ['s', 'c']);
  assert.equal(tokenizeLine('  --ink: #1B1D1A;', 'css').find((token) => token.text === '#1B1D1A')?.kind, 'n');
});

test('the projects folder is the parent most projects share', () => {
  assert.equal(commonProjectsFolder(['/home/user/P/a', '/home/user/P/b', '/home/user/x']), '/home/user/P');
  assert.equal(commonProjectsFolder(['/home/user/a']), null);
});

test('foldersToReveal lists the root and every folder down to the file parent', () => {
  assert.deepEqual(foldersToReveal('/a/p', '/a/p/docs/api/x.md'), ['/a/p', '/a/p/docs', '/a/p/docs/api']);
  assert.deepEqual(foldersToReveal('/a/p/', '/a/p/x.md'), ['/a/p']);
  assert.deepEqual(foldersToReveal('/a/p', '/a/pp/x.md'), []);
  assert.deepEqual(foldersToReveal('/a/p', '/a/p'), []);
});

test('resolveRevealPath keeps absolute paths and anchors relative ones to the project', () => {
  assert.equal(resolveRevealPath('/home/user/x.md', null), '/home/user/x.md');
  assert.equal(resolveRevealPath('./docs/x.md', '/a/p/'), '/a/p/docs/x.md');
  assert.equal(resolveRevealPath('docs/x.md', null), null);
  assert.equal(resolveRevealPath('  ', '/a/p'), null);
});
