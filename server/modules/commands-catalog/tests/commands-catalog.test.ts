import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Dirent } from 'node:fs';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createCommandsCatalogRouter } from '../commands-catalog.routes.js';
import { createCommandsCatalogService } from '../commands-catalog.service.js';

/** Builds an in-memory file system from a { absolutePath: content } map. */
function createFakeFileSystem(files: Record<string, string>) {
  const dirent = (name: string, isDir: boolean) =>
    ({ name, isDirectory: () => isDir, isFile: () => !isDir, isSymbolicLink: () => false }) as unknown as Dirent;

  return {
    async readdir(dir: string): Promise<Dirent[]> {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const children = new Map<string, boolean>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const [head, ...tail] = rest.split('/');
        children.set(head, tail.length > 0);
      }
      if (children.size === 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...children].map(([name, isDir]) => dirent(name, isDir));
    },
    async readFile(file: string): Promise<string> {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    },
  };
}

const files = {
  '/home/u/.claude/commands/deploy.md': '---\ndescription: Выкатить сайт\nargument-hint: "[стенд]"\n---\nтело',
  '/home/u/.claude/commands/git/sync.md': '# Синхронизировать ветку\nтело',
  '/home/u/.claude/skills/karta/SKILL.md': '---\nname: karta-mults\ndescription: Мульты\n  для карты\n---\n',
  '/proj/.claude/commands/deploy.md': '---\ndescription: Проектный деплой\n---\n',
  '/home/u/.claude/plugins/cache/mk/pl/1.0/skills/review/SKILL.md': '---\nname: review-x\ndescription: Ревью\n---\n',
};

test('catalog contains built-in groups, user commands, skills and plugin skills', async () => {
  const service = createCommandsCatalogService({
    fileSystem: createFakeFileSystem(files),
    homeDirectory: () => '/home/u',
  });
  const catalog = await service.getCatalog(null);

  assert.deepEqual(
    catalog.groups.map((group) => group.id),
    ['session', 'context', 'model', 'agents', 'tools', 'project', 'account', 'mine'],
  );
  const compact = catalog.commands.find((command) => command.name === '/compact');
  assert.equal(compact?.execution, 'sdk');
  assert.equal(compact?.group, 'session');
  const model = catalog.commands.find((command) => command.name === '/model');
  assert.equal(model?.execution, 'panel');
  assert.equal(model?.shortcut, 'Alt+P');

  const mine = catalog.groups.find((group) => group.id === 'mine')!.commands;
  assert.deepEqual(
    mine.map((command) => command.name),
    ['/deploy', '/git/sync', '/karta-mults', '/review-x'],
  );
  assert.equal(mine[0].description, 'Выкатить сайт');
  assert.equal(mine[0].args, '[стенд]');
  assert.equal(mine[1].description, 'Синхронизировать ветку');
  assert.equal(mine[2].execution, 'skill');
  assert.equal(mine[2].description, 'Мульты для карты');
  assert.equal(mine[3].source, 'plugin');
});

test('project commands override user commands with the same name', async () => {
  const service = createCommandsCatalogService({
    fileSystem: createFakeFileSystem(files),
    homeDirectory: () => '/home/u',
  });
  const catalog = await service.getCatalog('/proj');
  const deploy = catalog.commands.filter((command) => command.name === '/deploy');
  assert.equal(deploy.length, 1);
  assert.equal(deploy[0].source, 'project');
  assert.equal(deploy[0].description, 'Проектный деплой');
});

test('route answers 404 for an unknown project and 200 with the catalog otherwise', async () => {
  const service = createCommandsCatalogService({
    fileSystem: createFakeFileSystem(files),
    homeDirectory: () => '/home/u',
  });
  const app = express();
  app.use('/catalog', createCommandsCatalogRouter({
    catalogService: service,
    resolveProjectPath: (id) => (id === 'p1' ? '/proj' : null),
  }));
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/catalog`;
  try {
    assert.equal((await fetch(`${base}?projectId=nope`)).status, 404);
    const ok = await fetch(`${base}?projectId=p1`);
    assert.equal(ok.status, 200);
    const body = await ok.json() as { count: number };
    assert.ok(body.count > 40);
  } finally {
    server.close();
  }
});
