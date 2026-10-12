import { describe, expect, it } from 'vitest';

import { parseVector, SimilarityIndex } from './similarity';

function vec(...values: number[]): Float32Array {
  const vector = parseVector(`[${values.join(',')}]`);
  if (vector === null) throw new Error('test vector did not parse');
  return vector;
}

function keys(index: SimilarityIndex, perPage: number): string[] {
  return index
    .pairs(perPage)
    .map((pair) => `${pair.source}-${pair.target}`)
    .sort();
}

const VECTORS = new Map([
  ['a', vec(1, 0, 0)],
  ['b', vec(0.95, 0.05, 0)],
  ['c', vec(0.9, 0.1, 0)],
  ['z', vec(0, 0, 1)],
]);
const VERSIONS = new Map([...VECTORS.keys()].map((id) => [id, 'v1']));

describe('parseVector', () => {
  it('reads the pgvector text form and normalizes it', () => {
    const vector = parseVector('[3,4]');
    expect(vector?.[0]).toBeCloseTo(0.6);
    expect(vector?.[1]).toBeCloseTo(0.8);
  });

  it('refuses what is not a vector, and the zero vector, which has no direction', () => {
    expect(parseVector('3,4')).toBeNull();
    expect(parseVector('[1,abc]')).toBeNull();
    expect(parseVector('[0,0]')).toBeNull();
  });
});

describe('SimilarityIndex', () => {
  it('connects the close pages and leaves the unrelated one alone', async () => {
    const index = new SimilarityIndex(0.5);
    await index.apply(VERSIONS, VECTORS);
    expect(keys(index, 2)).toEqual(['a-b', 'a-c', 'b-c']);
    expect(index.pairs(2).every((pair) => pair.similarity >= 0.5)).toBe(true);
  });

  it('keeps the nearest per page from either end, without duplicates', async () => {
    const index = new SimilarityIndex(0.5);
    await index.apply(VERSIONS, VECTORS);
    expect(keys(index, 1)).toEqual(['a-b', 'b-c']);
  });

  it('answers nothing below the floor', async () => {
    const index = new SimilarityIndex(0.9999);
    await index.apply(VERSIONS, VECTORS);
    expect(index.pairs(3)).toEqual([]);
  });

  it('recomputes only what changed: a moved vector, a new page, a removed one', async () => {
    const index = new SimilarityIndex(0.5);
    await index.apply(VERSIONS, VECTORS);
    expect(index.stale(VERSIONS)).toEqual([]);

    // z now writes about what a writes about, c is gone, d is new.
    const versions = new Map([
      ['a', 'v1'],
      ['b', 'v1'],
      ['z', 'v2'],
      ['d', 'v1'],
    ]);
    expect(index.stale(versions).sort()).toEqual(['d', 'z']);
    await index.apply(
      versions,
      new Map([
        ['z', vec(1, 0.01, 0)],
        ['d', vec(0, 1, 0)],
      ]),
    );
    expect(index.size).toBe(4);
    expect(keys(index, 3)).toEqual(['a-b', 'a-z', 'b-z']);
  });
});
