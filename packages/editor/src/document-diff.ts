import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { serializePlainText } from './plain-text';

/**
 * Structural diff between two states of the same page (issue #77).
 *
 * Two decisions shape everything below.
 *
 * The unit is the *top-level* block. A page's children are what a reader
 * points at when they say "this block moved"; a list item or a table row is
 * addressed through the block that contains it, the same way
 * `ADDRESSABLE_BLOCK_TYPES` is addressed through its container. A change
 * inside a list therefore shows up as a changed list with a word diff in it,
 * not as five separate rows nobody asked about.
 *
 * Matching runs on stable block identifiers first and on content only for what
 * is left over. That is the whole point: a block that moved carries its id with
 * it, so it is reported as moved rather than as a deletion plus an unrelated
 * insertion. Text similarity is deliberately *not* used to pair up blocks --
 * two paragraphs that happen to share a sentence are not the same block, and
 * guessing they are is how a diff starts lying about what happened.
 */

export type DocumentDiffSegmentKind = 'equal' | 'inserted' | 'removed';

export interface DocumentDiffSegment {
  kind: DocumentDiffSegmentKind;
  text: string;
}

export type DocumentDiffBlockKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DocumentDiffBlock {
  kind: DocumentDiffBlockKind;
  /**
   * True when the block sits in a different place than it did, judged by the
   * order of the blocks that exist in both states. Orthogonal to `kind`: a
   * block can move and change in the same edit.
   */
  moved: boolean;
  /**
   * The stable identifier, `null` for a block that never received one. Such a
   * block can be shown but not restored selectively, because there is nothing
   * to address it by.
   */
  blockId: string | null;
  /** ProseMirror node type of the block, in the state it exists in. */
  nodeType: string;
  /** Position among the top-level blocks, `null` on the side it is missing from. */
  beforeIndex: number | null;
  afterIndex: number | null;
  /** Plain text of the block, truncated; `null` on the side it is missing from. */
  beforeText: string | null;
  afterText: string | null;
  /** Word-level diff, filled for `changed` blocks and empty otherwise. */
  segments: DocumentDiffSegment[];
  /**
   * True when the block was too long to diff word by word and the segments
   * fall back to "all of this replaced all of that".
   */
  coarse: boolean;
}

export interface DocumentDiffSummary {
  added: number;
  removed: number;
  changed: number;
  moved: number;
  unchanged: number;
}

export interface DocumentDiff {
  blocks: DocumentDiffBlock[];
  summary: DocumentDiffSummary;
  /** True when the page had more blocks than `maxBlocks` and the list is cut. */
  truncated: boolean;
}

export interface DocumentDiffOptions {
  /** Characters kept of a changed block's text. */
  maxTextLength?: number;
  /** Characters kept of an unchanged block's text: enough to recognize it. */
  maxUnchangedTextLength?: number;
  /** Blocks reported before the list is cut off. */
  maxBlocks?: number;
}

const DEFAULT_MAX_TEXT_LENGTH = 20_000;
const DEFAULT_MAX_UNCHANGED_TEXT_LENGTH = 200;
const DEFAULT_MAX_BLOCKS = 2_000;

/**
 * Upper bound on the word-diff table. The LCS below is O(n·m), so a pair of
 * very long blocks would otherwise turn a diff request into a compute job.
 * Past this, the block is reported as wholly replaced, which is what a reader
 * would conclude from a word diff of two unrelated walls of text anyway.
 */
const MAX_DIFF_PRODUCT = 250_000;

/** German labels for the block types a diff can name. */
export const DIFF_BLOCK_TYPE_LABELS: Readonly<Record<string, string>> = {
  paragraph: 'Absatz',
  heading: 'Überschrift',
  codeBlock: 'Codeblock',
  blockquote: 'Zitat',
  bulletList: 'Aufzählung',
  orderedList: 'Nummerierte Liste',
  taskList: 'Aufgabenliste',
  horizontalRule: 'Trennlinie',
  table: 'Tabelle',
  callout: 'Hinweis',
  details: 'Ausklappbarer Abschnitt',
  columnList: 'Spalten',
  blockMath: 'Formel',
  tableOfContents: 'Inhaltsverzeichnis',
  pageLink: 'Seitenverweis',
  breadcrumb: 'Pfad',
  databaseEmbed: 'Eingebettete Datenbank',
  savedQueryEmbed: 'Eingebettete Suche',
  transclusion: 'Eingebetteter Inhalt',
  fileAttachment: 'Datei',
  image: 'Bild',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
  embed: 'Einbettung',
  bookmark: 'Lesezeichen',
};

