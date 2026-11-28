import {
  type AiRunChangedBlock,
  type AiRunChangedBlockState,
  type AiRunPageSkipReason,
  type AiRunStandingBlock,
  type AiRunStructureHeldReason,
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

/** The run behind an agent session, or `null` when the session is not a run's (issue #235). */
export function runIdFromSessionExternalId(externalId: string): string | null {
  return externalId.startsWith(SESSION_PREFIX) ? externalId.slice(SESSION_PREFIX.length) : null;
}

/** One journal row, as far as an undo needs it. */
export interface RunJournalRow {
  documentId: string;
  documentTitle: string | null;
  snapshotBeforeId: string | null;
  writtenBlocks: unknown;
  /** The event that produced the row; `document.created` marks a page the run made. */
  action?: string;
  /** What a rename or a move changed (`AgentWriteStructure`). */
  structure?: unknown;
  /** The page's whole content as the write left it. */
  pageAfter?: string | null;
}

/** A rename by the run, folded: the title before its first, the title after its last. */
export interface RunRename {
  from: string;
  to: string;
}

/** A move by the run, folded the same way. */
export interface RunMove {
  fromParentId: string | null;
  toParentId: string | null;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  fromOrderKey: string;
  toOrderKey: string;
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
  /** Per block, the block that stood right before it (`prev`), where it was recorded. */
  prev: Map<string, string>;
  /** The run created this page. */
  created: boolean;
  /** The page's whole content as the run's last write that recorded it left it. */
  pageAfter: string | null;
  /** The page's title after the run's last write to it, as the journal kept it. */
  titleAfter: string | null;
  rename: RunRename | null;
  move: RunMove | null;
}

interface WrittenEntry {
  id: string;
  after: string | null;
  group: number;
  prev: string | null;
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
        prev: new Map(),
        created: false,
        pageAfter: null,
        titleAfter: null,
        rename: null,
        move: null,
      };
      pages.set(row.documentId, page);
    }
    if (row.documentTitle !== null) {
      page.title = row.documentTitle;
      page.titleAfter = row.documentTitle;
    }
    if (row.action === 'document.created') page.created = true;
    if (typeof row.pageAfter === 'string') page.pageAfter = row.pageAfter;
    foldStructure(page, row.structure);
    if (row.snapshotBeforeId === null) return;
    page.snapshotId ??= row.snapshotBeforeId;
    const written = parseWrittenBlocks(row.writtenBlocks);
    if (written === null) {
      page.unrecorded = true;
      return;
    }
    for (const block of written) {
      page.blocks.set(block.id, block.after);
      if (block.prev !== null) page.prev.set(block.id, block.prev);
      page.groups.union(block.id, `write:${String(writeIndex)}:${String(block.group)}`);
    }
  });
  return [...pages.values()].map(dropNoOps);
}

/**
 * Folds one row's rename or move into the page: the earliest "from" is where
 * back is, the latest "to" is what the run left.
 */
function foldStructure(page: RunPageWrites, value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const entry = value as Record<string, unknown>;
  if (entry.kind === 'renamed') {
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') return;
    page.rename = { from: page.rename?.from ?? entry.from, to: entry.to };
    return;
  }
  if (entry.kind !== 'moved') return;
  const parent = (key: string): string | null | undefined => {
    const id = entry[key];
    return id === null || typeof id === 'string' ? id : undefined;
  };
  const fromParentId = parent('fromParentId');
  const toParentId = parent('toParentId');
  const { fromWorkspaceId, toWorkspaceId, fromOrderKey, toOrderKey } = entry;
  if (
    fromParentId === undefined ||
    toParentId === undefined ||
    typeof fromWorkspaceId !== 'string' ||
    typeof toWorkspaceId !== 'string' ||
    typeof fromOrderKey !== 'string' ||
    typeof toOrderKey !== 'string'
  ) {
    return;
  }
  const earlier = page.move;
  page.move = {
    fromParentId: earlier === null ? fromParentId : earlier.fromParentId,
    fromWorkspaceId: earlier?.fromWorkspaceId ?? fromWorkspaceId,
    fromOrderKey: earlier?.fromOrderKey ?? fromOrderKey,
    toParentId,
    toWorkspaceId,
    toOrderKey,
  };
}

