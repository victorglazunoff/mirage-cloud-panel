import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { findFilePathRefs, isLikelyFilePath, splitLineSuffix } from '@/modules/chat/utils/filePathRefs';

/** Mirage: what the Kabina feed takes for a file path (and opens in Files) and what it leaves alone. */

describe('isLikelyFilePath', () => {
  const files = [
    'export/landing-maket.html',
    'src/App.tsx:42',
    'src/App.tsx:42:7',
    '/home/me/My Projects/Ремонт/интерьер/Кухня-гостиная — фото 2026-10-27.pdf',
    '~/notes/todo.md',
    './scripts/deploy.sh',
    '../shared/types.ts',
    'package.json',
    'README.md',
    'docs/PLAN-2.md',
    '.agents/skills/backend-module-standards/SKILL.md',
    'server/.env',
  ];
  for (const path of files) {
    it(`takes ${path}`, () => assert.equal(isLikelyFilePath(path), true));
  }

  const notFiles = [
    'https://panel.example.com/p/x.html',
    'http://example.com/a.js',
    'panel.example.com',
    'github.com/siteboon/claudecodeui/blob/main/a.ts',
    'www.example.com/a.html',
    '1.37.5',
    'e.g.',
    'т.е.',
    'v2.0',
    'src/modules/chat',
    '/api/providers/sessions',
    'src/',
    'run_in_background',
    'sleep 40',
    '.env',
    'foo.bar',
  ];
  for (const text of notFiles) {
    it(`leaves ${text}`, () => assert.equal(isLikelyFilePath(text), false));
  }
});

describe('splitLineSuffix', () => {
  it('reads the line and drops the column', () => {
    assert.deepEqual(splitLineSuffix('src/App.tsx:42:7'), { path: 'src/App.tsx', line: 42 });
    assert.deepEqual(splitLineSuffix('src/App.tsx'), { path: 'src/App.tsx', line: null });
  });
});

describe('findFilePathRefs', () => {
  const texts = (text: string) => findFilePathRefs(text).map((match) => match.text);

  it('finds relative, absolute and home paths in running text', () => {
    assert.deepEqual(
      texts('Правка в src/App.tsx:42, макет — export/landing-maket.html. Заметки в ~/notes/todo.md и /tmp/report.csv.'),
      ['src/App.tsx:42', 'export/landing-maket.html', '~/notes/todo.md', '/tmp/report.csv'],
    );
  });

  it('keeps an absolute path with spaces in its folders', () => {
    assert.deepEqual(
      texts('Модель: /home/me/My Projects/Ремонт/3D-модель.html готова'),
      ['/home/me/My Projects/Ремонт/3D-модель.html'],
    );
  });

  it('leaves web addresses, domains and versions alone', () => {
    assert.deepEqual(texts('См. https://example.com/a/b.html и panel.example.com, версия 1.37.5, т.е. ничего.'), []);
  });

  it('reports where each path sits and its line', () => {
    const [match] = findFilePathRefs('открой (src/a.ts:7)');
    assert.equal(match.path, 'src/a.ts');
    assert.equal(match.line, 7);
    assert.equal('открой (src/a.ts:7)'.slice(match.start, match.end), 'src/a.ts:7');
  });

  it('takes a bare known file name but not a bare unknown one', () => {
    assert.deepEqual(texts('обнови package.json и foo.bar'), ['package.json']);
  });
});
