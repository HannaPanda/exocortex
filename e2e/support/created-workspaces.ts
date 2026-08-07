import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The workspaces one suite run created, so the teardown can remove them again.
 *
 * A browser test cannot delete a workspace itself: the application does not
 * offer it, on purpose (`apps/api/scripts/delete-workspaces.ts` explains why).
 * So the tests write down what they made and `global-teardown.ts` hands the
 * list to the operator script at the end of the run.
 *
 * A file rather than a module-level array, because the teardown runs in its own
 * process and would see an empty one. Append-only, so a crashed run still
 * leaves a list someone can clean up by hand:
 *
 *   pnpm --filter @exocortex/api workspaces:delete -- --ids-file e2e/.created-workspaces
 */
const RECORD_PATH = join(__dirname, '..', '.created-workspaces');

export function createdWorkspacesPath(): string {
  return RECORD_PATH;
}

/** Notes a workspace for deletion. Never throws: losing the note is not worth failing a test over. */
export function recordWorkspace(workspaceId: string): void {
  try {
    mkdirSync(dirname(RECORD_PATH), { recursive: true });
    appendFileSync(RECORD_PATH, `${workspaceId}\n`, 'utf8');
  } catch {
    // The worst case is a workspace left behind, which the next manual run of
    // the script above sweeps up.
  }
}

export function readRecordedWorkspaces(): string[] {
  try {
    return readFileSync(RECORD_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export function clearRecordedWorkspaces(): void {
  rmSync(RECORD_PATH, { force: true });
}
