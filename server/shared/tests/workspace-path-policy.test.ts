import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

// WORKSPACES_ROOT is read when the utils module is first imported, so it has
// to point at the fixture before that import. The fixture sits beside this
// file, not under /tmp, which the policy refuses on its own.
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = await realpath(await mkdtemp(path.join(testDirectory, 'workspace-policy-fixture-')));
const workspacesRoot = path.join(fixtureRoot, 'home');
await mkdir(path.join(workspacesRoot, 'Projects', 'site'), { recursive: true });
await mkdir(path.join(workspacesRoot, '.ssh'), { recursive: true });
await mkdir(path.join(fixtureRoot, 'outside'), { recursive: true });

const previousRoot = process.env.WORKSPACES_ROOT;
process.env.WORKSPACES_ROOT = workspacesRoot;

const { validateWorkspacePath } = await import('@/shared/utils.js');
const { checkProjectPath, createProject } = await import('@/modules/projects/services/project-management.service.js');

after(async () => {
  if (previousRoot === undefined) {
    delete process.env.WORKSPACES_ROOT;
  } else {
    process.env.WORKSPACES_ROOT = previousRoot;
  }
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('folders inside the workspaces root are accepted, existing or not', async () => {
  const existing = await validateWorkspacePath(path.join(workspacesRoot, 'Projects', 'site'));
  assert.equal(existing.valid, true);
  assert.equal(existing.resolvedPath, path.join(workspacesRoot, 'Projects', 'site'));

  const missing = await validateWorkspacePath(path.join(workspacesRoot, 'Projects', 'new-one'));
  assert.equal(missing.valid, true);
});

test('paths with control characters or relative paths are refused with a Russian reason', async () => {
  for (const withControl of [
    path.join(workspacesRoot, 'Projects', 'site\nevil'),
    `${path.join(workspacesRoot, 'Projects')}/a\tb`,
    `${path.join(workspacesRoot, 'Projects')}/a\u0000b`,
    `${path.join(workspacesRoot, 'Projects')}/a\u007fb`,
  ]) {
    const result = await validateWorkspacePath(withControl);
    assert.equal(result.valid, false, JSON.stringify(withControl));
    assert.equal(result.code, 'WORKSPACE_PATH_CONTROL_CHARACTERS');
    assert.match(result.reason ?? '', /служебные символы/);
  }

  // A relative path would resolve against the server's own working folder.
  const previousCwd = process.cwd();
  process.chdir(workspacesRoot);
  try {
    for (const relative of ['Projects/site', './Projects/new', 'new-one']) {
      const result = await validateWorkspacePath(relative);
      assert.equal(result.valid, false, relative);
      assert.equal(result.code, 'WORKSPACE_PATH_RELATIVE');
      assert.match(result.reason ?? '', /Полный путь/);
      const check = await checkProjectPath(relative);
      assert.equal(check.valid, false);
      assert.equal(check.code, 'WORKSPACE_PATH_RELATIVE');
    }
  } finally {
    process.chdir(previousCwd);
  }

  // A trailing newline (a paste) is just trimmed.
  assert.equal((await checkProjectPath(`${path.join(workspacesRoot, 'Projects', 'site')}\n`)).valid, true);
});

test('the workspaces root itself is refused as a project but browsable', async () => {
  const asProject = await validateWorkspacePath(workspacesRoot);
  assert.equal(asProject.valid, false);
  assert.equal(asProject.code, 'WORKSPACE_PATH_IS_WORKSPACES_ROOT');
  assert.match(asProject.reason ?? '', /Слишком широко/);

  const asBrowse = await validateWorkspacePath(workspacesRoot, { allowWorkspacesRoot: true });
  assert.equal(asBrowse.valid, true);
});

test('hidden folders under the root are refused with the segment named', async () => {
  const direct = await validateWorkspacePath(path.join(workspacesRoot, '.ssh'));
  assert.equal(direct.code, 'WORKSPACE_PATH_HIDDEN_DIRECTORY');
  assert.equal(direct.reason, '.ssh — там ключи и настройки, проекты в ней не держим.');

  const nested = await validateWorkspacePath(path.join(workspacesRoot, 'Projects', '.claude', 'x'));
  assert.equal(nested.code, 'WORKSPACE_PATH_HIDDEN_DIRECTORY');
});

test('system directories, the filesystem root and outside paths are refused in Russian', async () => {
  const etc = await validateWorkspacePath('/etc/nginx');
  assert.equal(etc.code, 'WORKSPACE_PATH_SYSTEM_DIRECTORY');
  assert.equal(etc.title, '/etc — системная папка');

  const temporary = await validateWorkspacePath('/tmp/landing-test');
  assert.equal(temporary.code, 'WORKSPACE_PATH_SYSTEM_DIRECTORY');
  assert.match(temporary.reason ?? '', /очищают при перезагрузке/);

  const filesystemRoot = await validateWorkspacePath('/');
  assert.equal(filesystemRoot.code, 'WORKSPACE_PATH_IS_FILESYSTEM_ROOT');

  const outside = await validateWorkspacePath(path.join(fixtureRoot, 'outside'));
  assert.equal(outside.code, 'WORKSPACE_PATH_OUTSIDE_ROOT');

  const empty = await validateWorkspacePath('   ');
  assert.equal(empty.code, 'WORKSPACE_PATH_REQUIRED');
});

test('a symlink inside the root that leads outside is judged by its target', async () => {
  const link = path.join(workspacesRoot, 'Projects', 'escape');
  await symlink(path.join(fixtureRoot, 'outside'), link);
  const result = await validateWorkspacePath(link);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'WORKSPACE_PATH_OUTSIDE_ROOT');
});

test('checkProjectPath reports existence and an existing project without creating anything', async () => {
  const sitePath = path.join(workspacesRoot, 'Projects', 'site');
  const check = await checkProjectPath(sitePath, {
    validatePath: (candidate) => validateWorkspacePath(candidate),
    getProjectByPath: (candidate) => (candidate === sitePath
      ? { project_id: 'p1', project_path: sitePath, custom_project_name: 'Сайт', isStarred: 0, isArchived: 1 }
      : null),
  });
  assert.equal(check.valid, true);
  assert.equal(check.exists, true);
  assert.deepEqual(check.existingProject, { projectId: 'p1', displayName: 'Сайт', isArchived: true });

  const refused = await checkProjectPath(path.join(workspacesRoot, '.ssh'), {
    validatePath: (candidate) => validateWorkspacePath(candidate),
    getProjectByPath: () => null,
  });
  assert.equal(refused.valid, false);
  assert.equal(refused.code, 'WORKSPACE_PATH_HIDDEN_DIRECTORY');
});

test('createProject puts the human reason into error details', async () => {
  await assert.rejects(
    createProject({ projectPath: path.join(workspacesRoot, '.ssh') }, {
      validatePath: (candidate) => validateWorkspacePath(candidate),
      ensureWorkspaceDirectory: async () => undefined,
      persistProjectPath: () => { throw new Error('must not persist'); },
      getProjectByPath: () => null,
    }),
    (error: unknown) => {
      const appError = error as { code?: string; details?: unknown; message?: string };
      assert.equal(appError.code, 'INVALID_PROJECT_PATH');
      assert.equal(appError.message, 'Скрытая служебная папка');
      assert.equal(appError.details, '.ssh — там ключи и настройки, проекты в ней не держим.');
      return true;
    },
  );
});
