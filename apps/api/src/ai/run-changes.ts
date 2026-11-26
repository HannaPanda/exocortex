import {
  type AiRunChangedBlock,
  type AiRunChangedBlockState,
  type AiRunPageSkipReason,
  type AiRunWrittenPages,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  blockIdOf,
  blockPlainText,
  type ProseMirrorDocument,
  type ProseMirrorNode,
  topLevelFingerprints,
  UnionFind,
} from '@exocortex/editor';

/**
 * The pure half of taking one AI run back (issue #248): folding the run's
 * journal into one entry per page, and judging every change it made against
 * the page as it stands now. No database, no state derivation; the service
 * around it loads and restores.
 */

const SESSION_PREFIX = 'ai-run-';

/** The session a run of the built-in AI writes under (ADR-022, `run-tools.ts`). */
export function runSessionExternalId(runId: string): string {
  return `${SESSION_PREFIX}${runId}`;
}

/** One journal row, as far as an undo needs it. */
export interface RunJournalRow {
  documentId: string;
  documentTitle: string | null;
  snapshotBeforeId: string | null;
  writtenBlocks: unknown;
}

/** Everything the run did to one page. */
export interface RunPageWrites {
  documentId: string;
  title: string | null;
  /** The snapshot before the run's first snapshotted write: where "back" is. */
  snapshotId: string | null;
  /** Per block, how the run's last write to it left it (`null`: removed). */
  blocks: Map<string, string | null>;
  /**
   * Blocks that only mean something together: a paragraph the run replaced
   * is the old block removed and a new one inserted, and putting one back
   * without the other would leave both or neither. Keys are block ids, every
   * block of `blocks` is in one group.
   */
  groups: UnionFind;
  /** A snapshotted write whose blocks are unknown. */
  unrecorded: boolean;
}

interface WrittenEntry {
  id: string;
  after: string | null;
  group: number;
}

/**
 * Folds the run's writes, oldest first, into one entry per page.
 *
 * The earliest snapshot is where back is, because a run that wrote a page
 * three times is one intervention; the latest fingerprint per block is what
 * the run left behind, because an earlier write of the same block was
 * overwritten by the run itself. Groups join across writes through the
 * blocks they share: replacing a paragraph and then rewording the
 * replacement is still one change.
 */
export function foldRunWrites(rows: readonly RunJournalRow[]): RunPageWrites[] {
  const pages = new Map<string, RunPageWrites>();
  rows.forEach((row, writeIndex) => {
    let page = pages.get(row.documentId);
    if (page === undefined) {
      page = {
        documentId: row.documentId,
        title: row.documentTitle,
        snapshotId: null,
        blocks: new Map(),
        groups: new UnionFind(),
        unrecorded: false,
      };
      pages.set(row.documentId, page);
    }
    if (row.documentTitle !== null) page.title = row.documentTitle;
    if (row.snapshotBeforeId === null) return;
    page.snapshotId ??= row.snapshotBeforeId;
    const written = parseWrittenBlocks(row.writtenBlocks);
    if (written === null) {
      page.unrecorded = true;
      return;
    }
    for (const block of written) {
      page.blocks.set(block.id, block.after);
      page.groups.union(block.id, `write:${String(writeIndex)}:${String(block.group)}`);
    }
  });
  return [...pages.values()];
}

/** Why a page cannot be judged block by block, before anything is loaded. */
export function pageSkipReason(page: RunPageWrites): AiRunPageSkipReason | null {
  if (page.snapshotId === null) return 'no_snapshot';
  if (page.unrecorded) return 'not_recorded';
  return null;
}

function parseWrittenBlocks(value: unknown): WrittenEntry[] | null {
  if (!Array.isArray(value)) return null;
  const blocks: WrittenEntry[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { id, after, group } = entry as { id?: unknown; after?: unknown; group?: unknown };
    if (typeof id !== 'string') return null;
    if (after !== null && typeof after !== 'string') return null;
    blocks.push({ id, after, group: typeof group === 'number' ? group : 0 });
  }
  return blocks;
}

const EXCERPT_LENGTH = 140;

function excerptOf(node: ProseMirrorNode | undefined): string | null {
  if (node === undefined) return null;
  const text = blockPlainText(node).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}

function nodesById(document: ProseMirrorDocument): Map<string, ProseMirrorNode> {
  const nodes = new Map<string, ProseMirrorNode>();
  for (const node of document.content ?? []) {
    const id = blockIdOf(node);
    if (id !== null) nodes.set(id, node);
  }
  return nodes;
}

type BlockReading = 'as_before' | 'as_left' | 'other';

/**
 * Where each change the run made stands now (ADR-055: blocks, not offsets).
 *
 * Every block is read on its own first: as it was before the run, exactly as
 * the run left it, or something else. Then a group is judged whole, and only
 * three answers are possible. Everything as the run left it: an undo may
 * restore the group. Everything as before: already back. Anything else --
 * one block reworded since, or the run's new paragraph deleted while the old
 * one never came back -- is somebody else's doing, and the group is named
 * instead of restored, because half a restore of an ambiguous change is
 * exactly the guess ADR-055 refuses to make. That includes the rare block the
 * open editor stored slightly differently from what the run wrote: "leave it
 * and say so" is the only safe reading of a block this cannot vouch for.
 */
