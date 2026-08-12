import { describe, expect, it } from 'vitest';

import { type SearchHit } from './search';
import { embeddingInputFor, embeddingTextHash, fuse } from './semantic-search';

function hit(documentId: string, rank: number): SearchHit {
  return {
    documentId,
    workspaceId: 'w1',
    title: documentId,
    icon: null,
    iconColor: null,
    type: 'PAGE',
    snippet: `Auszug ${documentId}`,
    rank,
    archivedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

function ids(hits: readonly SearchHit[]): string[] {
  return hits.map((entry) => entry.documentId);
}

describe('fuse', () => {
  it('puts a page both halves agree on above one only a single half found', () => {
    const keyword = [hit('a', 0.9), hit('b', 0.4)];
    const vector = [hit('c', 0.8), hit('b', 0.7)];

    expect(ids(fuse(keyword, vector, 0.5))[0]).toBe('b');
  });

  it('keeps a semantic-only hit, which is the whole point of the second half', () => {
    const fused = fuse([hit('a', 0.9)], [hit('c', 0.8)], 0.5);

    expect(ids(fused).sort()).toEqual(['a', 'c']);
  });

  it('answers with the full-text order alone at weight 0', () => {
    const fused = fuse([hit('a', 0.9), hit('b', 0.4)], [hit('c', 0.99)], 0);

    // `c` still appears -- it scores zero and sorts last, it is not dropped.
    expect(ids(fused)).toEqual(['a', 'b', 'c']);
  });

  it('answers with the semantic order alone at weight 1', () => {
    const fused = fuse([hit('a', 0.9)], [hit('c', 0.8), hit('b', 0.7)], 1);

    expect(ids(fused)).toEqual(['c', 'b', 'a']);
  });

  it('clamps a weight outside 0 to 1 instead of inverting the ranking', () => {
    expect(ids(fuse([hit('a', 1)], [hit('c', 1)], 5))).toEqual(['c', 'a']);
    expect(ids(fuse([hit('a', 1)], [hit('c', 1)], -5))).toEqual(['a', 'c']);
  });

  it('keeps the highlighted full-text snippet for a page found by both', () => {
    const keyword = [{ ...hit('b', 0.4), snippet: 'mit <mark>Wort</mark>' }];
    const vector = [{ ...hit('b', 0.7), snippet: 'die ersten 200 Zeichen' }];

    expect(fuse(keyword, vector, 0.5)[0]?.snippet).toBe('mit <mark>Wort</mark>');
  });

  it('replaces the incomparable input scores with the fused one', () => {
    const fused = fuse([hit('a', 0.9)], [], 0.5);

    expect(fused[0]?.rank).toBeCloseTo(0.5 / 61, 6);
  });
});

describe('embeddingInputFor', () => {
  it('puts the title in front of the body', () => {
    expect(embeddingInputFor({ title: 'Kalender', plainText: 'Termine' }, 100)).toBe(
      'Kalender\n\nTermine',
    );
  });

  it('truncates to the model window', () => {
    const input = embeddingInputFor({ title: 'T', plainText: 'x'.repeat(1_000) }, 20);
    expect(input).toHaveLength(20);
  });
});

describe('embeddingTextHash', () => {
  it('changes when the text changes and not otherwise', () => {
    expect(embeddingTextHash('gleich')).toBe(embeddingTextHash('gleich'));
    expect(embeddingTextHash('gleich')).not.toBe(embeddingTextHash('anders'));
  });
});
