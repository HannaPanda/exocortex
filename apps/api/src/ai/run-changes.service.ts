import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type AiRunChangedPage,
  type AiRunChangesResponse,
  type AiRunRevertResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type ProseMirrorDocument, yjsStateToProseMirrorJson } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { DocumentDiffService } from '../documents/document-diff.service';
import { PRISMA } from '../platform/platform.module';

import {
  countChanges,
  foldRunWrites,
  judgeRunBlocks,
  pageSkipReason,
  type RunPageWrites,
  runSessionExternalId,
} from './run-changes';

interface LoadedRun {
  id: string;
  workspaceId: string;
  createdById: string;
}

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

    const restored: AiRunRevertResponse['restored'] = [];
    for (const page of plan.pages) {
      const blockIds = page.blocks
        .filter((block) => block.state === 'revertible')
        .map((block) => block.blockId);
      if (blockIds.length === 0 || page.snapshotId === null) continue;
      try {
        // Applied to what the page holds at this moment, never to the state
        // judged above, so a block typed into between the two is still taken
        // from the page as it is (issue #77).
        await this.diffs.restoreBlocks({
          documentId: page.documentId,
          snapshotId: page.snapshotId,
          blockIds,
          userId: input.userId,
          correlationId: input.correlationId,
        });
        restored.push({ documentId: page.documentId, title: page.title, blockIds });
      } catch (error) {
        // One page that cannot be restored must not take the others with it;
        // the reading below names it as it is.
        this.logger.warn('Taking an AI run back skipped a page', {
          runId: run.id,
          documentId: page.documentId,
          correlationId: input.correlationId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info('AI run taken back', {
      runId: run.id,
      correlationId: input.correlationId,
      pages: restored.length,
      blocks: restored.reduce((sum, page) => sum + page.blockIds.length, 0),
      changedSince: plan.changedSince,
    });

    return { runId: run.id, restored, after: await this.judge(run, input.userId) };
  }

  private async loadRun(runId: string, userId: string): Promise<LoadedRun> {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: runId },
      select: { id: true, workspaceId: true, createdById: true },
    });
    if (run === null) throw AppError.notFound('AI run');
    await this.access.requireRole(run.workspaceId, userId);
    return run;
  }

  private async judge(run: LoadedRun, userId: string): Promise<AiRunChangesResponse> {
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
          },
        },
      },
    });

    const pages: AiRunChangedPage[] = [];
    for (const page of foldRunWrites(session?.writes ?? [])) {
      pages.push(await this.judgePage(page, userId));
    }

    let revertible = 0;
    let changedSince = 0;
    for (const page of pages) {
      const counts = countChanges(page.blocks);
      revertible += counts.revertible;
      changedSince += counts.changed_since;
    }
    return {
      runId: run.id,
      pages,
      revertible,
      changedSince,
      canRevert: run.createdById === userId,
    };
  }

  private async judgePage(page: RunPageWrites, userId: string): Promise<AiRunChangedPage> {
    const base = {
      documentId: page.documentId,
      workspaceId: null,
      title: page.title,
      snapshotId: page.snapshotId,
      blocks: [],
    };

    let workspaceId: string;
    let title: string | null;
    try {
      const context = await this.access.requireDocumentContext(page.documentId, userId);
      assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
      workspaceId = context.workspaceId;
      title = context.document.title;
    } catch {
      // Gone, or not the caller's to read: the title the journal kept is
      // all that may be said about it.
      return { ...base, skipped: 'unavailable' };
    }

    const reason = pageSkipReason(page);
    if (reason !== null || page.snapshotId === null) {
      return { ...base, workspaceId, title, skipped: reason ?? 'no_snapshot' };
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
      return { ...base, workspaceId, title, skipped: 'no_snapshot' };
    }

    let before: ProseMirrorDocument;
    let current: ProseMirrorDocument;
    try {
      before = yjsStateToProseMirrorJson(snapshot.yjsState);
      current = yjsStateToProseMirrorJson(content.yjsState);
    } catch {
      return { ...base, workspaceId, title, skipped: 'not_recorded' };
    }

    return {
      ...base,
      workspaceId,
      title,
      skipped: null,
      blocks: judgeRunBlocks(before, current, page),
    };
  }
}
