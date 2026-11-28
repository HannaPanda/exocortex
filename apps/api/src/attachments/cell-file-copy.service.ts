import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { type CopiedCellFile, QUEUE_NAMES } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';
import {
  buildAttachmentKey,
  buildAttachmentPreviewKey,
  type ObjectStorage,
} from '@exocortex/storage';

import { LOGGER } from '../common/logger.provider';
import { OBJECT_STORAGE, PRISMA, QUEUES } from '../platform/platform.module';

/** A stored value as `documentPropertyValue.findMany` returns it. */
export interface CopyableValue {
  propertyId: string;
  jsonValue: unknown;
}

export interface CellFileCopies {
  /**
   * The FILES values for the new row, by column: the copies' ids in the order
   * the source named its files. A column whose files are all gone maps to an
   * empty list, which the caller stores as no value.
   */
  values: Map<string, string[]>;
  copiedFiles: CopiedCellFile[];
}

/**
 * A stored value as the copy stores it: a FILES value names the copies, an
 * empty one (every file already gone) is no value, anything else is as it was.
 */
export function copiedValue<T>(
  copies: ReadonlyMap<string, string[]>,
  value: { propertyId: string; jsonValue: T | null },
): T | string[] | undefined {
  const files = copies.get(value.propertyId);
  if (files !== undefined) return files.length === 0 ? undefined : files;
  return value.jsonValue ?? undefined;
}

/** The extension at the end of a server-built key (`buildAttachmentKey`). */
function keyExtension(key: string): string {
  return /\.([a-z0-9]{1,10})$/.exec(key)?.[1] ?? 'bin';
}

/**
 * Copies the files of a row's FILES cells onto a new row (issue #316).
 *
 * A row made from a template (ADR-039) or duplicated (issue #244) used to name
 * the source row's files in its cells. A FILES value only ever names files
 * that hang on its own row (ADR-098), and that is what lets the sweep collect
 * a file once its cell drops it -- so a shared reference meant that taking a
 * file out of the template emptied every cell made from it. Each copy is now
 * an attachment of its own: a new row on the new page with the same
 * `propertyId`, and a new object the storage copies server-side, so the bytes
 * never pass through the API.
 *
 * What hangs on the file and still describes the same bytes comes along:
 * the extracted text with its page starts, the correction, the screening and
 * the preview. Re-reading every copied PDF would send it through the
 * extraction engine again for the text it already has.
 *
 * The uploader stays the source's uploader. Trust in a file's text (ADR-096)
 * is trust in the person whose words it is, and copying a row does not make
 * those words the copier's: the copy is trusted for exactly the reader the
 * original is trusted for, and for nobody else. Taking the copier as
 * uploader would let anybody turn a colleague's screened file into their own
 * by duplicating a row; asking the screening again would change nothing about
 * whose text it is.
 */