export function judgeRunBlocks(
  before: ProseMirrorDocument,
  current: ProseMirrorDocument,
  page: Pick<RunPageWrites, 'blocks' | 'groups'>,
): AiRunChangedBlock[] {
  const original = topLevelFingerprints(before);
  const readings = readBlocks(original, topLevelFingerprints(current), page.blocks);
  const { states, numbers } = judgeGroups(readings, page.groups);
  const beforeNodes = nodesById(before);
  const currentNodes = nodesById(current);

  const judged: AiRunChangedBlock[] = [];
  for (const blockId of readings.keys()) {
    const root = page.groups.find(blockId);
    const left = page.blocks.get(blockId) ?? null;
    const shown = currentNodes.get(blockId) ?? beforeNodes.get(blockId);
    judged.push({
      blockId,
      group: numbers.get(root) ?? 0,
      change: changeOf(original.has(blockId), left),
      state: states.get(root) ?? 'changed_since',
      nodeType: shown?.type ?? null,
      excerpt: excerptOf(shown),
    });
  }
  const order = pageOrder(before, current);
  return judged.sort(
    (left, right) =>
      (order.get(left.blockId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.blockId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Each block the run touched, compared with before the run and with now. */
function readBlocks(
  original: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>,
  left: ReadonlyMap<string, string | null>,
): Map<string, BlockReading> {
  const readings = new Map<string, BlockReading>();
  for (const [blockId, leftAs] of left) {
    const was = original.get(blockId) ?? null;
    // Added and taken out again within the same run: nothing ever stood there.
    if (was === null && leftAs === null) continue;
    const is = now.get(blockId) ?? null;
    readings.set(blockId, is === was ? 'as_before' : is === leftAs ? 'as_left' : 'other');
  }
  return readings;
}

const STATE_OF_READING: Record<BlockReading, AiRunChangedBlockState> = {
  as_before: 'reverted',
  as_left: 'revertible',
  other: 'changed_since',
};

/** One state per group: unanimous, or somebody else has been here. */
function judgeGroups(
  readings: ReadonlyMap<string, BlockReading>,
  groups: Pick<UnionFind, 'find'>,
): { states: Map<string, AiRunChangedBlockState>; numbers: Map<string, number> } {
  const states = new Map<string, AiRunChangedBlockState>();
  const numbers = new Map<string, number>();
  for (const [blockId, reading] of readings) {
    const root = groups.find(blockId);
    if (!numbers.has(root)) numbers.set(root, numbers.size);
    const state = STATE_OF_READING[reading];
    const previous = states.get(root);
    states.set(root, previous === undefined || previous === state ? state : 'changed_since');
  }
  return { states, numbers };
}

function changeOf(existedBefore: boolean, left: string | null): AiRunChangedBlock['change'] {
  if (!existedBefore) return 'added';
  return left === null ? 'removed' : 'changed';
}

/**
 * In page order, so the list reads like the page; blocks no longer on it
 * follow in the order they stood before the run.
 */
function pageOrder(before: ProseMirrorDocument, current: ProseMirrorDocument): Map<string, number> {
  const order = new Map<string, number>();
  for (const [index, node] of (current.content ?? []).entries()) {
    const id = blockIdOf(node);
    if (id !== null) order.set(id, index);
  }
  const offset = order.size;
  for (const [index, node] of (before.content ?? []).entries()) {
    const id = blockIdOf(node);
    if (id !== null && !order.has(id)) order.set(id, offset + index);
  }
  return order;
}

/** How many changes (groups, not blocks) stand in each state. */
export function countChanges(
  blocks: readonly AiRunChangedBlock[],
): Record<AiRunChangedBlockState, number> {
  const seen = new Map<number, AiRunChangedBlockState>();
  for (const block of blocks) seen.set(block.group, block.state);
  const counts: Record<AiRunChangedBlockState, number> = {
    revertible: 0,
    changed_since: 0,
    reverted: 0,
  };
  for (const state of seen.values()) counts[state] += 1;
  return counts;
}

/**
 * The pages each of these runs wrote, from the journal alone (cheap: no state
 * is derived). Only the caller's own sessions are read, because a run of the
 * built-in AI writes under the account of the person it ran for.
 */
export async function readRunWrites(
  prisma: PrismaClient,
  userId: string,
  runIds: readonly string[],
): Promise<AiRunWrittenPages[]> {
  if (runIds.length === 0) return [];
  const sessions = await prisma.agentSession.findMany({
    where: { userId, externalId: { in: runIds.map(runSessionExternalId) } },
    select: {
      externalId: true,
      writes: {
        orderBy: { createdAt: 'asc' },
        select: { documentId: true, documentTitle: true, workspaceId: true },
      },
    },
  });
  const byRun = new Map<string, AiRunWrittenPages>();
  for (const session of sessions) {
    const runId = session.externalId.slice(SESSION_PREFIX.length);
    const pages = new Map<string, AiRunWrittenPages['pages'][number]>();
    for (const write of session.writes) {
      pages.set(write.documentId, {
        documentId: write.documentId,
        workspaceId: write.workspaceId,
        title: write.documentTitle ?? pages.get(write.documentId)?.title ?? null,
      });
    }
    if (pages.size === 0) continue;
    byRun.set(runId, { runId, pages: [...pages.values()] });
  }
  return runIds.flatMap((runId) => {
    const entry = byRun.get(runId);
    return entry === undefined ? [] : [entry];
  });
}
