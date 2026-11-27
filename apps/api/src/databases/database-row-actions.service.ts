import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canCreateDocument, canEditDocument, canReadDocument } from '@exocortex/auth';
import {
  type DatabaseRowIdsRequest,
  type DatabaseRowsResponse,
  type DocumentSummary,
  type TrashDatabaseRowsResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  copyDocumentForNewPage,
  proseMirrorJsonToYjsState,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { DOCUMENT_SELECT, toIconColor } from '../documents/document-shape';
import { DocumentsService } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';

import { DatabaseRowsService } from './database-rows.service';

/**
 * What the row handle and the selection bar of a table do besides writing
 * values (issue #244): putting rows in the trash and duplicating them, several
 * at once and in one request.
 *
 * Both are built from the ordinary page operations, because a row is an
 * ordinary page (ADR-011): the trash is `DocumentsService.archive`, so a row
 * comes back exactly the way any page does, and a copy is made the way a page
 * made from a template is (ADR-039) -- from the canonical Yjs state, with new
 * block ids, never through Markdown.
 */
@Injectable()
export class DatabaseRowActionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly rows: DatabaseRowsService,
    private readonly documents: DocumentsService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Puts the rows in the trash. Every row is checked before the first one
   * moves, so a refusal leaves the selection as it was; after that each row
   * is archived on its own, as a page is, and comes back on its own.
   */
  async trash(input: {
    collectionDocumentId: string;
    userId: string;
    request: DatabaseRowIdsRequest;
    correlationId: string;
  }): Promise<TrashDatabaseRowsResponse> {
    await this.rows.requireCollection(input.collectionDocumentId, input.userId);
    const rowIds = [...new Set(input.request.rowIds)];
    await this.rows.requireRowsOf({
      collectionDocumentId: input.collectionDocumentId,
      rowIds,
      userId: input.userId,
      check: (context) => assertPolicy(canEditDocument(context.role, context.document)),
    });

    const archived: DocumentSummary[] = [];
    for (const rowId of rowIds) {
      const result = await this.documents.archive({
        documentId: rowId,
        userId: input.userId,
        correlationId: input.correlationId,
      });
      const { archivedDescendants, ...row } = result;
      archived.push(row, ...archivedDescendants);
    }
    return { archived };
  }

  /**
   * A copy of each row directly below it: same title, icon, cover, text and
   * values, new block ids and no link back. Files the copy names stay the
   * source row's, which is what a page made from a template does too.
   */
  async duplicate(input: {
    collectionDocumentId: string;
    userId: string;
    request: DatabaseRowIdsRequest;
    correlationId: string;
  }): Promise<DatabaseRowsResponse> {
    const collection = await this.rows.requireCollection(input.collectionDocumentId, input.userId);
    assertPolicy(canCreateDocument(collection.role));
    const rowIds = [...new Set(input.request.rowIds)];
    await this.rows.requireRowsOf({
      collectionDocumentId: input.collectionDocumentId,
      rowIds,
      userId: input.userId,
      check: (context) =>
        assertPolicy(canReadDocument(context.role, context.document, context.workspaceId)),
    });

    const copies: string[] = [];
    for (const rowId of rowIds) {
      copies.push(
        await this.duplicateOne({
          collectionDocumentId: input.collectionDocumentId,
          workspaceId: collection.workspaceId,
          rowId,
          userId: input.userId,
          correlationId: input.correlationId,
        }),
      );
    }
    return {
      rows: await Promise.all(
        copies.map((id) => this.rows.toRowResponse(input.collectionDocumentId, id)),
      ),
    };
  }

  private async duplicateOne(input: {
    collectionDocumentId: string;
    workspaceId: string;
    rowId: string;
    userId: string;
    correlationId: string;
  }): Promise<string> {
    const [source, content, values] = await Promise.all([
      this.prisma.document.findUniqueOrThrow({
        where: { id: input.rowId },
        select: DOCUMENT_SELECT,
      }),
      this.prisma.documentContent.findUnique({
        where: { documentId: input.rowId },
        select: { yjsState: true },
      }),
      this.prisma.documentPropertyValue.findMany({ where: { documentId: input.rowId } }),
    ]);
    if (content === null) throw AppError.notFound('Document content');

    const copy = copyDocumentForNewPage(yjsStateToProseMirrorJson(content.yjsState));
    const iconColor = toIconColor(source.iconColor);
    const created = await this.documents.create({
      workspaceId: input.workspaceId,
      userId: input.userId,
      request: {
        type: 'PAGE',
        title: source.title,
        parentId: input.collectionDocumentId,
        afterSiblingId: input.rowId,
        ...(source.icon === null ? {} : { icon: source.icon }),
        ...(iconColor === null ? {} : { iconColor }),
      },
      correlationId: input.correlationId,
      initialYjsState: proseMirrorJsonToYjsState(copy.document),
    });

    // The cover is a second request for the reason the template copy gives:
    // `documents.update` is the one place that checks an attachment may be one.
    if (source.coverAttachmentId !== null) {
      await this.documents.update({
        documentId: created.id,
        userId: input.userId,
        request: {
          coverAttachmentId: source.coverAttachmentId,
          coverPosition: source.coverPosition,
        },
        correlationId: input.correlationId,
      });
    }

    if (values.length > 0) {
      // Same database, so every value names a column that exists here. The
      // event is the one `create` with values writes: a rule watching for
      // filled-in rows sees the copy arrive filled in.
      await this.prisma.$transaction(async (tx) => {
        await tx.documentPropertyValue.createMany({
          data: values.map((value) => ({
            documentId: created.id,
            propertyId: value.propertyId,
            textValue: value.textValue,
            numberValue: value.numberValue,
            boolValue: value.boolValue,
            dateValue: value.dateValue,
            dateEndValue: value.dateEndValue,
            dateAllDay: value.dateAllDay,
            jsonValue: value.jsonValue ?? undefined,
          })),
        });
        await this.outbox.writeEvent(tx, {
          workspaceId: input.workspaceId,
          type: 'database.row.updated',
          payload: { documentId: input.collectionDocumentId, rowId: created.id },
          correlationId: input.correlationId,
        });
      });
    }
    return created.id;
  }
}