@Injectable()
export class CellFileCopyService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Copies every file the FILES values among `values` name onto `targetRowId`.
   * Values of other columns are not touched and not in the answer. A file the
   * source names that is already gone is left out of the copy, as its cell
   * already shows it as gone.
   *
   * A failed copy of an object removes that copy's row and rethrows; copies
   * made before it hang on the new row unnamed by any cell, and the daily
   * sweep collects them like any upload whose value write never happened.
   */
  async copy(input: {
    values: readonly CopyableValue[];
    targetRowId: string;
    workspaceId: string;
    userId: string;
    correlationId: string;
  }): Promise<CellFileCopies> {
    const result: CellFileCopies = { values: new Map(), copiedFiles: [] };
    const named = input.values
      .filter((value) => Array.isArray(value.jsonValue))
      .map((value) => ({
        propertyId: value.propertyId,
        ids: [
          ...new Set(
            (value.jsonValue as unknown[]).filter((id): id is string => typeof id === 'string'),
          ),
        ],
      }))
      .filter((value) => value.ids.length > 0);
    if (named.length === 0) return result;

    const filesColumns = new Set(
      (
        await this.prisma.databaseProperty.findMany({
          where: { id: { in: named.map((value) => value.propertyId) }, type: 'FILES' },
          select: { id: true },
        })
      ).map((property) => property.id),
    );
    const cells = named.filter((value) => filesColumns.has(value.propertyId));
    if (cells.length === 0) return result;

    const sources = new Map(
      (
        await this.prisma.attachment.findMany({
          where: {
            id: { in: cells.flatMap((cell) => cell.ids) },
            workspaceId: input.workspaceId,
            deletedAt: null,
            conversationId: null,
          },
        })
      ).map((row) => [row.id, row] as const),
    );

    let anyText = false;
    for (const cell of cells) {
      const copies: string[] = [];
      for (const id of cell.ids) {
        const source = sources.get(id);
        if (source === undefined) continue;
        const copy = await this.copyOne({
          source,
          propertyId: cell.propertyId,
          targetRowId: input.targetRowId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          correlationId: input.correlationId,
        });
        if (copy.hasText) anyText = true;
        copies.push(copy.id);
        result.copiedFiles.push({
          rowId: input.targetRowId,
          propertyId: cell.propertyId,
          sourceAttachmentId: source.id,
          attachmentId: copy.id,
        });
      }
      result.values.set(cell.propertyId, copies);
    }

    // An attachment's text is part of its page's search projection (ADR-050),
    // and the new row was indexed when it was created, before its files were.
    if (anyText) {
      await this.queues.enqueue(QUEUE_NAMES.searchIndexing, {
        correlationId: input.correlationId,
        documentId: input.targetRowId,
        workspaceId: input.workspaceId,
        reason: 'attachment_text',
      });
    }

    this.logger.info('Cell files copied onto a new row', {
      rowId: input.targetRowId,
      workspaceId: input.workspaceId,
      copied: result.copiedFiles.length,
      correlationId: input.correlationId,
    });
    return result;
  }

  private async copyOne(input: {
    source: Awaited<ReturnType<PrismaClient['attachment']['findMany']>>[number];
    propertyId: string;
    targetRowId: string;
    workspaceId: string;
    userId: string;
    correlationId: string;
  }): Promise<{ id: string; hasText: boolean }> {
    const { source } = input;
    // A file still being read gets its own reading: the job running for the
    // source writes only the source's row.
    const stillReading = source.textStatus === 'PENDING';
    const text = stillReading
      ? { textStatus: 'PENDING' as const }
      : {
          extractedText: source.extractedText,
          textStatus: source.textStatus,
          textExtractedAt: source.textExtractedAt,
          textExtractionError: source.textExtractionError,
          textErrorCode: source.textErrorCode,
          textMetadata: source.textMetadata ?? undefined,
          textTruncated: source.textTruncated,
          textPageStarts: source.textPageStarts,
          correctedText: source.correctedText,
          textCorrectedAt: source.textCorrectedAt,
          textCorrectedById: source.textCorrectedById,
          screening: source.screening,
          screenedAt: source.screenedAt,
          screenModel: source.screenModel,
          screenScore: source.screenScore,
        };

    const row = await this.prisma.attachment.create({
      data: {
        workspaceId: input.workspaceId,
        documentId: input.targetRowId,
        filename: source.filename,
        mimeType: source.mimeType,
        byteSize: source.byteSize,
        storageKey: `pending:${randomUUID()}`,
        checksum: source.checksum,
        createdById: source.createdById,
        fetchedFromUrl: source.fetchedFromUrl,
        propertyId: input.propertyId,
        imageDescription: source.imageDescription,
        imageDescribedAt: source.imageDescribedAt,
        imageDescriptionModel: source.imageDescriptionModel,
        ...text,
      },
      select: { id: true },
    });

    const storageKey = buildAttachmentKey({
      workspaceId: input.workspaceId,
      attachmentId: row.id,
      extension: keyExtension(source.storageKey),
    });
    const metadata = {
      workspaceId: input.workspaceId,
      uploadedBy: source.createdById,
      copiedBy: input.userId,
      copiedFrom: source.id,
    };
    try {
      await this.storage.copyObject({
        sourceKey: source.storageKey,
        key: storageKey,
        contentType: source.mimeType,
        filename: source.filename,
        metadata,
      });
    } catch (error) {
      // Never leave a row pointing at an object that does not exist.
      await this.prisma.attachment.delete({ where: { id: row.id } });
      throw error;
    }

    const preview = await this.copyPreview({ source, storageKey, metadata, attachmentId: row.id });
    await this.prisma.attachment.update({
      where: { id: row.id },
      data: { storageKey, ...preview },
    });

    if (stillReading) {
      await this.queues.enqueue(QUEUE_NAMES.attachmentText, {
        correlationId: input.correlationId,
        attachmentId: row.id,
        workspaceId: input.workspaceId,
        reason: 'upload',
      });
    }
    return { id: row.id, hasText: !stillReading && source.textStatus === 'READY' };
  }

  /**
   * The downscaled copy, best effort like the one an upload makes: without it
   * a reader is served the original, which is what an absent preview means.
   */
  private async copyPreview(input: {
    source: {
      previewKey: string | null;
      previewMimeType: string | null;
      previewByteSize: number | null;
      filename: string;
    };
    storageKey: string;
    metadata: Record<string, string>;
    attachmentId: string;
  }): Promise<{ previewKey?: string; previewMimeType?: string; previewByteSize?: number }> {
    const { previewKey, previewMimeType, previewByteSize } = input.source;
    if (previewKey === null || previewMimeType === null || previewByteSize === null) return {};
    const key = buildAttachmentPreviewKey({
      storageKey: input.storageKey,
      extension: keyExtension(previewKey),
    });
    try {
      await this.storage.copyObject({
        sourceKey: previewKey,
        key,
        contentType: previewMimeType,
        filename: input.source.filename,
        metadata: input.metadata,
      });
    } catch (error) {
      this.logger.error('Could not copy image preview, serving the original', error, {
        attachmentId: input.attachmentId,
      });
      return {};
    }
    return { previewKey: key, previewMimeType, previewByteSize };
  }
}
