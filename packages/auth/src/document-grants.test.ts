import { describe, expect, it } from 'vitest';

import {
  chainCovers,
  isRestricted,
  type PageScopeRestriction,
  restrictionAllows,
  roleForSharePermission,
  selectShareGrant,
  type ShareGrantRow,
} from './document-grants';

/**
 * The pure half of issue #83 (ADR-044).
 *
 * Everything here decides who reaches a page, so it is tested exhaustively
 * rather than through the routes that call it: a route test proves one path
 * works, and what matters about an authorization rule is the paths that do not.
 *
 * `chain` is always the page itself first, then its ancestors upwards, which is
 * what `loadAncestorChain` returns.
 */

const chain = ['page', 'section', 'root'];

function grant(partial: Partial<ShareGrantRow> = {}): ShareGrantRow {
  return {
    id: 'share-1',
    documentId: 'page',
    scope: 'PAGE_ONLY',
    permission: 'READ',
    ...partial,
  };
}

describe('chainCovers', () => {
  it('matches a page-only grant against the page itself and nothing else', () => {
    expect(chainCovers(chain, 'page', 'PAGE_ONLY')).toBe(true);
    expect(chainCovers(chain, 'section', 'PAGE_ONLY')).toBe(false);
    expect(chainCovers(chain, 'root', 'PAGE_ONLY')).toBe(false);
  });

  it('matches a subtree grant anywhere above the page, the page included', () => {
    expect(chainCovers(chain, 'page', 'SUBTREE')).toBe(true);
    expect(chainCovers(chain, 'section', 'SUBTREE')).toBe(true);
    expect(chainCovers(chain, 'root', 'SUBTREE')).toBe(true);
  });

  it('matches nothing at all for a page that does not exist', () => {
    // An empty chain is what `loadAncestorChain` returns for a missing page.
    expect(chainCovers([], 'page', 'SUBTREE')).toBe(false);
    expect(chainCovers([], 'page', 'PAGE_ONLY')).toBe(false);
  });

  it('does not match a page that is merely below the grant in another branch', () => {
    expect(chainCovers(['other', 'elsewhere'], 'section', 'SUBTREE')).toBe(false);
  });
});

describe('selectShareGrant', () => {
  it('returns null when nothing reaches the page', () => {
    expect(selectShareGrant(chain, [])).toBeNull();
    expect(selectShareGrant(chain, [grant({ documentId: 'elsewhere' })])).toBeNull();
  });

  it('takes the strongest grant rather than the nearest one', () => {
    const onThePage = grant({ id: 'near', documentId: 'page', permission: 'READ' });
    const onTheBranch = grant({
      id: 'far',
      documentId: 'root',
      scope: 'SUBTREE',
      permission: 'WRITE',
    });
    // A READ grant on the page does not take away a WRITE grant on the branch:
    // grants are additive, and taking something away is what revoking is for.
    expect(selectShareGrant(chain, [onThePage, onTheBranch])?.id).toBe('far');
    expect(selectShareGrant(chain, [onTheBranch, onThePage])?.id).toBe('far');
  });

  it('keeps the first match when both carry the same permission', () => {
    const first = grant({ id: 'first' });
    const second = grant({ id: 'second', documentId: 'root', scope: 'SUBTREE' });
    expect(selectShareGrant(chain, [first, second])?.id).toBe('first');
  });

  it('ignores a grant whose scope does not reach', () => {
    const tooNarrow = grant({ id: 'narrow', documentId: 'section', scope: 'PAGE_ONLY' });
    expect(selectShareGrant(chain, [tooNarrow])).toBeNull();
  });
});

describe('roleForSharePermission', () => {
  it('maps READ to GUEST and WRITE to MEMBER', () => {
    // Not two new roles: these are the two the policy layer already means by
    // "may look" and "may look and write", so every policy applies unchanged.
    expect(roleForSharePermission('READ')).toBe('GUEST');
    expect(roleForSharePermission('WRITE')).toBe('MEMBER');
  });
});

describe('restrictionAllows', () => {
  const confined = (scopes: PageScopeRestriction['scopes']): PageScopeRestriction => ({
    tokenId: 'token',
    declared: true,
    scopes,
  });

  it('lets an unconfined credential through', () => {
    expect(restrictionAllows(null, chain)).toBe(true);
    expect(restrictionAllows({ tokenId: 't', declared: false, scopes: [] }, chain)).toBe(true);
  });

  it('lets a confined credential through inside its branch', () => {
    expect(restrictionAllows(confined([{ documentId: 'section', scope: 'SUBTREE' }]), chain)).toBe(
      true,
    );
  });

  it('refuses a confined credential outside its branch', () => {
    expect(
      restrictionAllows(confined([{ documentId: 'elsewhere', scope: 'SUBTREE' }]), chain),
    ).toBe(false);
    // A page-only scope on the section does not reach the page below it.
    expect(
      restrictionAllows(confined([{ documentId: 'section', scope: 'PAGE_ONLY' }]), chain),
    ).toBe(false);
  });

  it('refuses everything once a confined credential has lost its pages', () => {
    // The scope rows cascade with the pages they name. "Declared but empty"
    // has to mean nothing, not everything, or deleting a page would widen a
    // token.
    expect(restrictionAllows(confined([]), chain)).toBe(false);
  });

  it('passes when any one of several scopes reaches', () => {
    expect(
      restrictionAllows(
        confined([
          { documentId: 'elsewhere', scope: 'SUBTREE' },
          { documentId: 'page', scope: 'PAGE_ONLY' },
        ]),
        chain,
      ),
    ).toBe(true);
  });
});

describe('isRestricted', () => {
  it('is true only for a credential that was confined on purpose', () => {
    expect(isRestricted(null)).toBe(false);
    expect(isRestricted({ tokenId: 't', declared: false, scopes: [] })).toBe(false);
    expect(isRestricted({ tokenId: 't', declared: true, scopes: [] })).toBe(true);
  });
});
