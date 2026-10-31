import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import test from 'node:test';

// Б18: when the panel runs as root, `/root` is both the workspaces root and an
// entry of FORBIDDEN_WORKSPACE_PATHS. Only lexical checks and paths that do not
// exist are used, so nothing on the machine is touched.
process.env.WORKSPACES_ROOT = '/root';
const { validateWorkspacePath } = await import('@/shared/utils.js');

function canReach(directory: string): boolean {
  try {
    accessSync(directory, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const canReachRoot = canReach('/root');

test('folders under /root are accepted when /root is the workspaces root', { skip: !canReachRoot }, async () => {
  const result = await validateWorkspacePath('/root/projects/workspace-policy-probe-does-not-exist');
  assert.equal(result.valid, true, result.reason);
});

test('/root itself is refused as a project but stays browsable', { skip: !canReachRoot }, async () => {
  const asProject = await validateWorkspacePath('/root');
  assert.equal(asProject.code, 'WORKSPACE_PATH_IS_WORKSPACES_ROOT');
  assert.equal(asProject.title, '/root — домашняя папка целиком');

  const asBrowse = await validateWorkspacePath('/root', { allowWorkspacesRoot: true });
  assert.equal(asBrowse.valid, true);
});

test('hidden folders and system directories stay refused', { skip: !canReachRoot }, async () => {
  assert.equal((await validateWorkspacePath('/root/.ssh')).code, 'WORKSPACE_PATH_HIDDEN_DIRECTORY');
  assert.equal((await validateWorkspacePath('/root/.claude/projects')).code, 'WORKSPACE_PATH_HIDDEN_DIRECTORY');
  assert.equal((await validateWorkspacePath('/usr/local/x')).code, 'WORKSPACE_PATH_SYSTEM_DIRECTORY');
  assert.equal((await validateWorkspacePath('/tmp/x')).code, 'WORKSPACE_PATH_SYSTEM_DIRECTORY');
});
