import { Inject, Injectable } from '@nestjs/common';

import { AuthorizationError } from '@exocortex/auth';
import {
  type ChangesetDecisionOutcome,
  type DocumentBlockWriteRequest,
  type DocumentPatchRequest,
  type DocumentSectionWriteRequest,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentEditService } from '../documents/document-edit.service';
import { DocumentsService } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';
import { type WorkItemActor } from '../work-items/work-item-actor';
import { PARTICIPANT_TO_PRISMA } from '../work-items/work-item-mapper';

import { type ChangeRow, KIND_FROM_PRISMA } from './changeset-mapper';

/**
 * The answers of a write that mean "this change no longer fits the page".
 * Everything else a write refuses (a page grown too large, an archived page,
 * a person without the right) leaves the change pending: somebody can fix
 * that and apply again, where a stale change has to be proposed anew.
 */
const STALE_CODES = new Set<string>([
  'document_content_conflict',
  'document_block_not_found',
  'document_block_range_invalid',
  'document_heading_not_found',
  'document_heading_not_unique',
  'document_patch_not_found',
  'document_patch_not_unique',
  'not_found',
]);

interface Applied {
  snapshotId: string | null;
  revision: string;
  documentId: string;
  createdDocumentId: string | null;
}

function requestOf(row: ChangeRow): Record<string, unknown> {
  const value = row.request;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Carries out the changes a person chose (issue #141, ADR-070).
 *
 * Each change is replayed through the ordinary write it stands for, as the
 * person applying it, with the revision the change expects: the write takes
 * its snapshot first, tells the open editors, records its activity, and
 * refuses a page that moved. Nothing here writes a page itself.
 *
 * One at a time, in the order they were proposed. When one lands, the other
 * pending changes of the same set on the same page move their expectation to
 * the revision it produced, because a set does not go stale on its own
 * writes; a write by anybody else still makes them stale.
 */
@Injectable()
export class ChangesetApplyService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly edits: DocumentEditService,
    private readonly content: DocumentContentService,
    private readonly documents: DocumentsService,
  ) {}

  async applyOne(input: {
    changesetId: string;
    workspaceId: string;
    change: ChangeRow;
    actor: WorkItemActor;
    note: string | null;
    correlationId: string;
  }): Promise<ChangesetDecisionOutcome> {
    const { change } = input;
    let applied: Applied;
    try {
      applied = await this.write(input);
    } catch (error) {
      return this.refused(input, error);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.changesetChange.update({
        where: { id: change.id },
        data: {
          status: 'APPLIED',
          ...this.decision(input.actor, input.note),
          errorCode: null,
          snapshotId: applied.snapshotId,
          createdDocumentId: applied.createdDocumentId,
          ...(applied.createdDocumentId === null ? {} : { documentId: applied.createdDocumentId }),
        },
      });
      // The set's own write does not make its siblings stale.
      await tx.changesetChange.updateMany({
        where: {
          changesetId: input.changesetId,
          documentId: applied.documentId,
          status: 'PENDING',
          id: { not: change.id },
        },
        data: { expectedRevision: new Date(applied.revision) },
      });
    });
    return { changeId: change.id, outcome: 'applied', errorCode: null, message: null };
  }

  /** What deciding writes on the row, whoever decides and however. */
  decision(actor: WorkItemActor, note: string | null) {
    return {
      decidedAt: new Date(),
      decidedByKind: PARTICIPANT_TO_PRISMA[actor.kind],
      decidedById: actor.userId,
      decisionNote: note,
    };
  }

  private async write(input: {
    workspaceId: string;
    change: ChangeRow;
    actor: WorkItemActor;
    correlationId: string;
  }): Promise<Applied> {
    const { change, actor } = input;
    const request = requestOf(change);
    const kind = KIND_FROM_PRISMA[change.kind];

    if (kind === 'create') {
      const created = await this.documents.create({
        workspaceId: input.workspaceId,
        userId: actor.userId,
        correlationId: input.correlationId,
        request: {
          title: change.title ?? '',
          parentId: change.parentId,
          type: 'PAGE',
        },
      });
      const written = await this.content.write({
        documentId: created.id,
        userId: actor.userId,
        correlationId: input.correlationId,
        source: 'api',
        growth: 'guarded',
        request: { markdown: String(request.markdown ?? ''), mode: 'replace' },
      });
      return {
        snapshotId: null,
        revision: written.yjsUpdatedAt,
        documentId: created.id,
        createdDocumentId: created.id,
      };
    }

    if (change.documentId === null || change.expectedRevision === null) {
      throw AppError.notFound('Document');
    }
    const expectedYjsUpdatedAt = change.expectedRevision.toISOString();
    const documentId = change.documentId;

    const written =
      kind === 'page'
        ? await this.content.write({
            documentId,
            userId: actor.userId,
            correlationId: input.correlationId,
            source: 'api',
            growth: 'guarded',
            request: {
              markdown: String(request.markdown ?? ''),
              mode: request.mode === 'append' ? 'append' : 'replace',
              expectedYjsUpdatedAt,
            },
          })
        : await this.edits.writeByKind({
            documentId,
            userId: actor.userId,
            correlationId: input.correlationId,
            source: 'api',
            kind,
            request: { ...request, expectedYjsUpdatedAt } as
              DocumentBlockWriteRequest | DocumentSectionWriteRequest | DocumentPatchRequest,
          });
    return {
      snapshotId: written.snapshotId,
      revision: written.yjsUpdatedAt,
      documentId,
      createdDocumentId: null,
    };
  }

  /**
   * A write that refused. Stale when the page moved or what the change
   * addressed is gone, which is written on the row and ends the change; any
   * other refusal leaves it pending and is only reported.
   */
  private async refused(
    input: { change: ChangeRow; actor: WorkItemActor; note: string | null },
    error: unknown,
  ): Promise<ChangesetDecisionOutcome> {
    const code =
      error instanceof AppError || error instanceof AuthorizationError ? String(error.code) : null;
    if (code === null) throw error;
    const message = error instanceof Error ? error.message : null;

    const stale = STALE_CODES.has(code) || (await this.pageGone(input.change, code));
    this.logger.info('A proposed change was not applied', {
      changeId: input.change.id,
      code,
      stale,
    });
    await this.prisma.changesetChange.update({
      where: { id: input.change.id },
      data: stale
        ? { status: 'STALE', errorCode: code, ...this.decision(input.actor, input.note) }
        : { errorCode: code },
    });
    return {
      changeId: input.change.id,
      outcome: stale ? 'stale' : 'failed',
      errorCode: code,
      message,
    };
  }

  /** A page deleted for good answers like one the caller may not see; tell them apart. */
  private async pageGone(change: ChangeRow, code: string): Promise<boolean> {
    if (code !== 'document_access_denied') return false;
    const id = change.documentId ?? change.parentId;
    if (id === null) return false;
    const row = await this.prisma.document.findUnique({ where: { id }, select: { id: true } });
    return row === null;
  }
}
