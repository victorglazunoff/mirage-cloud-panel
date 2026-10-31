import assert from 'node:assert/strict';
import { constants as fsConstants, createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const { tree } = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const { tree } = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const { tree } = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles cuts a tree over the server entry limit instead of failing', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const listing = await service.listProjectFiles('project-1');

  assert.equal(listing.truncated, true);
  assert.equal(listing.limit, 10_000);
  assert.equal(listing.tree.length, 10_000);
});

test('listProjectFiles keeps every top-level entry and cuts the deepest folders first', async () => {
  // The demo-villa shape: a few top folders, one of them far too big to list in full.
  const projectRoot = path.resolve('file-tree-test-project');
  const site = path.join(projectRoot, 'site');
  const pages = path.join(site, 'pages');
  const docs = path.join(projectRoot, 'docs');
  const directories = new Set([site, pages, docs]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [createDirectoryEntry('site', true), createDirectoryEntry('docs', true), createDirectoryEntry('README.md', false)];
      }
      if (directoryPath === site) {
        return [createDirectoryEntry('pages', true), createDirectoryEntry('core.py', false)];
      }
      if (directoryPath === docs) {
        return [createDirectoryEntry('plan.md', false)];
      }
      if (directoryPath === pages) {
        return Array.from({ length: 12_000 }, (_, index) => createDirectoryEntry(`page-${index}.html`, false));
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directories.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const { tree, truncated } = await service.listProjectFiles('project-1');

  assert.equal(truncated, true);
  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'site', 'README.md']);
  const docsNode = tree.find((entry) => entry.name === 'docs');
  const siteNode = tree.find((entry) => entry.name === 'site');
  assert.deepEqual(docsNode?.children?.map((entry) => entry.name), ['plan.md']);
  assert.equal(docsNode?.childrenTruncated, undefined);
  assert.deepEqual(siteNode?.children?.map((entry) => entry.name), ['pages', 'core.py']);
  const pagesNode = siteNode?.children?.find((entry) => entry.name === 'pages');
  assert.equal(pagesNode?.childrenTruncated, true);
  // Six entries above it were charged first: root (3), site (2), docs (1).
  assert.equal(pagesNode?.children?.length, 10_000 - 6);
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const listing = await service.listProjectFiles('project-1');

  assert.equal(listing.truncated, true);
  assert.equal(listing.tree.length, 10_000);
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const { tree, truncated } = await service.listProjectFiles('project-1');

  assert.equal(truncated, true);
  const [first, second] = tree;
  // In tree order: «first» takes its 5 000, «second» gets what is left of the budget.
  assert.equal(first?.children?.length, 5_000);
  assert.equal(first?.childrenTruncated, undefined);
  assert.equal(second?.children?.length, 10_000 - 2 - 5_000);
  assert.equal(second?.childrenTruncated, true);
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(projectRoot: string, workspaceRoot = projectRoot): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination, fsConstants.COPYFILE_EXCL),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: workspaceRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });
}

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('reading through a symlink out of the temp directory is still refused', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'));

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a file in another folder of the workspace can be read, but never written to', async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, '.runs', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot);
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'));

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // A link inside the workspace does not open what lies outside it.
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('an upload into the project root given as an absolute path lands in the root', async () => {
  const projectRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-upload-root-'));
  const temporaryUpload = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-upload-tmp-'));
  try {
    const service = createRealFileSystemService(projectRoot);
    // Mirage: a name per pass — an upload never replaces a file that is already there.
    for (const [index, targetPath] of [projectRoot, `${projectRoot}/`].entries()) {
      const fileName = `notes-${index}.txt`;
      const temporaryPath = path.join(temporaryUpload, 'upload.tmp');
      await fsPromises.writeFile(temporaryPath, 'uploaded', 'utf8');
      const result = await service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath,
        relativePaths: [fileName],
        requestedFileCount: 1,
        files: [{ originalName: fileName, temporaryPath, size: 8, mimeType: 'text/plain' }],
      });
      assert.equal(result.uploadedCount, 1);
      assert.equal(await fsPromises.readFile(path.join(projectRoot, fileName), 'utf8'), 'uploaded');
    }
    // The root's parent is still outside the project.
    const temporaryPath = path.join(temporaryUpload, 'upload.tmp');
    await fsPromises.writeFile(temporaryPath, 'uploaded', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.dirname(projectRoot),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'escape.txt', temporaryPath, size: 8, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(temporaryUpload, { recursive: true, force: true });
  }
});

// Mirage: an upload never replaces what is already in the folder (Иван: «не перезаписывать, а
// предложить изменить имя»). A taken name answers 409 FILE_EXISTS with a free name to offer.
type UploadConflictDetails = {
  targetPath: string;
  conflicts: Array<{ index: number; name: string; suggestedName: string }>;
};