/** The visible name of a block type; the raw type name when it has no label. */
export function describeBlockType(nodeType: string): string {
  return DIFF_BLOCK_TYPE_LABELS[nodeType] ?? nodeType;
}

/** The stable identifier of a block, or `null` when it carries none. */
export function blockIdOf(node: ProseMirrorNode): string | null {
  const value = node.attrs?.[BLOCK_ID_ATTRIBUTE];
  return isValidBlockId(value) ? value : null;
}

/** Plain text of a single block, derived the same way the search index is. */
export function blockPlainText(node: ProseMirrorNode): string {
  return serializePlainText({ type: 'doc', content: [node] });
}

/**
 * Deterministic serialization used for equality only.
 *
 * Object keys are sorted so that two structurally identical nodes compare
 * equal regardless of the order Yjs happened to hand the attributes back in.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Splits text into alternating runs of whitespace and non-whitespace, so a
 * diff lands on word boundaries and the segments can be concatenated back into
 * the original text without losing a space.
 */
function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

function pushSegment(
  segments: DocumentDiffSegment[],
  kind: DocumentDiffSegmentKind,
  text: string,
): void {
  if (text.length === 0) return;
  const last = segments[segments.length - 1];
  if (last !== undefined && last.kind === kind) {
    last.text += text;
    return;
  }
  segments.push({ kind, text });
}

/**
 * Word-level diff of two texts.
 *
 * Plain LCS over word tokens. Exported because the block diff is not the only
 * place that wants it: a property or title comparison reads the same way.
 */
