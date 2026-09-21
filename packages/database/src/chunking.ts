/**
 * Cutting a page into the passages one vector can honestly stand for (issue #36).
 *
 * ADR-020 embeds a page as one vector built from its title and the first 24000
 * characters. For the overwhelming majority of pages that is the truth: a page
 * here averages 1500 characters, one thought, one vector. It stops being the
 * truth exactly where it hurts most, on the long infrastructure pages that get
 * asked about the most often: a page of twenty thousand characters about twenty
 * subjects becomes the average of twenty subjects, and the average is about
 * nothing.
 *
 * So a long page gets extra rows in `document_embedding`, one per passage,
 * beside the whole-document row rather than instead of it. Beside, because the
 * whole-document vector is what `findRelated` compares pages with, and because
 * a page is more than the sum of its paragraphs.
 *
 * The passages are cut at block boundaries. `plainText` (see
 * `packages/editor/src/plain-text.ts`) joins the top-level blocks with a single
 * newline, so a line here is a block: a paragraph, a heading, a list item, a
 * table serialised into one line. A single block is usually far too short to
 * embed on its own, which is why blocks are packed up to a target size instead
 * of embedded one by one.
 */

/**
 * Characters one passage aims for.
 *
 * Roughly 500 tokens of German prose: long enough that a paragraph keeps the
 * context of the paragraphs around it, short enough that a hit points at a
 * passage a reader can take in rather than at a section.
 */
export const CHUNK_TARGET_CHARS = 2000;

/**
 * How much of the previous passage the next one repeats.
 *
 * A thought that happens to straddle a boundary would otherwise be in neither
 * vector. The overlap is taken from the end of the last block of the previous
 * passage, cut at a word boundary.
 */
export const CHUNK_OVERLAP_CHARS = 200;

/**
 * Shortest passage that is worth a row of its own. A trailing remnant below
 * this is appended to the passage before it instead: a vector built from two
 * sentences says almost nothing and would still take a place in the result
 * list.
 */
export const CHUNK_MIN_TAIL_CHARS = 400;

/**
 * Ceiling on the passages of one page.
 *
 * Without it a single pathological page (this deployment has one of 2.1 million
 * characters) would own a thousand rows and a thousand embedding calls. Sixty
 * four passages cover about 128000 characters, five times what the
 * whole-document vector reaches; beyond that full-text search is the honest
 * answer and it still sees the whole page.
 */
export const MAX_CHUNKS_PER_DOCUMENT = 64;

/**
 * Shortest page that is cut up at all.
 *
 * Below it the packing would produce one full passage plus a remnant that gets
 * merged straight back into it, so the work would buy a copy of the
 * whole-document vector. The same number decides in SQL which pages the
 * backfill still owes passages to, so it has to be a property of the page text
 * alone, not of the text with its title in front.
 */
export const CHUNK_THRESHOLD_CHARS = CHUNK_TARGET_CHARS + CHUNK_MIN_TAIL_CHARS;

/** Prefix of the `blockId` a passage is stored under. */
export const CHUNK_BLOCK_ID_PREFIX = 'chunk:';

export interface EmbeddingChunk {
  /** Position in the page, counted from zero. */
  ordinal: number;
  /** The passage itself, blocks joined by newlines, without the page title. */
  text: string;
  /**
   * The heading this passage sits under, when the caller handed the headings
   * over. `null` means there is none above it, not that none were looked for.
   */
  anchor: PassageAnchor | null;
}

/**
 * A heading, and the offset in the plain text from which it applies.
 *
 * Structurally the same thing `plainTextHeadingAnchors` produces in
 * `@exocortex/editor`; declared here so a caller may also say "from here on,
 * no heading". The search projection appends attachment text after the page
 * (issue #101), and a passage out of a PDF sits under no heading of the page
 * it hangs on.
 */
export interface PassageAnchor {
  offset: number;
  /** `null` when the heading itself carries no identifier, or for the marker above. */
  blockId: string | null;
  /** The heading and the headings it sits under, outermost first. Empty for the marker. */
  path: readonly string[];
}

export interface ChunkOptions {
  targetChars?: number;
  overlapChars?: number;
  minTailChars?: number;
  maxChunks?: number;
  thresholdChars?: number;
  /**
   * The page's headings by offset, ascending. Passing none means no passage
   * carries one, which is what a caller without the page's structure says.
   */
  anchors?: readonly PassageAnchor[];
}

/**
 * The `blockId` a passage is stored under.
 *
 * The column was meant for the block identities of ADR-003, and a passage is a
 * run of blocks rather than one of them, so it carries a key of its own.
 * Zero-padded because it is read by humans in `psql` and sorts there.
 */
export function chunkBlockId(ordinal: number): string {
  return `${CHUNK_BLOCK_ID_PREFIX}${String(ordinal).padStart(4, '0')}`;
}

