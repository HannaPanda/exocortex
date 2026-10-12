/**
 * The similarity lines of the knowledge map, computed in this process
 * (issue #189).
 *
 * The same nearest-neighbour question as "Verwandte Notizen", asked for every
 * page at once. Asked of pgvector that is one HNSW walk per page, and a
 * workspace of 770 pages took 5.7 s. Asked here it is a dot-product matrix,
 * about 0.7 s for the same workspace, which is still too long to block the
 * API's event loop every time a run re-embeds the page it just wrote. So the
 * index is incremental: it keeps every pair above the floor (a few thousand,
 * because the matrix is sparse above it), and a changed page costs one row of
 * the matrix, about 2 ms. The first build yields between rows.
 *
 * Pure apart from that yield, so the arithmetic is tested without a database.
 */

export interface SimilarPair {
  source: string;
  target: string;
  similarity: number;
}

/** Parses pgvector's text form `[0.1,0.2,…]` into a unit vector; `null` for anything else. */
export function parseVector(text: string): Float32Array | null {
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const parts = text.slice(1, -1).split(',');
  const vector = new Float32Array(parts.length);
  let sum = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const value = Number(parts[index]);
    if (!Number.isFinite(value)) return null;
    vector[index] = value;
    sum += value * value;
  }
  if (sum === 0) return null;
  const length = Math.sqrt(sum);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / length;
  }
  return vector;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let k = 0; k < a.length; k += 1) sum += (a[k] ?? 0) * (b[k] ?? 0);
  return sum;
}

/** Rows between two yields of the first build: about 40 ms of work each. */
const ROWS_PER_SLICE = 40;

const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * Every pair of pages at or above a cosine floor, kept up to date one page at
 * a time. `version` is whatever identifies a page's vector (its creation
 * stamp); a page whose version is unchanged is never recomputed.
 */
export class SimilarityIndex {
  private readonly vectors = new Map<string, { version: string; vector: Float32Array }>();
  /** Symmetric: `neighbours.get(a).get(b) === neighbours.get(b).get(a)`. */
  private readonly neighbours = new Map<string, Map<string, number>>();

  constructor(private readonly minSimilarity: number) {}

  get size(): number {
    return this.vectors.size;
  }

  /** The pages whose vector this index holds at a different version, or not at all. */
  stale(versions: ReadonlyMap<string, string>): string[] {
    const stale: string[] = [];
    for (const [documentId, version] of versions) {
      if (this.vectors.get(documentId)?.version !== version) stale.push(documentId);
    }
    return stale;
  }

  /**
   * Brings the index to `versions`: pages missing from it are dropped, and the
   * vectors in `changed` replace or add theirs. A page in `versions` that is
   * stale but absent from `changed` (its vector would not parse) is dropped too.
   */
  async apply(
    versions: ReadonlyMap<string, string>,
    changed: ReadonlyMap<string, Float32Array>,
  ): Promise<void> {
    for (const documentId of [...this.vectors.keys()]) {
      if (
        !versions.has(documentId) ||
        this.vectors.get(documentId)?.version !== versions.get(documentId)
      ) {
        this.remove(documentId);
      }
    }
    let sinceYield = 0;
    for (const [documentId, vector] of changed) {
      const version = versions.get(documentId);
      if (version === undefined) continue;
      this.insert(documentId, version, vector);
      sinceYield += 1;
      if (sinceYield >= ROWS_PER_SLICE) {
        sinceYield = 0;
        await yieldToLoop();
      }
    }
  }

  /**
   * Each page's `perPage` nearest neighbours, as undirected pairs without
   * duplicates. A pair is kept when it is among the nearest of either end, so
   * a page on the edge of a cluster keeps a line even when its neighbour has
   * closer ones.
   */
  pairs(perPage: number): SimilarPair[] {
    const pairs = new Map<string, SimilarPair>();
    for (const [documentId, around] of this.neighbours) {
      const nearest = [...around.entries()].sort((a, b) => b[1] - a[1]).slice(0, perPage);
      for (const [other, similarity] of nearest) {
        const [source, target] = documentId < other ? [documentId, other] : [other, documentId];
        pairs.set(`${source}|${target}`, { source, target, similarity });
      }
    }
    return [...pairs.values()];
  }

  private insert(documentId: string, version: string, vector: Float32Array): void {
    this.remove(documentId);
    const own = new Map<string, number>();
    for (const [other, entry] of this.vectors) {
      const similarity = dot(vector, entry.vector);
      if (similarity < this.minSimilarity) continue;
      own.set(other, similarity);
      let theirs = this.neighbours.get(other);
      if (theirs === undefined) {
        theirs = new Map();
        this.neighbours.set(other, theirs);
      }
      theirs.set(documentId, similarity);
    }
    this.vectors.set(documentId, { version, vector });
    this.neighbours.set(documentId, own);
  }

  private remove(documentId: string): void {
    const own = this.neighbours.get(documentId);
    if (own !== undefined) {
      for (const other of own.keys()) this.neighbours.get(other)?.delete(documentId);
    }
    this.neighbours.delete(documentId);
    this.vectors.delete(documentId);
  }
}
