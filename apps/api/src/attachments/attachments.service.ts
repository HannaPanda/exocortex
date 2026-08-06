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
  type AttachmentTextInfoResponse,
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
  buildAttachmentPreviewKey,
  createImagePreview,
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

    const preview = await this.storePreview({
      attachmentId: attachment.id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      storageKey,
      filename,
      mimeType: detected.mimeType,
      body: input.body,
      correlationId: input.correlationId,
    });

    const stored = await this.prisma.attachment.update({
      where: { id: attachment.id },
      data: { storageKey, ...preview },
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

  /**
   * Downscales an image and stores the copy next to the original.
   *
   * Deliberately inside the request rather than in a job: the preview exists to
   * make the *first* render cheap, and a page whose cover was just set is
   * rendered immediately. A job would serve the full-size original exactly
   * once, which is the one time it matters. The work itself is a libvips call
   * that runs on libuv's thread pool, so it never blocks the event loop, and it
   * is bounded by `MAX_UPLOAD_BYTES`.
   *
   * Best effort throughout: a failed preview leaves the upload intact and
   * returns empty columns, which every reader already interprets as "serve the
   * original".
   */
  private async storePreview(input: {
    attachmentId: string;
    workspaceId: string;
    userId: string;
    storageKey: string;
    filename: string;
    mimeType: string;
    body: Buffer;
    correlationId: string;
  }): Promise<{ previewKey?: string; previewMimeType?: string; previewByteSize?: number }> {
    const preview = await createImagePreview(input.body, input.mimeType, {
      onError: (error) => {
        this.logger.warn('Could not downscale image, serving the original', {
          attachmentId: input.attachmentId,
          mimeType: input.mimeType,
          correlationId: input.correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    if (preview === null) return {};

    const previewKey = buildAttachmentPreviewKey({
      storageKey: input.storageKey,
      extension: preview.extension,
    });

    try {
      await this.storage.putObject({
        key: previewKey,
        body: preview.body,
        contentType: preview.mimeType,
        filename: input.filename,
        metadata: { workspaceId: input.workspaceId, uploadedBy: input.userId },
      });
    } catch (error) {
      this.logger.error('Could not store image preview, serving the original', error, {
        attachmentId: input.attachmentId,
        correlationId: input.correlationId,
      });
      return {};
    }

    return {
      previewKey,
      previewMimeType: preview.mimeType,
      previewByteSize: preview.body.byteLength,
    };
  }

  /**
   * Returns a stream plus metadata after checking workspace permission.
   *
   * `variant: 'preview'` asks for the downscaled copy and silently falls back
   * to the original when there is none, so a caller that only ever wants to
   * *show* the image can request it unconditionally.
   */
  async download(
    attachmentId: string,
    userId: string,
    variant: 'original' | 'preview' = 'original',
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

    const { attachment } = context;
    const { previewKey, previewMimeType, previewByteSize } = attachment;
    if (
      variant === 'preview' &&
      previewKey !== null &&
      previewMimeType !== null &&
      previewByteSize !== null
    ) {
      return {
        stream: await this.storage.getObject({ key: previewKey }),
        filename: attachment.filename,
        mimeType: previewMimeType,
        byteSize: previewByteSize,
      };
    }

    return {
      stream: await this.storage.getObject({ key: attachment.storageKey }),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
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

    // Both objects, or the downscaled copy outlives the file it was made from.
    const keys = [context.attachment.storageKey, context.attachment.previewKey].filter(
      (key): key is string => key !== null,
    );
    for (const key of keys) {
      try {
        await this.storage.deleteObject({ key });
      } catch (error) {
        // The row is already marked deleted; log and let maintenance retry.
        this.logger.error('Failed to delete stored object', error, {
          attachmentId: input.attachmentId,
          storageKey: key,
          correlationId: input.correlationId,
        });
      }
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
    const { attachment, projected } = await this.readTextState(attachmentId, userId);

    // Ready or already running: nothing to start.
    if (projected.status === 'ready' || projected.status === 'pending') return projected;
    // Only a PDF has a text layer worth chasing; anything else is settled.
    if (attachment.mimeType !== 'application/pdf') return projected;

    // A PDF that was never asked for, or one whose last attempt failed. Reading
    // it is the request to try (again).
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

    return { ...projected, status: 'pending', text: null, extractedAt: null, error: null };
  }

  /**
   * Status and metadata without the text, and without starting anything.
   *
   * This is what a rendered PDF block reads. Both halves matter: pulling up to
   * 400,000 characters to draw a one-line header would be wasteful, and an
   * enqueue on render would mean a page full of failed PDFs re-runs extraction
   * every time someone opens it. Starting an extraction stays an explicit act,
   * which is `getText`.
   */
  async getTextInfo(attachmentId: string, userId: string): Promise<AttachmentTextInfoResponse> {
    const { projected } = await this.readTextState(attachmentId, userId);
    const { text: _text, ...info } = projected;
    return info;
  }

  /**
   * Authorizes the read and projects the stored row, truthfully and without
   * side effects. `getText` layers the "reading it starts it" behaviour on top;
   * this reports `failed` as failed.
   */
  private async readTextState(
    attachmentId: string,
    userId: string,
  ): Promise<{
    attachment: { workspaceId: string; mimeType: string };
    projected: AttachmentTextResponse;
  }> {
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
      text: null,
      extractedAt: null,
      error: null,
    };

    if (attachment.textStatus === 'READY') {
      return {
        attachment,
        projected: {
          ...base,
          status: 'ready',
          text: attachment.extractedText,
          extractedAt: attachment.textExtractedAt?.toISOString() ?? null,
        },
      };
    }

    if (attachment.textStatus === 'PENDING') {
      return { attachment, projected: { ...base, status: 'pending' } };
    }

    if (attachment.textStatus === 'FAILED') {
      return {
        attachment,
        projected: { ...base, status: 'failed', error: attachment.textExtractionError },
      };
    }

    return { attachment, projected: { ...base, status: 'not_applicable' } };
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
