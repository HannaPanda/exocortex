import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AiRunChangedPage,
  type AiRunChangesResponse,
  type AiRunRevertResponse,
  type AiRunStructureChange,
  type AiRunStructureKind,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  pageFingerprint,
  type ProseMirrorDocument,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { DocumentDiffService } from '../documents/document-diff.service';
import { DocumentsService } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';

import {
  countChanges,
  type CreatedPageFacts,
  foldRunWrites,
  judgeCreated,
  judgeMove,
  judgeRename,
  judgeRunBlocks,
  type PageNow,
  pageSkipReason,
  type RunMove,
  type RunPageWrites,
  runSessionExternalId,
  type StructureVerdict,
} from './run-changes';

interface LoadedRun {
  id: string;
  workspaceId: string;
  createdById: string;
  finishedAt: Date | null;
}

/** One page of the run, with what judging its structure found. */
interface JudgedPage {
  page: RunPageWrites;
  /** `null` when the page is gone or not the caller's to read. */
  now: PageNow | null;
  rename: StructureVerdict | null;
  move: StructureVerdict | null;
  created: StructureVerdict | null;
}

/** The order an undo takes its steps in, so none of them takes another's page along. */
const UNDO_ORDER: readonly AiRunStructureKind[] = ['moved', 'renamed'];

/**
 * What one AI run changed, and taking it back (issue #248).
 *
 * The run's writes come out of the agent write journal (ADR-022), where every
 * run of the built-in AI is its own session; the way back is the ordinary
 * block restore of the snapshot comparison (`DocumentDiffService`, issue #77),
 * once per page, so the open editing session is told and the restore is
 * audited exactly as if a person had ticked those blocks by hand. Nothing new
 * restores anything here: this service only decides which blocks may go back.
 *
 * Reading is open to whoever may read the run; taking it back is the person
 * it ran for, and only through the browser. Whether a run was a mistake is
 * not a judgement an agent is in a position to make (ADR-022), and an agent
 * that disagrees can still restore single blocks with
 * `exo_page_restore_blocks`, which names what it does one page at a time.
 */
