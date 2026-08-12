import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * When this run started, and which workspaces it signed in to.
 *
 * The other half of the cleanup. `created-workspaces.ts` records the workspaces
 * the suite *makes*, and the teardown deletes those outright. But most tests
 * work in the seeded workspace the sign-in lands in, which has to survive the
 * run — so the pages they create there were never cleaned up by anything. There
 * were 1,271 of them by 2026-08-12, against the six that belong there, and the
 * page tree the suite exercises had become a list nobody could scroll.
 *
 * A timestamp and a workspace id is all the teardown needs: everything in that
 * workspace newer than the moment the run began is something the run made. That
 * is why this is not a list of page ids — tests create pages through the tree,
 * through the editor and through the API, and a list would be missing whichever
 * path someone adds next.
 *
 * The narrow risk it buys: a page a *human* creates in that workspace while the
 * suite is running is inside the window and would go too. Against the seeded
 * test workspace nobody is doing that, and the alternative was unbounded growth.
 *
 * A file rather than module state, because the teardown runs in its own process.
 */
const RECORD_PATH = join(__dirname, '..', '.run-scope');

export interface RunScope {
  /** ISO timestamp taken before the first test signs in. */
  startedAt: string;
  /** The workspaces the seed users landed in, deduplicated. */
  workspaceIds: string[];
}

export function runScopePath(): string {
  return RECORD_PATH;
}

/** Never throws: losing the note is not worth failing a run over. */
export function recordRunScope(scope: RunScope): void {
  try {
    mkdirSync(dirname(RECORD_PATH), { recursive: true });
    writeFileSync(RECORD_PATH, JSON.stringify(scope, null, 2), 'utf8');
  } catch {
    // The worst case is pages left behind, which the operator script sweeps up.
  }
}

export function readRunScope(): RunScope | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { startedAt, workspaceIds } = parsed as Partial<RunScope>;
    if (typeof startedAt !== 'string' || !Array.isArray(workspaceIds)) return null;
    const ids = workspaceIds.filter((id): id is string => typeof id === 'string');
    return ids.length === 0 ? null : { startedAt, workspaceIds: ids };
  } catch {
    return null;
  }
}

export function clearRunScope(): void {
  rmSync(RECORD_PATH, { force: true });
}
