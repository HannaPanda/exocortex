import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  clearRecordedWorkspaces,
  createdWorkspacesPath,
  readRecordedWorkspaces,
} from './created-workspaces';

/**
 * Removes the workspaces this run created.
 *
 * Without it the deployment fills up: the suite makes a dozen workspaces per
 * run and the application has no way to delete one, so they accumulate until
 * the workspace menu is a hundred entries long. (It got to 136 before anyone
 * noticed, which is how this file came to exist.)
 *
 * Deliberately forgiving. The suite can run against a deployment on another
 * host, where the database is out of reach and this cannot work; a cleanup that
 * failed must never turn a green run red, so it warns and gives up. Set
 * `E2E_SKIP_CLEANUP=1` to leave the workspaces in place for inspection — the
 * list survives in `e2e/.created-workspaces` either way.
 */
export default function globalTeardown(): void {
  if (process.env.E2E_SKIP_CLEANUP === '1') {
    console.log('[teardown] E2E_SKIP_CLEANUP=1, leaving the created workspaces in place.');
    return;
  }

  const workspaces = readRecordedWorkspaces();
  if (workspaces.length === 0) return;

  const repositoryRoot = join(__dirname, '..', '..');
  try {
    execFileSync(
      'pnpm',
      [
        '--filter',
        '@exocortex/api',
        'workspaces:delete',
        '--',
        '--ids-file',
        createdWorkspacesPath(),
      ],
      { cwd: repositoryRoot, stdio: 'inherit' },
    );
    clearRecordedWorkspaces();
  } catch (error) {
    console.warn(
      `[teardown] Could not delete ${workspaces.length} test workspaces ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `The ids are in ${createdWorkspacesPath()}.`,
    );
  }
}