@Injectable()
export class RunChangesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly diffs: DocumentDiffService,
    private readonly documents: DocumentsService,
  ) {}

  async changes(runId: string, userId: string): Promise<AiRunChangesResponse> {
    const run = await this.loadRun(runId, userId);
    return this.judge(run, userId);
  }

  async revert(input: {
    runId: string;
    userId: string;
    correlationId: string;
  }): Promise<AiRunRevertResponse> {
    const run = await this.loadRun(input.runId, input.userId);
    if (run.createdById !== input.userId) {
      throw AppError.forbidden('Only the person a run worked for can take it back');
    }
    const plan = await this.judge(run, input.userId);

    const restored = new Map<string, AiRunRevertResponse['restored'][number]>();
    const note = (
      page: AiRunChangedPage,
      patch: { blockIds?: string[]; kind?: AiRunStructureKind },
    ): void => {
      const entry = restored.get(page.documentId) ?? {
        documentId: page.documentId,
        title: page.title,
        blockIds: [],
        structure: [],
      };
      if (patch.blockIds !== undefined) entry.blockIds.push(...patch.blockIds);
      if (patch.kind !== undefined) entry.structure.push(patch.kind);
      restored.set(page.documentId, entry);
    };
    const attempt = async (
      page: AiRunChangedPage,
      step: string,
      operation: () => Promise<unknown>,
    ): Promise<boolean> => {
      try {
        await operation();
        return true;
      } catch (error) {
        // One page that cannot be restored must not take the others with it;
        // the reading afterwards names it as it is.
        this.logger.warn('Taking an AI run back skipped a step', {
          runId: run.id,
          documentId: page.documentId,
          step,
          correlationId: input.correlationId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };
    const revertible = (page: AiRunChangedPage, kind: AiRunStructureKind): boolean =>
      page.structure.some((change) => change.kind === kind && change.state === 'revertible');

    // Moves and renames first, so a page the run moved under a page it
    // created is out from under it before that page goes to the trash.
    for (const kind of UNDO_ORDER) {
      for (const page of plan.pages) {
        if (!revertible(page, kind)) continue;
        const done = await attempt(page, kind, () =>
          kind === 'moved' ? this.moveBack(run, page, input) : this.renameBack(page, input),
        );
        if (done) note(page, { kind });
      }
    }

    for (const page of plan.pages) {
      const blockIds = page.blocks
        .filter((block) => block.state === 'revertible')
        .map((block) => block.blockId);
      if (blockIds.length === 0 || page.snapshotId === null) continue;
      const snapshotId = page.snapshotId;
      // Applied to what the page holds at this moment, never to the state
      // judged above, so a block typed into between the two is still taken
      // from the page as it is (issue #77).
      const done = await attempt(page, 'blocks', () =>
        this.diffs.restoreBlocks({
          documentId: page.documentId,
          snapshotId,
          blockIds,
          userId: input.userId,
          correlationId: input.correlationId,
        }),
      );
      if (done) note(page, { blockIds });
    }

    // New pages last, and only the topmost ones: the trash takes a page's
    // subtree along, and every page in it was judged revertible with it.
    const trashing = new Set(
      plan.pages.filter((page) => revertible(page, 'created')).map((page) => page.documentId),
    );
    for (const page of plan.pages) {
      if (!trashing.has(page.documentId)) continue;
      const parentId = await this.parentOf(page.documentId);
      const done =
        parentId !== null && trashing.has(parentId)
          ? true
          : await attempt(page, 'created', () =>
              this.documents.archive({
                documentId: page.documentId,
                userId: input.userId,
                correlationId: input.correlationId,
              }),
            );
      if (done) note(page, { kind: 'created' });
    }

    this.logger.info('AI run taken back', {
      runId: run.id,
      correlationId: input.correlationId,
      pages: restored.size,
      blocks: [...restored.values()].reduce((sum, page) => sum + page.blockIds.length, 0),
      structure: [...restored.values()].reduce((sum, page) => sum + page.structure.length, 0),
      changedSince: plan.changedSince,
    });

    return {
      runId: run.id,
      restored: [...restored.values()],
      after: await this.judge(run, input.userId),
    };
  }

  /** Puts a page back under the parent it had before the run, next to its old neighbour. */
  private async moveBack(
    run: LoadedRun,
    page: AiRunChangedPage,
    input: { userId: string; correlationId: string },
  ): Promise<void> {
    const move = await this.foldedMove(run, page.documentId);
    if (move === null) return;
    const siblings = await this.prisma.document.findMany({
      where: {
        workspaceId: move.fromWorkspaceId,
        parentId: move.fromParentId,
        archivedAt: null,
        id: { not: page.documentId },
      },
      select: { id: true, orderKey: true },
    });
    // Order keys compare as plain strings (`generateOrderKey`): the sibling
    // just before the old key is the one to stand behind again.
    const ordered = siblings.toSorted((left, right) =>
      left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0,
    );
    const before = ordered.filter((sibling) => sibling.orderKey < move.fromOrderKey).at(-1);
    const after = before === undefined ? ordered[0] : undefined;
    await this.documents.move({
      documentId: page.documentId,
      userId: input.userId,
      correlationId: input.correlationId,
      request: {
        parentId: move.fromParentId,
        afterSiblingId: before?.id ?? null,
        beforeSiblingId: after?.id ?? null,
      },
    });
  }

  private async renameBack(
    page: AiRunChangedPage,
    input: { userId: string; correlationId: string },
  ): Promise<void> {
    const change = page.structure.find((entry) => entry.kind === 'renamed');
    if (change?.fromTitle === null || change?.fromTitle === undefined) return;
    await this.documents.update({
      documentId: page.documentId,
      userId: input.userId,
      correlationId: input.correlationId,
      request: { title: change.fromTitle },
    });
  }

  private async foldedMove(run: LoadedRun, documentId: string): Promise<RunMove | null> {
    const rows = await this.journal(run);
    return foldRunWrites(rows).find((page) => page.documentId === documentId)?.move ?? null;
  }

  private async parentOf(documentId: string): Promise<string | null> {
    const row = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { parentId: true },
    });
    return row?.parentId ?? null;
  }

  private async loadRun(runId: string, userId: string): Promise<LoadedRun> {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: runId },
      select: { id: true, workspaceId: true, createdById: true, finishedAt: true },
    });
    if (run === null) throw AppError.notFound('AI run');
    await this.access.requireRole(run.workspaceId, userId);
    return run;
  }

  private async journal(run: LoadedRun) {
    const session = await this.prisma.agentSession.findUnique({
      where: {
        userId_externalId: { userId: run.createdById, externalId: runSessionExternalId(run.id) },
      },
      select: {
        writes: {
          orderBy: { createdAt: 'asc' },
          select: {
            documentId: true,
            documentTitle: true,
            snapshotBeforeId: true,
            writtenBlocks: true,
            action: true,
            structure: true,
            pageAfter: true,
          },
        },
      },
    });
    return session?.writes ?? [];
  }

  private async judge(run: LoadedRun, userId: string): Promise<AiRunChangesResponse> {
    const folded = foldRunWrites(await this.journal(run));
    const judged = await this.judgeStructure(run, folded, userId);
    const parents = await this.parentTitles(judged, userId);

    const pages: AiRunChangedPage[] = [];
    for (const entry of judged) {
      pages.push(await this.judgePage(entry, parents));
    }

    let revertible = 0;
    let changedSince = 0;
    for (const page of pages) {
      const counts = countChanges(page.blocks);
      revertible += counts.revertible;
      changedSince += counts.changed_since;
      for (const change of page.structure) {
        if (change.state === 'revertible') revertible += 1;
        if (change.state === 'changed_since') changedSince += 1;
      }
    }
    return {
      runId: run.id,
      pages,
      revertible,
      changedSince,
      canRevert: run.createdById === userId,
    };
  }

  /**
   * Judges every rename, move and new page of the run (issue #248). Moves
   * first, because whether a page the run created may go to the trash
   * depends on what stands under it once the run's moves are undone.
   */
  private async judgeStructure(
    run: LoadedRun,
    folded: readonly RunPageWrites[],
    userId: string,
  ): Promise<JudgedPage[]> {
    const ids = folded.map((page) => page.documentId);
    const rows = await this.prisma.document.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        parentId: true,
        workspaceId: true,
        orderKey: true,
        archivedAt: true,
        type: true,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const readable = new Set<string>();
    for (const id of ids) {
      if (await this.mayRead(id, userId)) readable.add(id);
    }
    const nowOf = (id: string): PageNow | null => {
      const row = byId.get(id);
      if (row === undefined || !readable.has(id)) return null;
      return {
        title: row.title,
        parentId: row.parentId,
        workspaceId: row.workspaceId,
        orderKey: row.orderKey,
        archived: row.archivedAt !== null,
        type: row.type,
      };
    };

    const judged = new Map<string, JudgedPage>();
    for (const page of folded) {
      const now = nowOf(page.documentId);
      const structural = now !== null && !page.created;
      judged.set(page.documentId, {
        page,
        now,
        rename: structural && page.rename !== null ? judgeRename(page.rename, now) : null,
        move:
          structural && page.move !== null
            ? judgeMove(page.move, now, await this.parentAvailable(page.move))
            : null,
        created: null,
      });
    }

    const createdIds = new Set(
      folded.filter((page) => page.created).map((page) => page.documentId),
    );
    if (createdIds.size > 0) {
      const children = await this.prisma.document.findMany({
        where: { parentId: { in: [...createdIds] }, archivedAt: null },
        select: { id: true, parentId: true },
      });
      const touched = await this.propertiesTouchedAfter(run, [...createdIds]);
      const contents = await this.contentFingerprints([...createdIds]);
      const visiting = new Set<string>();
      const verdictOf = (id: string): StructureVerdict | null => {
        const entry = judged.get(id);
        if (entry === undefined || entry.now === null) return null;
        if (entry.created !== null) return entry.created;
        // A cycle cannot happen in a tree; refusing one is cheaper than proving it.
        if (visiting.has(id)) return { state: 'changed_since', reason: 'children' };
        visiting.add(id);
        let under: CreatedPageFacts['children'] = 'none';
        for (const child of children) {
          if (child.parentId !== id) continue;
          const own = judged.get(child.id);
          if (own?.page.created === true) {
            if (verdictOf(child.id)?.state !== 'revertible') under = 'held';
          } else if (own?.move?.state !== 'revertible') {
            under = 'foreign';
            break;
          }
        }
        visiting.delete(id);
        const verdict = judgeCreated(entry.page, {
          now: entry.now,
          contentNow: contents.get(id) ?? null,
          propertiesTouched: touched.has(id),
          children: under,
        });
        entry.created = verdict;
        return verdict;
      };
      for (const id of createdIds) verdictOf(id);
    }

    return [...judged.values()];
  }

  private async mayRead(documentId: string, userId: string): Promise<boolean> {
    try {
      const context = await this.access.requireDocumentContext(documentId, userId);
      assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
      return true;
    } catch {
      return false;
    }
  }

  /** The parent a move would go back to: there, in its workspace, not in the trash. */
  private async parentAvailable(move: RunMove): Promise<boolean> {
    if (move.fromParentId === null) return true;
    const parent = await this.prisma.document.findUnique({
      where: { id: move.fromParentId },
      select: { workspaceId: true, archivedAt: true },
    });
    return (
      parent !== null && parent.workspaceId === move.fromWorkspaceId && parent.archivedAt === null
    );
  }

  /**
   * Rows whose property values changed after the run ended. The run's own
   * writes happen before it ends, so anything later is somebody else's; a
   * run that has not ended yet is not taken back at all.
   */
  private async propertiesTouchedAfter(run: LoadedRun, ids: string[]): Promise<Set<string>> {
    if (run.finishedAt === null) return new Set(ids);
    const values = await this.prisma.documentPropertyValue.findMany({
      where: { documentId: { in: ids }, updatedAt: { gt: run.finishedAt } },
      select: { documentId: true },
    });
    return new Set(values.map((value) => value.documentId));
  }

  private async contentFingerprints(ids: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.documentContent.findMany({
      where: { documentId: { in: ids } },
      select: { documentId: true, yjsState: true },
    });
    const fingerprints = new Map<string, string>();
    for (const row of rows) {
      try {
        fingerprints.set(row.documentId, pageFingerprint(yjsStateToProseMirrorJson(row.yjsState)));
      } catch {
        // Not derivable: no fingerprint, so the page reads as edited and stays.
      }
    }
    return fingerprints;
  }

  /** The titles of the parents a move names, where the caller may read them. */
  private async parentTitles(
    judged: readonly JudgedPage[],
    userId: string,
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const { page, move } of judged) {
      if (move === null || page.move === null) continue;
      if (page.move.fromParentId !== null) ids.add(page.move.fromParentId);
      if (page.move.toParentId !== null) ids.add(page.move.toParentId);
    }
    const titles = new Map<string, string>();
    for (const id of ids) {
      try {
        const context = await this.access.requireDocumentContext(id, userId);
        assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
        titles.set(id, context.document.title);
      } catch {
        // Not the caller's to read: the move is named without the title.
      }
    }
    return titles;
  }

  private async judgePage(
    { page, now, rename, move, created }: JudgedPage,
    parents: ReadonlyMap<string, string>,
  ): Promise<AiRunChangedPage> {
    const base = {
      documentId: page.documentId,
      workspaceId: null,
      title: page.title,
      snapshotId: page.snapshotId,
      blocks: [],
      structure: [],
    };
    if (now === null) {
      // Gone, or not the caller's to read: the title the journal kept is
      // all that may be said about it.
      return { ...base, skipped: 'unavailable' };
    }

    const structure = structureChanges({ page, rename, move, created }, parents);

    const known = { ...base, workspaceId: now.workspaceId, title: now.title, structure };
    // A page the run created goes back as a whole, into the trash; its
    // blocks are part of that and have no undo of their own.
    if (page.created) return { ...known, skipped: null };

    const reason = pageSkipReason(page);
    if (reason === 'no_snapshot' && structure.length > 0) return { ...known, skipped: null };
    if (reason !== null || page.snapshotId === null) {
      return { ...known, skipped: reason ?? 'no_snapshot' };
    }

    const [snapshot, content] = await Promise.all([
      this.prisma.documentSnapshot.findUnique({
        where: { id: page.snapshotId },
        select: { documentId: true, yjsState: true },
      }),
      this.prisma.documentContent.findUnique({
        where: { documentId: page.documentId },
        select: { yjsState: true },
      }),
    ]);
    if (snapshot === null || snapshot.documentId !== page.documentId || content === null) {
      // The snapshot aged out on the page's own schedule (ADR-022).
      return { ...known, skipped: 'no_snapshot' };
    }

    let before: ProseMirrorDocument;
    let current: ProseMirrorDocument;
    try {
      before = yjsStateToProseMirrorJson(snapshot.yjsState);
      current = yjsStateToProseMirrorJson(content.yjsState);
    } catch {
      return { ...known, skipped: 'not_recorded' };
    }

    return { ...known, skipped: null, blocks: judgeRunBlocks(before, current, page) };
  }
}

