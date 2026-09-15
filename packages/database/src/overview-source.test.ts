import { describe, expect, it } from 'vitest';

import { digestInputHash, type OverviewChild, overviewInputHash } from './overview-source';

/**
 * The staleness mechanism of an overview page (issue #53, ADR-028).
 *
 * Both hashes decide whether a paid model call happens, so both failure modes
 * cost something real: a hash that moves on its own recomposes an unchanged
 * page for ever, and one that misses a change leaves an overview describing a
 * tree that has moved on.
 */

function child(overrides: Partial<OverviewChild> & { id: string; title: string }): OverviewChild {
  return {
    icon: null,
    iconColor: null,
    type: 'PAGE',
    isOverview: false,
    summary: null,
    summaryInputHash: null,
    childCount: 0,
    ...overrides,
  };
}

const base = {
  title: 'Creative & Media',
  ownText: 'Werkzeuge für Bild, Ton und Video.',
  children: [
    child({ id: 'a', title: 'Fish Audio S2', summaryInputHash: 'h-a' }),
    child({ id: 'b', title: 'Higgsfield AI', summaryInputHash: 'h-b' }),
  ],
};

describe('overviewInputHash', () => {
  it('is stable for the same material', () => {
    expect(overviewInputHash(base)).toBe(overviewInputHash(base));
  });

  it('changes when a child is renamed', () => {
    const renamed = {
      ...base,
      children: [
        child({ id: 'a', title: 'Fish Audio S3', summaryInputHash: 'h-a' }),
        base.children[1] as OverviewChild,
      ],
    };
    expect(overviewInputHash(renamed)).not.toBe(overviewInputHash(base));
  });

  it('changes when a child disappears', () => {
    const fewer = { ...base, children: [base.children[0] as OverviewChild] };
    expect(overviewInputHash(fewer)).not.toBe(overviewInputHash(base));
  });

  it('changes when the children are reordered, because the text follows the order', () => {
    const swapped = { ...base, children: [...base.children].reverse() };
    expect(overviewInputHash(swapped)).not.toBe(overviewInputHash(base));
  });

  it('changes when a child gets its first digest', () => {
    const digested = {
      ...base,
      children: [
        child({ id: 'a', title: 'Fish Audio S2', summaryInputHash: 'h-a2', summary: 'Stimmen.' }),
        base.children[1] as OverviewChild,
      ],
    };
    expect(overviewInputHash(digested)).not.toBe(overviewInputHash(base));
  });

  it('ignores trailing whitespace in the page body', () => {
    const padded = { ...base, ownText: `${base.ownText}   \n\n` };
    expect(overviewInputHash(padded)).toBe(overviewInputHash(base));
  });

  it('does not change when a child is edited in a way that leaves its digest alone', () => {
    // The parent composes from digests, not from text: a typo fixed on a child
    // page must not cost a composition one level up.
    const sameDigests = { ...base, children: base.children.map((entry) => ({ ...entry })) };
    expect(overviewInputHash(sameDigests)).toBe(overviewInputHash(base));
  });
});

describe('digestInputHash', () => {
  it('is stable for the same page', () => {
    const input = { title: 'Fish Audio S2', text: 'Ein Dienst für Sprachsynthese.' };
    expect(digestInputHash(input)).toBe(digestInputHash(input));
  });

  it('changes when the text changes', () => {
    expect(digestInputHash({ title: 'A', text: 'eins' })).not.toBe(
      digestInputHash({ title: 'A', text: 'zwei' }),
    );
  });

  it('changes when the title changes, because the digest is written against it', () => {
    expect(digestInputHash({ title: 'A', text: 'eins' })).not.toBe(
      digestInputHash({ title: 'B', text: 'eins' }),
    );
  });
});
