import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canEditDocument, WorkspaceAccessService } from '@exocortex/auth';
import { type DocumentSummary } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AttachmentsService } from '../attachments/attachments.service';
import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';

import { DocumentsService } from './documents.service';

/**
 * Uploading a cover image in one call.
 *
 * The image itself is an ordinary attachment — the same upload, the same
 * magic-byte check, the same access control — so this service only does the
 * three things that make it a cover: reject anything that is not an image,
 * mark the file as cover-only so maintenance may collect it once it stops
 * being one, and point the page at it.
 *
 * Setting an *existing* attachment as the cover needs none of this and goes
 * through `PATCH /api/documents/:id` like every other page property.
 */
@Injectable()
export class DocumentCoverService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly attachments: AttachmentsService,
    private readonly documents: DocumentsService,
  ) {}

  async uploadAndSet(input: {
    documentId: string;
    userId: string;
    filename: string;
    declaredMimeType: string | undefined;
    body: Buffer;
    correlationId: string;
  }): Promise<DocumentSummary> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));

    const uploaded = await this.attachments.upload({
      workspaceId: context.workspaceId,
      userId: input.userId,
      documentId: input.documentId,
      filename: input.filename,
      declaredMimeType: input.declaredMimeType,
      body: input.body,
      correlationId: input.correlationId,
    });

    // The upload accepts every allowed type; a cover is narrower than that. The
    // file is already stored at this point, so a wrong one is removed again
    // rather than left behind as an attachment nobody asked for.
    if (!uploaded.attachment.mimeType.startsWith('image/')) {
      await this.attachments.delete({
        attachmentId: uploaded.attachment.id,
        userId: input.userId,
        correlationId: input.correlationId,
      });
      throw AppError.validation('A cover image must be an image file');
    }

    await this.prisma.attachment.update({
      where: { id: uploaded.attachment.id },
      data: { isCover: true },
    });

    // A new image makes the old crop meaningless, so the position starts over
    // in the middle.
    return this.documents.update({
      documentId: input.documentId,
      userId: input.userId,
      request: { coverAttachmentId: uploaded.attachment.id, coverPosition: 50 },
      correlationId: input.correlationId,
    });
  }
}