/** Whether a stored `blockId` is one of ours. */
export function isChunkBlockId(blockId: string | null): boolean {
  return blockId !== null && blockId.startsWith(CHUNK_BLOCK_ID_PREFIX);
}

/**
 * The passages of one page, or an empty list when the page is short enough that
 * its whole-document vector already says what it is about.
 */
export function chunkPlainText(plainText: string, options: ChunkOptions = {}): EmbeddingChunk[] {
  const target = options.targetChars ?? CHUNK_TARGET_CHARS;
  const overlap = options.overlapChars ?? CHUNK_OVERLAP_CHARS;
  const minTail = options.minTailChars ?? CHUNK_MIN_TAIL_CHARS;
  const maxChunks = options.maxChunks ?? MAX_CHUNKS_PER_DOCUMENT;
  const threshold = options.thresholdChars ?? CHUNK_THRESHOLD_CHARS;

  if (plainText.length <= threshold) return [];

  const chunks: PackedChunk[] = [];
  let current = '';
  /** The part of `current` that was repeated from the passage before it. */
  let carried = '';
  /** Where the first block of `current` that is not repeated text began. */
  let offset = 0;
  let opened = false;

  for (const block of blocksOf(plainText, target)) {
    if (current.length > 0 && current.length + 1 + block.text.length > target) {
      chunks.push({ text: current, offset });
      if (chunks.length >= maxChunks) return numbered(chunks, options.anchors);
      carried = overlapTail(current, overlap);
      current = carried;
      opened = false;
    }
    if (!opened) {
      offset = block.offset;
      opened = true;
    }
    current = current.length === 0 ? block.text : `${current}\n${block.text}`;
  }

  if (current.length > 0 && current !== carried) {
    const previous = chunks[chunks.length - 1];
    if (previous !== undefined && current.length < minTail) {
      // The remnant goes back where it came from, minus the overlap it repeats,
      // so the merged passage does not say the same sentence twice. It keeps
      // the offset of the passage it joins, which is where that one still
      // starts.
      const added = carried.length > 0 ? current.slice(carried.length).replace(/^\n/, '') : current;
      if (added.length > 0) previous.text = `${previous.text}\n${added}`;
    } else {
      chunks.push({ text: current, offset });
    }
  }

  return numbered(chunks, options.anchors);
}

interface PackedChunk {
  text: string;
  /** Offset in the plain text the passage starts at, so it can find its heading. */
  offset: number;
}

/**
 * The packed passages, each under the last heading that begins at or before
 * it.
 *
 * Both lists run forwards, so the headings are walked once for all passages
 * rather than searched per passage.
 */
function numbered(
  chunks: readonly PackedChunk[],
  anchors: readonly PassageAnchor[] | undefined,
): EmbeddingChunk[] {
  let above: PassageAnchor | null = null;
  let next = 0;
  return chunks.map((chunk, ordinal) => {
    while (anchors !== undefined && next < anchors.length) {
      const candidate = anchors[next];
      if (candidate === undefined || candidate.offset > chunk.offset) break;
      above = candidate;
      next += 1;
    }
    // An anchor without a heading is the marker saying the text from here on
    // belongs to no section of the page.
    return { ordinal, text: chunk.text, anchor: above?.path.length === 0 ? null : above };
  });
}

/**
 * The blocks of a page, empty lines dropped and anything longer than a whole
 * passage cut down.
 *
 * One block can be longer than the target on its own: a pasted transcript, a
 * table, a code block. Packing would then produce a passage above the target no
 * matter what, so such a block is cut at word boundaries first.
 */
function blocksOf(plainText: string, target: number): { text: string; offset: number }[] {
  const blocks: { text: string; offset: number }[] = [];
  let lineStart = 0;
  for (const line of plainText.split('\n')) {
    let at = lineStart + (line.length - line.trimStart().length);
    lineStart += line.length + 1;
    let rest = line.trim();
    if (rest.length === 0) continue;
    while (rest.length > target) {
      const window = rest.slice(0, target);
      const space = window.lastIndexOf(' ');
      // A cut in the first half would leave a fragment too short to mean
      // anything; there the hard cut at the target is the better one.
      const cut = space > target / 2 ? space : target;
      blocks.push({ text: rest.slice(0, cut).trim(), offset: at });
      at += cut;
      rest = rest.slice(cut).trim();
    }
    if (rest.length > 0) blocks.push({ text: rest, offset: at });
  }
  return blocks;
}

/** The tail of a passage that the next one repeats, cut at a word boundary. */
function overlapTail(chunk: string, overlap: number): string {
  if (overlap <= 0) return '';
  const lines = chunk.split('\n');
  const last = lines[lines.length - 1] ?? '';
  if (last.length <= overlap) return last;
  const tail = last.slice(last.length - overlap);
  const space = tail.indexOf(' ');
  return space === -1 ? tail : tail.slice(space + 1);
}
