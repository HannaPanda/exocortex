import { describe, expect, it } from 'vitest';

import { CHUNK_THRESHOLD_CHARS, isChunkBlockId, type PassageAnchor } from './chunking';
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
    section: null,
    rank,
    archivedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

/** A hit that knows which passage matched, the way the vector half answers. */
function located(documentId: string, rank: number): SearchHit {
  return { ...hit(documentId, rank), section: { blockId: 'tumorambu01', path: ['Tumorambulanz'] } };
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

describe('where a passage says it is', () => {
  const page = (plainText: string, headingAnchors?: PassageAnchor[]) => ({
    documentId: 'd1',
    workspaceId: 'w1',
    title: 'Gesundheit',
    plainText,
    archivedAt: null,
    headingAnchors,
  });

  const body = 'Absatz.\n'.repeat(500);

  it('writes the heading a passage sits under, and none for the page itself', () => {
    const targets = embeddingTargetsFor(
      page(`Tumorambulanz\n${body}`, [
        { offset: 0, blockId: 'tumorambu01', path: ['Gesundheit', 'Tumorambulanz'] },
      ]),
      24_000,
      'm',
    );

    expect(targets[0]).toMatchObject({ blockId: null, headingBlockId: null, headingPath: null });
    expect(targets[1]).toMatchObject({
      headingBlockId: 'tumorambu01',
      headingPath: ['Gesundheit', 'Tumorambulanz'],
    });
  });

  it('tells a page nobody worked the headings out for from one that has none', () => {
    const unknown = embeddingTargetsFor(page(body), 24_000, 'm');
    const none = embeddingTargetsFor(page(body, []), 24_000, 'm');

    // `null` is what the sweep looks for, `[]` is what makes it stop looking.
    expect(unknown[1]?.headingPath).toBeNull();
    expect(none[1]?.headingPath).toEqual([]);
  });

  it('keeps the hash off the heading, so an anchor costs no second embedding', () => {
    const before = embeddingTargetsFor(page(body), 24_000, 'm');
    const after = embeddingTargetsFor(
      page(body, [{ offset: 0, blockId: 'kopfzeile01', path: ['Kopfzeile'] }]),
      24_000,
      'm',
    );

    expect(after.map((target) => target.hash)).toEqual(before.map((target) => target.hash));
  });
});

describe('fusing a located hit with an unlocated one', () => {
  it('keeps the keyword snippet and takes the section from the semantic half', () => {
    // Both halves found the same page. The keyword hit carries the highlighted
    // fragment and no address; the vector hit knows which passage matched. A
    // reader wants the first and an agent needs the second (issue #118).
    const [fused] = fuse([hit('a', 0.9)], [located('a', 0.8)], 0.5);

    expect(fused?.snippet).toBe('Auszug a');
    expect(fused?.section).toEqual({ blockId: 'tumorambu01', path: ['Tumorambulanz'] });
  });

  it('leaves a page only the keyword half found without one', () => {
    const [fused] = fuse([hit('b', 0.9)], [], 0.5);

    expect(fused?.section).toBeNull();
  });
});
