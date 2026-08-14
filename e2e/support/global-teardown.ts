import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  clearRecordedWorkspaces,
  createdWorkspacesPath,
  readRecordedWorkspaces,
} from './created-workspaces';
import { clearRunScope, readRunScope, runScopePath } from './run-scope';

/**
 * Removes what this run left behind: the workspaces it created, and the pages it
 * created inside the workspace it signed in to.
 *
 * Without the first half the deployment fills up: the suite makes a dozen
 * workspaces per run and the application has no way to delete one, so they
 * accumulate until the workspace menu is a hundred entries long. (It got to 136
 * before anyone noticed, which is how this file came to exist.)
 *
 * Without the second half the *seeded* workspace fills up instead, which is
 * worse, because that one cannot simply be deleted and every run has to render
 * its page tree. It reached 1,271 pages against the six that belong there before
 * this half was written.
 *
 * Deliberately forgiving, both halves. The suite can run against a deployment on
 * another host, where the database is out of reach and this cannot work; a
 * cleanup that failed must never turn a green run red, so it warns and gives up.
 * Set `E2E_SKIP_CLEANUP=1` to leave everything in place for inspection — the
 * lists survive in `e2e/.created-workspaces` and `e2e/.run-scope` either way.
 */
export default function globalTeardown(): void {
  if (process.env.E2E_SKIP_CLEANUP === '1') {
    console.log(
      '[teardown] E2E_SKIP_CLEANUP=1, leaving the created workspaces and pages in place.',
    );
    return;
  }

  const repositoryRoot = join(__dirname, '..', '..');
  deleteCreatedWorkspaces(repositoryRoot);
  deleteCreatedPages(repositoryRoot);
}

function deleteCreatedWorkspaces(repositoryRoot: string): void {
  const workspaces = readRecordedWorkspaces();
  if (workspaces.length === 0) return;

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

/**
 * Everything newer than the run's start in the workspaces it signed in to.
 *
 * A window rather than a list of ids, because tests create pages through the
 * tree, the editor, the slash menu and the API, and a list would be missing
 * whichever path someone adds next. See `run-scope.ts`.
 */
function deleteCreatedPages(repositoryRoot: string): void {
  const scope = readRunScope();
  if (scope === null) return;

  try {
    for (const workspaceId of scope.workspaceIds) {
      execFileSync(
        'pnpm',
        [
          '--filter',
          '@exocortex/api',
          'documents:delete',
          '--',
          '--workspace',
          workspaceId,
          '--created-after',
          scope.startedAt,
        ],
        { cwd: repositoryRoot, stdio: 'inherit' },
      );
    }
    clearRunScope();
  } catch (error) {
    console.warn(
      `[teardown] Could not delete the pages this run created ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `The scope is in ${runScopePath()}, and the operator script is ` +
        `\`pnpm --filter @exocortex/api documents:delete\`.`,
    );
  }
}