/** The page's rename, move and creation, as the reading names them. */
function structureChanges(
  { page, rename, move, created }: Omit<JudgedPage, 'now'>,
  parents: ReadonlyMap<string, string>,
): AiRunStructureChange[] {
  const structure: AiRunStructureChange[] = [];
  const change = (
    kind: AiRunStructureKind,
    verdict: StructureVerdict,
    details: Partial<AiRunStructureChange> = {},
  ): AiRunStructureChange => ({
    kind,
    state: verdict.state,
    reason: verdict.reason,
    fromTitle: null,
    toTitle: null,
    fromParentId: null,
    fromParentTitle: null,
    toParentId: null,
    toParentTitle: null,
    ...details,
  });
  if (created !== null) structure.push(change('created', created));
  if (move !== null && page.move !== null) {
    const { fromParentId, toParentId } = page.move;
    structure.push(
      change('moved', move, {
        fromParentId,
        toParentId,
        fromParentTitle: fromParentId === null ? null : (parents.get(fromParentId) ?? null),
        toParentTitle: toParentId === null ? null : (parents.get(toParentId) ?? null),
      }),
    );
  }
  if (rename !== null && page.rename !== null) {
    structure.push(
      change('renamed', rename, { fromTitle: page.rename.from, toTitle: page.rename.to }),
    );
  }

  return structure;
}
