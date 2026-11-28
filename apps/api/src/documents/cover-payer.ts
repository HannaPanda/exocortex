import { type DocumentGrant } from '@exocortex/auth';

import { AppError } from '../common/app-error';

/**
 * Which workspace pays for a cover the AI draws (issue #264, ADR-090, ADR-092).
 *
 * A member of the page's workspace asks on that workspace's key, as ADR-090
 * decided: the page, the person and the bill are in one place. Somebody who
 * reached the page only through a share is a reader of somebody else's page,
 * and the picture is theirs to pay for, never the sharer's:
 *
 * - inside an AI run (the run's signed `runId`, never a request field) it is
 *   the run's own workspace, the one its conversation, key and budget belong
 *   to, so a cover the reader's assistant draws on a shared page lands on the
 *   same bill as the chat that asked for it;
 * - otherwise (the browser, an external MCP client) it is the first workspace
 *   in the reader's own order that is not an agent memory area, which is the
 *   same workspace the chat panel picks on a shared page when nobody chose
 *   another one;
 * - a reader without any workspace of their own is refused, because there is
 *   nobody whose key could be asked and the deployment does not step in for a
 *   page that is not its own.
 */
export interface CoverPayer {
  workspaceId: string;
  /** Why this workspace: the page's own, the asking run's, or the reader's first own one. */
  source: 'page' | 'run' | 'own_workspace';
}

export interface CoverPayerLookups {
  /** The run a signed run id names, or null when there is none. */
  runWorkspace(runId: string): Promise<{ workspaceId: string; createdById: string } | null>;
  /** The caller's first workspace in their own order that is not a memory area, or null. */
  firstOwnWorkspace(userId: string): Promise<string | null>;
}

export async function resolveCoverPayer(
  input: {
    /** The page's workspace and how the caller reached it. */
    context: { readonly workspaceId: string; readonly grant: DocumentGrant };
    userId: string;
    /** From the signed service token (issue #140); undefined outside a run. */
    runId: string | undefined;
  },
  lookups: CoverPayerLookups,
): Promise<CoverPayer> {
  if (input.context.grant.source !== 'share') {
    return { workspaceId: input.context.workspaceId, source: 'page' };
  }

  if (input.runId !== undefined) {
    const run = await lookups.runWorkspace(input.runId);
    // A signed id that names no run of this person cannot say who pays, and
    // guessing would put the bill on somebody: refused rather than defaulted.
    if (run === null || run.createdById !== input.userId) {
      throw AppError.forbidden('The run asking for this cover cannot be found');
    }
    return { workspaceId: run.workspaceId, source: 'run' };
  }

  const own = await lookups.firstOwnWorkspace(input.userId);
  if (own === null) {
    throw new AppError(
      'ai_image_no_own_workspace',
      'A cover on a shared page is paid for by a workspace of your own, and you have none',
    );
  }
  return { workspaceId: own, source: 'own_workspace' };
}
