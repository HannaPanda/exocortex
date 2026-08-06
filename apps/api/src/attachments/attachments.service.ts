import { type Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canDeleteAttachment,
  canDownloadAttachment,
  canUploadFile,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  type Attachment,
  type AttachmentTextResponse,
  pdfMetadataSchema,
  QUEUE_NAMES,
  type UploadAttachmentResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';
import {
  buildAttachmentKey,
  detectMimeType,
  type ObjectStorage,
  sanitizeFilename,
} from '@exocortex/storage';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { OBJECT_STORAGE, PRISMA, QUEUES } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

export interface UploadInput {
  workspaceId: string;
  userId: string;
  documentId: string | null;
  filename: string;
  declaredMimeType: string | undefined;
  body: Buffer;
  correlationId: string;
}

/**
 * Attachment upload, download and deletion.
 *
 * Security properties:
 *  * the MIME type is detected from the file's magic bytes, never trusted from
 *    the browser
 *  * the storage object key is derived server-side from the workspace, so a
 *    client can neither traverse paths nor overwrite another workspace's object
 *  * downloads are pre-signed and short-lived; the bucket itself stays private
 */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
  ) {}

  async upload(input: UploadInput): Promise<UploadAttachmentResponse> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canUploadFile(role));

    if (input.body.byteLength === 0) {
      throw AppError.validation('The uploaded file is empty');
    }
    if (input.body.byteLength > this.env.MAX_UPLOAD_BYTES) {
      throw new AppError(
        'payload_too_large',
        `The file exceeds the maximum upload size of ${this.env.MAX_UPLOAD_BYTES} bytes`,
      );
    }

    const detected = detectMimeType(input.body, input.declaredMimeType);
    if (
      detected === null ||
      !(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(detected.mimeType)
    ) {
      throw new AppError(
        'unsupported_media_type',
        'The file type could not be verified or is not allowed',
        { declaredMimeType: input.declaredMimeType ?? null },
      );
    }

    if (input.documentId !== null) {
      const document = await this.prisma.document.findUnique({
        where: { id: input.documentId },
        select: { workspaceId: true, archivedAt: true },
      });
      if (document === null) throw AppError.notFound('Document');
      if (document.workspaceId !== input.workspaceId) {
        throw new AppError(
          'document_cross_workspace',
          'The document belongs to a different workspace',
        );
      }
      if (document.archivedAt !== null) {
        throw new AppError('document_archived', 'Cannot attach files to an archived document');
      }
    }

    const filename = sanitizeFilename(input.filename, detected.extension);

    const pdfExtractionEnabled =
      detected.mimeType === 'application/pdf' && (await this.settings.getKey('ai.pdfExtractionEnabled'));

    // The row is created first so the object key can embed its identifier.
    const attachment = await this.prisma.attachment.create({
      data: {
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        filename,
        mimeType: detected.mimeType,
        byteSize: input.body.byteLength,
        storageKey: 'pending',
        createdById: input.userId,
        ...(pdfExtractionEnabled ? { textStatus: 'PENDING' } : {}),
      },
    });

    const storageKey = buildAttachmentKey({
      workspaceId: input.workspaceId,
      attachmentId: attachment.id,
      extension: detected.extension,
    });

    try {
      await this.storage.putObject({
        key: storageKey,
        body: input.body,
        contentType: detected.mimeType,
        filename,
        metadata: { workspaceId: input.workspaceId, uploadedBy: input.userId },
      });
    } catch (error) {
      // Never leave a row pointing at an object that does not exist.
      await this.prisma.attachment.delete({ where: { id: attachment.id } });
      this.logger.error('Upload failed, attachment row rolled back', error, {
        attachmentId: attachment.id,
        correlationId: input.correlationId,
      });
      throw error;
    }

    const stored = await this.prisma.attachment.update({
      where: { id: attachment.id },
      data: { storageKey },
    });

    // Only now, after the row points at a real object. Enqueuing right after
    // the create raced the upload: the worker reliably won and failed on the
    // placeholder key `pending`, burning a retry and logging an error on every
    // single PDF upload before the retry succeeded.
    if (pdfExtractionEnabled) {
      await this.queues.enqueue(QUEUE_NAMES.attachmentText, {
        correlationId: input.correlationId,
        attachmentId: attachment.id,
        workspaceId: input.workspaceId,
        reason: 'upload',
      });
    }

    this.logger.info('Attachment stored', {
      attachmentId: stored.id,
      workspaceId: input.workspaceId,
      byteSize: stored.byteSize,
      mimeType: stored.mimeType,
      correlationId: input.correlationId,
    });

    return {
      attachment: this.toContract(stored),
      downloadUrl: await this.storage.createDownloadUrl({
        key: storageKey,
        filename,
        expiresInSeconds: 300,
      }),
    };
  }

  /** Returns a stream plus metadata after checking workspace permission. */
  async download(
    attachmentId: string,
    userId: string,
  ): Promise<{ stream: Readable; filename: string; mimeType: string; byteSize: number }> {
    const context = await this.access.findAttachmentContext(attachmentId, userId);
    if (context === null) {
      throw new AppError(
        'attachment_access_denied',
        'Attachment does not exist or is not visible to this user',
      );
    }
    assertPolicy(
      canDownloadAttachment(context.role, context.attachment, context.attachment.workspaceId),
    );

    return {
      stream: await this.storage.getObject({ key: context.attachment.storageKey }),
      filename: context.attachment.filename,
      mimeType: context.attachment.mimeType,
      byteSize: context.attachment.byteSize,
    };
  }

  /** Soft-deletes the row, removes the object and writes an audit entry. */
  async delete(input: {
    attachmentId: string;
    userId: string;
    correlationId: string;
  }): Promise<void> {
    const context = await this.access.findAttachmentContext(input.attachmentId, input.userId);
    if (context === null) {
      throw new AppError(
        'attachment_access_denied',
        'Attachment does not exist or is not visible to this user',
      );
    }
    assertPolicy(canDeleteAttachment(context.role, context.attachment, input.userId));

    await this.prisma.$transaction(async (tx) => {
      await tx.attachment.update({
        where: { id: input.attachmentId },
        data: { deletedAt: new Date() },
      });
      await this.outbox.writeAudit(tx, {
        workspaceId: context.attachment.workspaceId,
        actorId: input.userId,
        action: 'attachment.deleted',
        targetType: 'attachment',
        targetId: input.attachmentId,
        correlationId: input.correlationId,
        metadata: { filename: context.attachment.filename },
      });
    });

    try {
      await this.storage.deleteObject({ key: context.attachment.storageKey });
    } catch (error) {
      // The row is already marked deleted; log and let maintenance retry.
      this.logger.error('Failed to delete stored object', error, {
        attachmentId: input.attachmentId,
        correlationId: input.correlationId,
      });
    }
  }

  /**
   * Returns cached extracted text, or enqueues extraction and returns
   * `pending` (D6). The MCP request path never extracts synchronously: a
   * stdio server has no Redis access and must answer fast.
   */
  async getText(
    attachmentId: string,
    userId: string,
    correlationId: string,
  ): Promise<AttachmentTextResponse> {
    const context = await this.access.findAttachmentContext(attachmentId, userId);
    if (context === null) {
      throw new AppError(
        'attachment_access_denied',
        'Attachment does not exist or is not visible to this user',
      );
    }
    assertPolicy(
      canDownloadAttachment(context.role, context.attachment, context.attachment.workspaceId),
    );

    const { attachment } = context;
    // A row written before `pdfMetadataSchema` existed, or by a future engine
    // reporting an extra field, must not turn a read into a 500: an unparsable
    // blob is reported as "no metadata".
    const parsedMetadata = pdfMetadataSchema.safeParse(attachment.textMetadata);
    const base = {
      attachmentId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      metadata: parsedMetadata.success ? parsedMetadata.data : null,
    };

    if (attachment.mimeType !== 'application/pdf' && attachment.textStatus === 'NOT_APPLICABLE') {
      return { ...base, status: 'not_applicable', text: null, extractedAt: null, error: null };
    }

    if (attachment.textStatus === 'READY') {
      return {
        ...base,
        status: 'ready',
        text: attachment.extractedText,
        extractedAt: attachment.textExtractedAt?.toISOString() ?? null,
        error: null,
      };
    }

    if (attachment.textStatus === 'PENDING') {
      return { ...base, status: 'pending', text: null, extractedAt: null, error: null };
    }

    // NOT_APPLICABLE but a PDF (extraction was never requested), or FAILED: (re-)enqueue.
    await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: { textStatus: 'PENDING', textExtractionError: null },
    });
    await this.queues.enqueue(QUEUE_NAMES.attachmentText, {
      correlationId,
      attachmentId,
      workspaceId: attachment.workspaceId,
      reason: 'requested',
    });

    return { ...base, status: 'pending', text: null, extractedAt: null, error: null };
  }

  private toContract(row: {
    id: string;
    workspaceId: string;
    documentId: string | null;
    filename: string;
    mimeType: string;
    byteSize: number;
    createdById: string;
    createdAt: Date;
  }): Attachment {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      filename: row.filename,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
