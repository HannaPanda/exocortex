import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canEditDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  appendPropertyFile,
  type FilesTarget,
  type PrismaClient,
  resolveFilesTarget,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

/** A resolved cell: the row, its column and the database both belong to. */
export interface CellTarget extends FilesTarget {
  rowId: string;
  propertyId: string;
}

/**
 * Uploads into a FILES column of a database row (issue #245).
 *
 * The upload itself is the ordinary one (`AttachmentsService.upload`); this
 * is the part that makes it the cell's: which cell, whether the caller may
 * write it, and appending the stored file to the value. In the attachments
 * module rather than the databases one because every upload path -- the
 * browser's multipart route, an agent's Base64 or URL upload and an upload
 * ticket (ADR-064) -- goes through the attachments service, and the databases
 * module already depends on this one.
 */
@Injectable()
export class CellFilesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * The cell an upload goes into. Writing into a cell is editing the row, so
   * it takes what editing the row's values takes, on top of the right to
   * upload. Asked again when an upload ticket is minted, so an agent hears
   * about a wrong column before it runs a script.
   */
  async resolveTarget(input: {
    userId: string;
    documentId: string | null;
    propertyId?: string | null;
    conversationId?: string;
  }): Promise<CellTarget> {
    const propertyId = input.propertyId ?? null;
    if (propertyId === null || input.documentId === null || input.conversationId !== undefined) {
      throw new AppError(
        'database_files_target_invalid',
        'A file for a FILES column needs the column and the row it goes into as documentId',
      );
    }
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));
    const target = await resolveFilesTarget(this.prisma, { rowId: input.documentId, propertyId });
    if (target === null) {
      throw new AppError(
        'database_files_target_invalid',
        'The property is not a FILES column of the database this page is a row of',
        { propertyId, documentId: input.documentId },
      );
    }
    return { ...target, rowId: input.documentId, propertyId };
  }

  /**
   * Appends a stored file to its cell, with the outbox row a value change
   * always carries (ADR-010), then tells open tables. A failure here leaves a
   * file no cell names, which the sweep collects after a day: the upload
   * itself is not undone, because its object is already stored.
   */
  async putIntoCell(input: {
    cell: CellTarget;
    attachmentId: string;
    workspaceId: string;
    correlationId: string;
  }): Promise<void> {
    const { cell } = input;
    await this.prisma.$transaction(async (tx) => {
      await appendPropertyFile(tx, {
        rowId: cell.rowId,
        propertyId: cell.propertyId,
        attachmentId: input.attachmentId,
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'database.row.updated',
        payload: { documentId: cell.collectionDocumentId, rowId: cell.rowId },
        correlationId: input.correlationId,
      });
    });
    await this.realtime.emit('database.row.updated', input.workspaceId, input.correlationId, {
      documentId: cell.collectionDocumentId,
      rowId: cell.rowId,
    });
  }
}