export function diffText(before: string, after: string): DocumentDiffSegment[] {
  if (before === after) {
    const segments: DocumentDiffSegment[] = [];
    pushSegment(segments, 'equal', before);
    return segments;
  }

  const source = tokenize(before);
  const target = tokenize(after);
  const segments: DocumentDiffSegment[] = [];

  // Shared prefix and suffix first: it is the common case (one word edited in
  // a long paragraph) and it keeps the table below small.
  let prefix = 0;
  while (prefix < source.length && prefix < target.length && source[prefix] === target[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < source.length - prefix &&
    suffix < target.length - prefix &&
    source[source.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const head = source.slice(0, prefix).join('');
  const tail = source.slice(source.length - suffix).join('');
  const middleSource = source.slice(prefix, source.length - suffix);
  const middleTarget = target.slice(prefix, target.length - suffix);

  pushSegment(segments, 'equal', head);

  if (middleSource.length * middleTarget.length > MAX_DIFF_PRODUCT) {
    pushSegment(segments, 'removed', middleSource.join(''));
    pushSegment(segments, 'inserted', middleTarget.join(''));
    pushSegment(segments, 'equal', tail);
    return segments;
  }

  const columns = middleTarget.length + 1;
  const table = new Uint32Array((middleSource.length + 1) * columns);
  const lengthAt = (row: number, column: number): number => table[row * columns + column] ?? 0;
  for (let row = middleSource.length - 1; row >= 0; row -= 1) {
    for (let column = middleTarget.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] =
        middleSource[row] === middleTarget[column]
          ? lengthAt(row + 1, column + 1) + 1
          : Math.max(lengthAt(row + 1, column), lengthAt(row, column + 1));
    }
  }

  let i = 0;
  let j = 0;
  while (i < middleSource.length && j < middleTarget.length) {
    const left = middleSource[i] ?? '';
    const right = middleTarget[j] ?? '';
    if (left === right) {
      pushSegment(segments, 'equal', left);
      i += 1;
      j += 1;
    } else if (lengthAt(i + 1, j) >= lengthAt(i, j + 1)) {
      pushSegment(segments, 'removed', left);
      i += 1;
    } else {
      pushSegment(segments, 'inserted', right);
      j += 1;
    }
  }
  pushSegment(segments, 'removed', middleSource.slice(i).join(''));
  pushSegment(segments, 'inserted', middleTarget.slice(j).join(''));
  pushSegment(segments, 'equal', tail);
  return segments;
}

interface MatchedPair {
  beforeIndex: number;
  afterIndex: number;
}

/**
 * Indices of a longest strictly increasing subsequence, used to decide which
 * matched blocks count as moved: the ones that stayed in order are the
 * backbone, everything else is what a reader sees jump.
 */
function longestIncreasingSubsequence(values: number[]): Set<number> {
  if (values.length === 0) return new Set();
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] ?? 0;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((tails[middle] ?? 0) < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    tailIndex[low] = i;
    previous[i] = low > 0 ? (tailIndex[low - 1] ?? -1) : -1;
  }

  const keep = new Set<number>();
  let cursor = tailIndex[tails.length - 1] ?? -1;
  while (cursor !== -1) {
    keep.add(cursor);
    cursor = previous[cursor] ?? -1;
  }
  return keep;
}

/**
 * Pairs up the blocks that carry no identifier, by exact content, in order.
 *
 * A document written before block identifiers existed, or one whose state was
 * rebuilt, has blocks with nothing to match on. Identical content in the same
 * relative order is the only honest pairing left; anything looser would invent
 * a relationship.
 */
function matchByContent(
  beforeKeys: { index: number; key: string }[],
  afterKeys: { index: number; key: string }[],
): MatchedPair[] {
  if (beforeKeys.length === 0 || afterKeys.length === 0) return [];
  if (beforeKeys.length * afterKeys.length > MAX_DIFF_PRODUCT) return [];

  const columns = afterKeys.length + 1;
  const table = new Uint32Array((beforeKeys.length + 1) * columns);
  const lengthAt = (row: number, column: number): number => table[row * columns + column] ?? 0;
  const keyOf = (entries: { index: number; key: string }[], at: number): string =>
    entries[at]?.key ?? '';
  for (let row = beforeKeys.length - 1; row >= 0; row -= 1) {
    for (let column = afterKeys.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] =
        keyOf(beforeKeys, row) === keyOf(afterKeys, column)
          ? lengthAt(row + 1, column + 1) + 1
          : Math.max(lengthAt(row + 1, column), lengthAt(row, column + 1));
    }
  }

  const pairs: MatchedPair[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeKeys.length && j < afterKeys.length) {
    const left = beforeKeys[i];
    const right = afterKeys[j];
    if (left === undefined || right === undefined) break;
    if (left.key === right.key) {
      pairs.push({ beforeIndex: left.index, afterIndex: right.index });
      i += 1;
      j += 1;
    } else if (lengthAt(i + 1, j) >= lengthAt(i, j + 1)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Identifiers that appear exactly once, so a match is unambiguous. */
function uniqueIdIndex(blocks: ProseMirrorNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  const positions = new Map<string, number>();
  blocks.forEach((node, index) => {
    const id = blockIdOf(node);
    if (id === null) return;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!positions.has(id)) positions.set(id, index);
  });
  for (const [id, count] of counts) {
    if (count > 1) positions.delete(id);
  }
  return positions;
}

interface TextLimits {
  maxTextLength: number;
  maxUnchangedTextLength: number;
}

interface BlockMatching {
  /** Blocks present in both states, keyed by their position in each. */
  pairs: MatchedPair[];
  matchedBefore: Set<number>;
  partnerOfAfter: Map<number, number>;
  afterIndexOfBefore: Map<number, number>;
  /** Matched blocks whose order relative to the others changed. */
  movedAfterIndexes: Set<number>;
}

/** Pairs the two states up: identifiers first, identical leftovers second. */
function matchBlocks(
  beforeBlocks: ProseMirrorNode[],
  afterBlocks: ProseMirrorNode[],
): BlockMatching {
  const beforeIds = uniqueIdIndex(beforeBlocks);
  const afterIds = uniqueIdIndex(afterBlocks);

  const pairs: MatchedPair[] = [];
  const matchedBefore = new Set<number>();
  const matchedAfter = new Set<number>();
  for (const [id, afterIndex] of afterIds) {
    const beforeIndex = beforeIds.get(id);
    if (beforeIndex === undefined) continue;
    pairs.push({ beforeIndex, afterIndex });
    matchedBefore.add(beforeIndex);
    matchedAfter.add(afterIndex);
  }

  const leftoverBefore = beforeBlocks
    .map((node, index) => ({ index, key: stableStringify(node) }))
    .filter((entry) => !matchedBefore.has(entry.index));
  const leftoverAfter = afterBlocks
    .map((node, index) => ({ index, key: stableStringify(node) }))
    .filter((entry) => !matchedAfter.has(entry.index));
  for (const pair of matchByContent(leftoverBefore, leftoverAfter)) {
    pairs.push(pair);
    matchedBefore.add(pair.beforeIndex);
    matchedAfter.add(pair.afterIndex);
  }

  pairs.sort((left, right) => left.afterIndex - right.afterIndex);
  const keptInOrder = longestIncreasingSubsequence(pairs.map((pair) => pair.beforeIndex));
  const movedAfterIndexes = new Set<number>();
  const partnerOfAfter = new Map<number, number>();
  const afterIndexOfBefore = new Map<number, number>();
  pairs.forEach((pair, position) => {
    if (!keptInOrder.has(position)) movedAfterIndexes.add(pair.afterIndex);
    partnerOfAfter.set(pair.afterIndex, pair.beforeIndex);
    afterIndexOfBefore.set(pair.beforeIndex, pair.afterIndex);
  });

  return { pairs, matchedBefore, partnerOfAfter, afterIndexOfBefore, movedAfterIndexes };
}

interface RemovedPlacement {
  /** Removed blocks to show before the block at this position in the new state. */
  beforeAfterIndex: Map<number, number[]>;
  /** Removed blocks with no surviving block after them. */
  atEnd: number[];
}

/**
 * Decides where a removed block is shown: directly before the surviving block
 * that followed it. That is the place a reader looks for it, and it keeps the
 * list readable as the page rather than as two stacked lists.
 */
function placeRemovedBlocks(
  beforeBlocks: ProseMirrorNode[],
  matching: BlockMatching,
): RemovedPlacement {
  const nextSurvivor = new Map<number, number>();
  let anchor: number | null = null;
  for (let index = beforeBlocks.length - 1; index >= 0; index -= 1) {
    if (matching.matchedBefore.has(index)) {
      anchor = index;
      continue;
    }
    if (anchor !== null) nextSurvivor.set(index, anchor);
  }

  const beforeAfterIndex = new Map<number, number[]>();
  const atEnd: number[] = [];
  for (let index = 0; index < beforeBlocks.length; index += 1) {
    if (matching.matchedBefore.has(index)) continue;
    const survivor = nextSurvivor.get(index);
    const anchorAfterIndex =
      survivor === undefined ? undefined : matching.afterIndexOfBefore.get(survivor);
    if (anchorAfterIndex === undefined) {
      atEnd.push(index);
      continue;
    }
    const bucket = beforeAfterIndex.get(anchorAfterIndex);
    if (bucket === undefined) beforeAfterIndex.set(anchorAfterIndex, [index]);
    else bucket.push(index);
  }
  return { beforeAfterIndex, atEnd };
}

function describeOneSided(
  node: ProseMirrorNode,
  kind: 'added' | 'removed',
  index: number,
  limits: TextLimits,
): DocumentDiffBlock {
  const text = truncate(blockPlainText(node), limits.maxTextLength);
  return {
    kind,
    moved: false,
    blockId: blockIdOf(node),
    nodeType: node.type,
    beforeIndex: kind === 'removed' ? index : null,
    afterIndex: kind === 'added' ? index : null,
    beforeText: kind === 'removed' ? text : null,
    afterText: kind === 'added' ? text : null,
    segments: [],
    coarse: false,
  };
}

/** The entry for a block both states have: unchanged, or changed word by word. */
function describePair(
  previousNode: ProseMirrorNode,
  node: ProseMirrorNode,
  position: { beforeIndex: number; afterIndex: number; moved: boolean },
  limits: TextLimits,
): DocumentDiffBlock {
  const common = {
    moved: position.moved,
    blockId: blockIdOf(node),
    nodeType: node.type,
    beforeIndex: position.beforeIndex,
    afterIndex: position.afterIndex,
  };

  if (stableStringify(previousNode) === stableStringify(node)) {
    return {
      ...common,
      kind: 'unchanged',
      beforeText: truncate(blockPlainText(previousNode), limits.maxUnchangedTextLength),
      afterText: truncate(blockPlainText(node), limits.maxUnchangedTextLength),
      segments: [],
      coarse: false,
    };
  }

  const beforeText = truncate(blockPlainText(previousNode), limits.maxTextLength);
  const afterText = truncate(blockPlainText(node), limits.maxTextLength);
  return {
    ...common,
    kind: 'changed',
    beforeText,
    afterText,
    // Text alone can be equal while the block changed (a link, a colour, a
    // list marker). Saying "changed" with no visible difference is honest;
    // inventing a word diff would not be.
    segments: diffText(beforeText, afterText),
    coarse: tokenize(beforeText).length * tokenize(afterText).length > MAX_DIFF_PRODUCT,
  };
}

function summarize(blocks: DocumentDiffBlock[]): DocumentDiffSummary {
  const summary: DocumentDiffSummary = { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 0 };
  for (const block of blocks) {
    summary[block.kind] += 1;
    if (block.moved) summary.moved += 1;
  }
  return summary;
}

/**
 * Compares two states of the same page, block by block.
 *
 * `before` is the older state and `after` the newer one, which is what makes
 * "added" and "removed" mean what a reader expects. The result is ordered the
 * way the newer document reads, with removed blocks slotted in where they used
 * to be, so the list can be read top to bottom as the page.
 */
export function diffDocuments(
  before: ProseMirrorDocument,
  after: ProseMirrorDocument,
  options: DocumentDiffOptions = {},
): DocumentDiff {
  const limits: TextLimits = {
    maxTextLength: options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    maxUnchangedTextLength: options.maxUnchangedTextLength ?? DEFAULT_MAX_UNCHANGED_TEXT_LENGTH,
  };
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;

  const beforeBlocks = before.content ?? [];
  const afterBlocks = after.content ?? [];
  const matching = matchBlocks(beforeBlocks, afterBlocks);
  const removed = placeRemovedBlocks(beforeBlocks, matching);

  const blocks: DocumentDiffBlock[] = [];
  const emitRemoved = (beforeIndex: number): void => {
    const node = beforeBlocks[beforeIndex];
    if (node !== undefined) blocks.push(describeOneSided(node, 'removed', beforeIndex, limits));
  };

  for (let afterIndex = 0; afterIndex < afterBlocks.length; afterIndex += 1) {
    for (const beforeIndex of removed.beforeAfterIndex.get(afterIndex) ?? []) {
      emitRemoved(beforeIndex);
    }
    const node = afterBlocks[afterIndex];
    if (node === undefined) continue;

    const beforeIndex = matching.partnerOfAfter.get(afterIndex);
    const previousNode = beforeIndex === undefined ? undefined : beforeBlocks[beforeIndex];
    if (beforeIndex === undefined || previousNode === undefined) {
      blocks.push(describeOneSided(node, 'added', afterIndex, limits));
      continue;
    }
    blocks.push(
      describePair(
        previousNode,
        node,
        { beforeIndex, afterIndex, moved: matching.movedAfterIndexes.has(afterIndex) },
        limits,
      ),
    );
  }

  for (const beforeIndex of removed.atEnd) emitRemoved(beforeIndex);

  return {
    blocks: blocks.slice(0, maxBlocks),
    summary: summarize(blocks),
    truncated: blocks.length > maxBlocks,
  };
}

export interface ApplyBlocksResult {
  document: ProseMirrorDocument;
  /** Identifiers that were put back into the newer document. */
  restored: string[];
  /** Identifiers that were removed again, because the older state had none. */
  removed: string[];
  /** Identifiers neither state knows; nothing was done for them. */
  missing: string[];
}

interface PlannedChanges {
  /** Positions in the current document to drop. */
  deletions: Set<number>;
  /** Blocks of the older state that have to be put back. */
  insertions: { sourceIndex: number; id: string; node: ProseMirrorNode }[];
  restored: string[];
  removed: string[];
  missing: string[];
}

/**
 * Decides per identifier what happens, and replaces in place what it can.
 *
 * `currentBlocks` is mutated for the replacements, because a block that still
 * exists keeps its position and nothing else has to move.
 */
function planBlockChanges(
  currentBlocks: ProseMirrorNode[],
  sourceBlocks: ProseMirrorNode[],
  blockIds: readonly string[],
): PlannedChanges {
  const sourceIds = uniqueIdIndex(sourceBlocks);
  const currentIds = uniqueIdIndex(currentBlocks);
  const plan: PlannedChanges = {
    deletions: new Set<number>(),
    insertions: [],
    restored: [],
    removed: [],
    missing: [],
  };

  for (const id of new Set(blockIds)) {
    const sourceIndex = sourceIds.get(id);
    const currentIndex = currentIds.get(id);
    const sourceNode = sourceIndex === undefined ? undefined : sourceBlocks[sourceIndex];

    if (sourceIndex === undefined || sourceNode === undefined) {
      if (currentIndex === undefined) plan.missing.push(id);
      else {
        plan.deletions.add(currentIndex);
        plan.removed.push(id);
      }
      continue;
    }
    if (currentIndex === undefined) {
      plan.insertions.push({ sourceIndex, id, node: sourceNode });
      continue;
    }
    currentBlocks[currentIndex] = sourceNode;
    plan.restored.push(id);
  }
  return plan;
}

/**
 * Where a block that no longer exists goes back in: after the nearest earlier
 * block of the old state that the current document still has. Falling back to
 * the top rather than to the bottom keeps a restored heading above its section
 * instead of stranding it at the end of the page.
 */
function insertionPosition(
  sourceBlocks: ProseMirrorNode[],
  sourceIndex: number,
  positionOfId: Map<string, number>,
): number {
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    const neighbour = sourceBlocks[index];
    const neighbourId = neighbour === undefined ? null : blockIdOf(neighbour);
    const neighbourPosition = neighbourId === null ? undefined : positionOfId.get(neighbourId);
    if (neighbourPosition !== undefined) return neighbourPosition + 1;
  }
  return 0;
}

/**
 * Takes selected blocks from an older state back into the current one
 * (issue #77).
 *
 * The rule is one sentence and holds for every kind of change a diff reports:
 * for each requested identifier, the older state decides. Present there, the
 * block is written into the current document -- replacing the block with that
 * identifier, or re-inserted next to its old neighbour when it no longer
 * exists. Absent there, the block is taken out of the current document, which
 * is what reverting an insertion means.
 *
 * That one rule is why a caller does not have to tell the server which kind of
 * change it is undoing, and why the answer cannot depend on which pair of
 * states the diff was computed from. A restore is always applied to what the
 * page holds right now, never to the state the diff was rendered against.
 *
 * Nested blocks are not addressable here: a list item is restored by restoring
 * its list, the same way `diffDocuments` reports it.
 */
export function applyBlocksFromDocument(
  current: ProseMirrorDocument,
  source: ProseMirrorDocument,
  blockIds: readonly string[],
): ApplyBlocksResult {
  const sourceBlocks = source.content ?? [];
  const currentBlocks = [...(current.content ?? [])];
  const plan = planBlockChanges(currentBlocks, sourceBlocks, blockIds);

  const positionOfId = new Map<string, number>();
  currentBlocks.forEach((node, index) => {
    const id = blockIdOf(node);
    if (id !== null) positionOfId.set(id, index);
  });

  plan.insertions.sort((left, right) => left.sourceIndex - right.sourceIndex);
  const pending = plan.insertions.map((insertion) => {
    plan.restored.push(insertion.id);
    return {
      at: insertionPosition(sourceBlocks, insertion.sourceIndex, positionOfId),
      node: insertion.node,
    };
  });

  const result: ProseMirrorNode[] = [];
  for (let index = 0; index <= currentBlocks.length; index += 1) {
    for (const entry of pending) {
      if (entry.at === index) result.push(entry.node);
    }
    const node = currentBlocks[index];
    if (node === undefined || plan.deletions.has(index)) continue;
    result.push(node);
  }

  return {
    // A document with no blocks is not a valid one, so a revert that took the
    // last block out lands on the empty page rather than on nothing.
    document: {
      ...current,
      type: 'doc',
      content: result.length === 0 ? [{ type: 'paragraph' }] : result,
    },
    restored: plan.restored,
    removed: plan.removed,
    missing: plan.missing,
  };
}
