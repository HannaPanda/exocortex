import { type DocumentGrant } from '@exocortex/auth';

/**
 * What a caller who reached a page through a share may be told about the pages
 * around it (issue #83, ADR-044).
 *
 * A page is never handed over alone. A detail response carries its breadcrumb,
 * an export carries its path and its children, a tree carries its siblings --
 * and each of those is a list of titles from a workspace the recipient is not
 * a member of. Sharing one page must not hand over the names of the sections
 * it happens to sit under, so the chain is cut at the root of the grant and
 * everything above it simply is not there.
 */

/** An entry of a breadcrumb or path, whatever else it carries. */
interface PathEntry {
  id: string;
}

/**
 * The visible part of an ancestor chain, root-first.
 *
 * A member sees all of it. Somebody holding a share sees from the shared page
 * downwards, and nothing at all when the chain does not contain the shared
 * page -- which cannot happen for a page they were allowed to open, and is the
 * right answer if it ever does.
 */
export function visiblePath<TEntry extends PathEntry>(
  path: readonly TEntry[],
  grant: DocumentGrant,
): TEntry[] {
  if (grant.source === 'membership') return [...path];
  const index = path.findIndex((entry) => entry.id === grant.rootId);
  return index === -1 ? [] : path.slice(index);
}

/**
 * Whether the pages *below* this one may be listed.
 *
 * A share of a single page is a share of that page: its sub-pages are separate
 * pages, they were not shared, and listing their titles would share them a
 * little.
 */
export function mayListChildren(grant: DocumentGrant): boolean {
  return grant.source === 'membership' || grant.scope === 'SUBTREE';
}
