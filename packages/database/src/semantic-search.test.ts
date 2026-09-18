import { describe, expect, it } from 'vitest';

import { CHUNK_THRESHOLD_CHARS, isChunkBlockId } from './chunking';
import { type SearchHit } from './search';
import { embeddingInputFor, embeddingTargetsFor, embeddingTextHash, fuse } from './semantic-search';

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

describe('embeddingTargetsFor', () => {
  const page = (plainText: string) => ({
    documentId: 'd1',
    workspaceId: 'w1',
    title: 'Kalender',
    plainText,
    archivedAt: null,
  });

  it('gives a short page exactly the one vector it had before', () => {
    const targets = embeddingTargetsFor(page('Termine am Freitag.'), 24_000, 'm');

    expect(targets).toHaveLength(1);
    expect(targets[0]?.blockId).toBeNull();
    expect(targets[0]?.chunkText).toBeNull();
  });

  it('keeps the whole-document vector when it adds passages', () => {
    const targets = embeddingTargetsFor(page('Absatz.\n'.repeat(500)), 24_000, 'm');

    expect(targets.length).toBeGreaterThan(1);
    expect(targets.filter((target) => target.blockId === null)).toHaveLength(1);
    expect(targets.slice(1).every((target) => isChunkBlockId(target.blockId))).toBe(true);
  });

  it('puts the page title in front of every passage as well', () => {
    const targets = embeddingTargetsFor(page('Absatz.\n'.repeat(500)), 24_000, 'm');

    expect(targets.every((target) => target.text.startsWith('Kalender\n\n'))).toBe(true);
  });

  it('stores the passage, so a hit can show the paragraph that matched', () => {
    const targets = embeddingTargetsFor(page('Absatz.\n'.repeat(500)), 24_000, 'm');
    const passage = targets[1];
    if (passage === undefined) throw new Error('expected a passage');

    expect(passage.chunkText).not.toBeNull();
    expect(passage.text).toContain(passage.chunkText ?? '');
  });

  it('hashes per row, so an edit pays for the passages it touched', () => {
    const body = `${'Absatz eins. '.repeat(200)}\n${'Absatz zwei. '.repeat(200)}`;
    const before = embeddingTargetsFor(page(body), 24_000, 'm');
    const after = embeddingTargetsFor(page(`${body}\nEin Nachtrag am Ende.`), 24_000, 'm');

    expect(before[1]?.hash).toBe(after[1]?.hash);
    expect(before[0]?.hash).not.toBe(after[0]?.hash);
  });

  it('still embeds a page that is only a title, and nothing for an empty one', () => {
    expect(embeddingTargetsFor(page(''), 24_000, 'm')).toHaveLength(1);
    expect(embeddingTargetsFor({ ...page(''), title: '' }, 24_000, 'm')).toEqual([]);
  });

  it('asks the chunker with the page text alone, not with the title in front', () => {
    const justBelow = 'w'.repeat(CHUNK_THRESHOLD_CHARS);

    expect(embeddingTargetsFor(page(justBelow), 24_000, 'm')).toHaveLength(1);
  });
});