/** A rename back to the same title, or a move back to the same place, did nothing. */
function dropNoOps(page: RunPageWrites): RunPageWrites {
  const rename = page.rename !== null && page.rename.from === page.rename.to ? null : page.rename;
  const move =
    page.move !== null &&
    page.move.fromParentId === page.move.toParentId &&
    page.move.fromWorkspaceId === page.move.toWorkspaceId &&
    page.move.fromOrderKey === page.move.toOrderKey
      ? null
      : page.move;
  return { ...page, rename, move };
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
    const { id, after, group, prev } = entry as {
      id?: unknown;
      after?: unknown;
      group?: unknown;
      prev?: unknown;
    };
    if (typeof id !== 'string') return null;
    if (after !== null && typeof after !== 'string') return null;
    blocks.push({
      id,
      after,
      group: typeof group === 'number' ? group : 0,
      prev: typeof prev === 'string' ? prev : null,
    });
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
  page: Pick<RunPageWrites, 'blocks' | 'groups'> & Partial<Pick<RunPageWrites, 'prev'>>,
): AiRunChangedBlock[] {
  const original = topLevelFingerprints(before);
  const standing = new StandingFinder(before, current, page.blocks, page.prev ?? new Map());
  const readings = readBlocks(original, topLevelFingerprints(current), page.blocks, (blockId) =>
    standing.occupied(blockId),
  );
  const { states, numbers } = judgeGroups(readings, page.groups);
  const beforeNodes = nodesById(before);
  const currentNodes = nodesById(current);

  const judged: AiRunChangedBlock[] = [];
  for (const blockId of readings.keys()) {
    const root = page.groups.find(blockId);
    const left = page.blocks.get(blockId) ?? null;
    const state = states.get(root) ?? 'changed_since';
    const now = currentNodes.get(blockId);
    // A block the run wrote that is gone since carries the run's text, which
    // is not what the undo holds back; what stands in its place is.
    const shown = now ?? (left === null ? beforeNodes.get(blockId) : undefined);
    judged.push({
      blockId,
      group: numbers.get(root) ?? 0,
      change: changeOf(original.has(blockId), left),
      state,
      nodeType: (now ?? beforeNodes.get(blockId))?.type ?? null,
      excerpt: excerptOf(shown),
      standing: state === 'changed_since' ? standing.claim(blockId, root) : [],
    });
  }
  const order = pageOrder(before, current);
  return judged.sort(
    (left, right) =>
      (order.get(left.blockId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.blockId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * What stands where a held-back block of the run stood (issue #248).
 *
 * A block somebody rewrote under a new identifier is gone from the page, and
 * its replacement is a block neither the run nor the page before it knew:
 * "foreign". Those are found by place: right after the run's block when it
 * still stands, right after the block that stood before it when it is gone.
 * That place is read from the journal (`prev`) and, for rows from before it
 * was recorded, from the page before the run. Each foreign block is claimed
 * by one change only, the first that stood there.
 */
class StandingFinder {
  private readonly order: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly foreign = new Set<string>();
  private readonly nodes: Map<string, ProseMirrorNode>;
  private readonly beforePrev = new Map<string, string>();
  private readonly claimed = new Set<string>();
  private readonly claimedByGroup = new Map<string, Set<string>>();

  constructor(
    before: ProseMirrorDocument,
    current: ProseMirrorDocument,
    written: ReadonlyMap<string, string | null>,
    private readonly prev: ReadonlyMap<string, string>,
  ) {
    const known = new Set<string>();
    let last = '';
    for (const node of before.content ?? []) {
      const id = blockIdOf(node);
      if (id === null) continue;
      known.add(id);
      this.beforePrev.set(id, last);
      last = id;
    }
    this.nodes = nodesById(current);
    for (const id of this.nodes.keys()) {
      this.index.set(id, this.order.length);
      this.order.push(id);
      if (!known.has(id) && !written.has(id)) this.foreign.add(id);
    }
  }

  /**
   * Whether somebody else's block stands where this gone block of the run
   * stood. A paragraph the run added and somebody then rewrote is gone too,
   * and the page is not "as before" just because its identifier is.
   */
  occupied(blockId: string): boolean {
    if (this.index.has(blockId)) return false;
    const anchor = this.anchorOf(blockId);
    if (anchor === null) return false;
    const next = this.order[anchor === '' ? 0 : (this.index.get(anchor) ?? -1) + 1];
    return next !== undefined && this.foreign.has(next);
  }

  claim(blockId: string, group: string): AiRunStandingBlock[] {
    const anchor = this.index.has(blockId) ? blockId : this.anchorOf(blockId);
    if (anchor === null) return [];
    const ownGroup = this.claimedByGroup.get(group) ?? new Set<string>();
    this.claimedByGroup.set(group, ownGroup);
    const standing: AiRunStandingBlock[] = [];
    const start = anchor === '' ? 0 : (this.index.get(anchor) ?? -1) + 1;
    for (let position = start; position < this.order.length; position += 1) {
      const id = this.order[position];
      if (id === undefined || !this.foreign.has(id)) break;
      if (this.claimed.has(id)) {
        if (ownGroup.has(id)) continue;
        break;
      }
      this.claimed.add(id);
      ownGroup.add(id);
      const node = this.nodes.get(id);
      standing.push({ blockId: id, nodeType: node?.type ?? null, excerpt: excerptOf(node) });
    }
    return standing;
  }

  /** The nearest block before this one that still stands, `''` for the start. */
  private anchorOf(blockId: string): string | null {
    const seen = new Set<string>();
    let current = blockId;
    for (;;) {
      if (seen.has(current)) return null;
      seen.add(current);
      const previous = this.prev.get(current) ?? this.beforePrev.get(current);
      if (previous === undefined) return null;
      if (previous === '' || this.index.has(previous)) return previous;
      current = previous;
    }
  }
}

/** Each block the run touched, compared with before the run and with now. */
function readBlocks(
  original: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>,
  left: ReadonlyMap<string, string | null>,
  occupied: (blockId: string) => boolean,
): Map<string, BlockReading> {
  const readings = new Map<string, BlockReading>();
  for (const [blockId, leftAs] of left) {
    const was = original.get(blockId) ?? null;
    // Added and taken out again within the same run: nothing ever stood there.
    if (was === null && leftAs === null) continue;
    const is = now.get(blockId) ?? null;
    // A block the run added is gone, but somebody's own stands in its place:
    // rewritten, not taken back.
    if (was === null && is === null && occupied(blockId)) {
      readings.set(blockId, 'other');
      continue;
    }
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

/** The page as it stands now, as far as judging its structure needs it. */
export interface PageNow {
  title: string;
  parentId: string | null;
  workspaceId: string;
  orderKey: string;
  archived: boolean;
  type: string;
}

/** A structural change's verdict: one of the three states, and why it is held. */
export interface StructureVerdict {
  state: AiRunChangedBlockState;
  reason: AiRunStructureHeldReason | null;
}

const held = (reason: AiRunStructureHeldReason): StructureVerdict => ({
  state: 'changed_since',
  reason,
});
const REVERTIBLE: StructureVerdict = { state: 'revertible', reason: null };
const REVERTED: StructureVerdict = { state: 'reverted', reason: null };

/** A rename goes back while the page still carries the run's title. */
export function judgeRename(rename: RunRename, now: PageNow): StructureVerdict {
  if (now.title === rename.from) return REVERTED;
  if (now.archived) return held('trashed');
  return now.title === rename.to ? REVERTIBLE : held('renamed');
}

/**
 * A move goes back while the page still stands where the run put it: under
 * the same parent, and for a move among its siblings at the same place. The
 * old parent has to be there to go back to, and a move between workspaces
 * is named only, because the whole subtree went along and may have grown.
 */
export function judgeMove(move: RunMove, now: PageNow, parentAvailable: boolean): StructureVerdict {
  const reordered = move.fromParentId === move.toParentId;
  const standsAt = (parentId: string | null, workspaceId: string, orderKey: string): boolean =>
    now.parentId === parentId &&
    now.workspaceId === workspaceId &&
    (!reordered || now.orderKey === orderKey);
  if (standsAt(move.fromParentId, move.fromWorkspaceId, move.fromOrderKey)) return REVERTED;
  if (move.fromWorkspaceId !== move.toWorkspaceId) return held('other_workspace');
  if (now.archived) return held('trashed');
  if (!standsAt(move.toParentId, move.toWorkspaceId, move.toOrderKey)) return held('moved');
  return parentAvailable ? REVERTIBLE : held('parent_gone');
}

/** What decides whether a page the run created may go to the trash. */
export interface CreatedPageFacts {
  now: PageNow;
  /** `pageFingerprint` of the page as it stands now; `null` when it did not derive. */
  contentNow: string | null;
  /** A property value of the row changed after the run ended. */
  propertiesTouched: boolean;
  /** `foreign`: a page somebody else put under it; `held`: one of the run's own that stays. */
  children: 'none' | 'foreign' | 'held';
}

/**
 * A page the run created goes to the trash while nobody has been in it:
 * the content and the title as the run left them, no property changed after
 * the run, and nothing under it that the trash would take along and that
 * the run did not put there itself. A database or a project is named only:
 * its rows, files and settings are more than one fingerprint can vouch for.
 */
export function judgeCreated(
  page: Pick<RunPageWrites, 'pageAfter' | 'titleAfter'>,
  facts: CreatedPageFacts,
): StructureVerdict {
  if (facts.now.archived) return REVERTED;
  if (facts.now.type !== 'PAGE') return held('not_a_page');
  if (page.pageAfter === null) return held('not_recorded');
  if (facts.contentNow !== page.pageAfter || facts.propertiesTouched) return held('edited');
  if (page.titleAfter !== null && facts.now.title !== page.titleAfter) return held('renamed');
  if (facts.children !== 'none') return held('children');
  return REVERTIBLE;
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