async function withUploadProject(
  run: (input: {
    projectRoot: string;
    service: FileTreeServices;
    stage: (name: string, content: string) => Promise<{ originalName: string; temporaryPath: string; size: number; mimeType: string }>;
  }) => Promise<void>,
): Promise<void> {
  const projectRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-upload-conflict-'));
  const temporaryUpload = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-upload-tmp-'));
  let staged = 0;
  try {
    await run({
      projectRoot,
      service: createRealFileSystemService(projectRoot),
      stage: async (name, content) => {
        staged += 1;
        const temporaryPath = path.join(temporaryUpload, `upload-${staged}.tmp`);
        await fsPromises.writeFile(temporaryPath, content, 'utf8');
        return { originalName: name, temporaryPath, size: Buffer.byteLength(content), mimeType: 'text/plain' };
      },
    });
    // Whatever happened, no temporary upload is left behind.
    assert.deepEqual(await fsPromises.readdir(temporaryUpload), []);
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(temporaryUpload, { recursive: true, force: true });
  }
}

function isFileExistsError(expected: UploadConflictDetails['conflicts']) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'FILE_EXISTS');
    assert.deepEqual((error.details as UploadConflictDetails).conflicts, expected);
    return true;
  };
}

test('an upload with a taken name is refused with a free name and leaves the file alone', async () => {
  await withUploadProject(async ({ projectRoot, service, stage }) => {
    await fsPromises.writeFile(path.join(projectRoot, 'README.md'), 'old', 'utf8');
    await fsPromises.writeFile(path.join(projectRoot, 'README (2).md'), 'older copy', 'utf8');

    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: projectRoot,
        relativePaths: ['README.md'],
        requestedFileCount: 1,
        files: [await stage('README.md', 'new')],
      }),
      isFileExistsError([{ index: 0, name: 'README.md', suggestedName: 'README (3).md' }]),
    );
    assert.equal(await fsPromises.readFile(path.join(projectRoot, 'README.md'), 'utf8'), 'old');
    assert.equal(await fsPromises.readFile(path.join(projectRoot, 'README (2).md'), 'utf8'), 'older copy');
  });
});

test('one taken name stops the whole batch, so nothing is half uploaded', async () => {
  await withUploadProject(async ({ projectRoot, service, stage }) => {
    await fsPromises.writeFile(path.join(projectRoot, 'README.md'), 'old', 'utf8');
    await fsPromises.mkdir(path.join(projectRoot, 'docs'));

    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: projectRoot,
        relativePaths: ['fresh.txt', 'README.md', 'docs'],
        requestedFileCount: 3,
        files: [await stage('fresh.txt', 'a'), await stage('README.md', 'b'), await stage('docs', 'c')],
      }),
      isFileExistsError([
        { index: 1, name: 'README.md', suggestedName: 'README (2).md' },
        // A folder takes the name too.
        { index: 2, name: 'docs', suggestedName: 'docs (2)' },
      ]),
    );
    assert.deepEqual((await fsPromises.readdir(projectRoot)).sort(), ['README.md', 'docs']);
  });
});

test('two files of one batch with the same name do not overwrite each other', async () => {
  await withUploadProject(async ({ projectRoot, service, stage }) => {
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: projectRoot,
        relativePaths: ['a/notes.txt', 'a/notes.txt'],
        requestedFileCount: 2,
        files: [await stage('notes.txt', 'first'), await stage('notes.txt', 'second')],
      }),
      // The suggestion keeps the folder of the relative path.
      isFileExistsError([{ index: 1, name: 'a/notes.txt', suggestedName: 'a/notes (2).txt' }]),
    );
    assert.deepEqual(await fsPromises.readdir(projectRoot), []);
  });
});

test('the suggested name sent back as the relative path uploads beside the original', async () => {
  await withUploadProject(async ({ projectRoot, service, stage }) => {
    await fsPromises.writeFile(path.join(projectRoot, 'README.md'), 'old', 'utf8');
    await fsPromises.writeFile(path.join(projectRoot, '.env'), 'secret', 'utf8');

    const result = await service.storeUploadedFiles({
      projectId: 'project-1',
      targetPath: projectRoot,
      relativePaths: ['README (2).md', 'fresh.txt'],
      requestedFileCount: 2,
      files: [await stage('README.md', 'new'), await stage('fresh.txt', 'fresh')],
    });
    assert.equal(result.uploadedCount, 2);
    assert.equal(await fsPromises.readFile(path.join(projectRoot, 'README.md'), 'utf8'), 'old');
    assert.equal(await fsPromises.readFile(path.join(projectRoot, 'README (2).md'), 'utf8'), 'new');

    // A dot file has no extension to keep: «.env (2)».
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: projectRoot,
        relativePaths: ['.env'],
        requestedFileCount: 1,
        files: [await stage('.env', 'other')],
      }),
      isFileExistsError([{ index: 0, name: '.env', suggestedName: '.env (2)' }]),
    );
  });
});
