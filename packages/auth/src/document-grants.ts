import { type SharePermission, type ShareScope, type WorkspaceRole } from '@exocortex/contracts';

/**
 * Grants on a single page, and the confinement of a credential to a branch
 * (issue #83, ADR-044).
 *
 * Pure, like `policies.ts` beside it, and for the same reason: the three
 * questions here -- does a grant reach this page, does the credential reach
 * this page, what may the holder do once it does -- are the ones a new endpoint
 * gets wrong quietly, so they are written once and tested exhaustively rather
 * than re-derived per route.
 *
 * The one idea worth stating outright: a share is expressed as a **role**. A
 * page handed to somebody with READ makes them a guest of that page, WRITE
 * makes them a member of it, and from there every policy in `policies.ts`
 * applies unchanged. Without that, sharing would need its own copy of every
 * rule about archived pages, comments, attachments and collaboration access,
 * and the copies would drift the first time one of them was amended.
 */

/** A live share row, reduced to what a decision needs. */
export interface ShareGrantRow {
  readonly id: string;
  /** The page the grant is attached to: the root of its scope. */
  readonly documentId: string;
  readonly scope: ShareScope;
  readonly permission: SharePermission;
}

/** Where a caller's authority over one page came from. */
export type DocumentGrant =
  | { readonly source: 'membership' }
  | {
      readonly source: 'share';
      readonly shareId: string;
      /** The shared page. Everything above it is outside what was shared. */
      readonly rootId: string;
      readonly scope: ShareScope;
      readonly permission: SharePermission;
    };

/**
 * One page or branch a credential may reach.
 *
 * `declared` is the difference between "this token was never confined" and
 * "this token was confined and the pages it named are gone". The rows are
 * deleted with their pages, so without the flag the second case would silently
 * become the first, and deleting a page would widen a token.
 */
export interface PageScopeRestriction {
  readonly tokenId: string;
  readonly declared: boolean;
  readonly scopes: readonly { readonly documentId: string; readonly scope: ShareScope }[];
}

/** Reads the restriction of the credential making the current request, if any. */
export interface PageScopeRestrictionProvider {
  current(): PageScopeRestriction | null;
}

/**
 * Whether a grant rooted at `rootId` with `scope` covers `documentId`, given
 * the page's chain of ancestors (the page itself first, then upwards).
 */
export function chainCovers(chain: readonly string[], rootId: string, scope: ShareScope): boolean {
  if (chain.length === 0) return false;
  if (scope === 'PAGE_ONLY') return chain[0] === rootId;
  return chain.includes(rootId);
}

/**
 * The strongest grant that reaches this page, or null.
 *
 * Strongest, not nearest: a page inside a branch shared with READ that is
 * *itself* shared with WRITE is writable, and the reverse holds too -- a READ
 * grant on the page does not take away a WRITE grant on the branch it sits in.
 * Sharing is additive, like every other grant in this system; taking something
 * away is what revoking is for.
 */
export function selectShareGrant(
  chain: readonly string[],
  grants: readonly ShareGrantRow[],
): ShareGrantRow | null {
  let best: ShareGrantRow | null = null;
  for (const grant of grants) {
    if (!chainCovers(chain, grant.documentId, grant.scope)) continue;
    if (best === null || (best.permission === 'READ' && grant.permission === 'WRITE')) {
      best = grant;
    }
  }
  return best;
}

/**
 * The workspace role a share stands in for.
 *
 * GUEST and MEMBER rather than two new roles, because these are exactly the two
 * the policy layer already means by "may read" and "may read and write". What a
 * share deliberately cannot stand in for is ADMIN: deleting a page for good,
 * restoring a snapshot and managing members stay with the workspace, so the
 * worst a shared WRITE grant can do is what a member could undo.
 */
export function roleForSharePermission(permission: SharePermission): WorkspaceRole {
  return permission === 'WRITE' ? 'MEMBER' : 'GUEST';
}

/**
 * Whether a confined credential may touch the page whose ancestor chain this
 * is.
 *
 * A credential that was never confined passes everything; a confined one that
 * has lost all of its pages passes nothing.
 */
export function restrictionAllows(
  restriction: PageScopeRestriction | null,
  chain: readonly string[],
): boolean {
  if (restriction === null || !restriction.declared) return true;
  return restriction.scopes.some((entry) => chainCovers(chain, entry.documentId, entry.scope));
}

/** Whether a restriction is in force at all. */
export function isRestricted(restriction: PageScopeRestriction | null): boolean {
  return restriction !== null && restriction.declared;
}
