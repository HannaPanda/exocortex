import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { type Prisma, type PrismaClient } from '@exocortex/database';
import {
  type CopyObjectInput,
  type ObjectStorage,
  type PutObjectInput,
  type StoredObject,
} from '@exocortex/storage';

/**
 * The bucket as a map, for tests that need to see which objects exist: a
 * copied row's files (issue #316) are only copies when their objects are.
 */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly copies: CopyObjectInput[] = [];

  putObject(input: PutObjectInput): Promise<StoredObject> {
    const body = Buffer.from(input.body);
    this.objects.set(input.key, body);
    return Promise.resolve({
      key: input.key,
      byteSize: body.byteLength,
      etag: null,
      contentType: input.contentType,
    });
  }

  getObject(input: { key: string }): Promise<Readable> {
    const body = this.objects.get(input.key);
    if (body === undefined) return Promise.reject(new Error(`no object ${input.key}`));
    return Promise.resolve(Readable.from(body));
  }

  deleteObject(input: { key: string }): Promise<void> {
    this.objects.delete(input.key);
    return Promise.resolve();
  }

  copyObject(input: CopyObjectInput): Promise<void> {
    const body = this.objects.get(input.sourceKey);
    if (body === undefined) return Promise.reject(new Error(`no object ${input.sourceKey}`));
    this.objects.set(input.key, body);
    this.copies.push(input);
    return Promise.resolve();
  }

  createDownloadUrl(input: { key: string }): Promise<string> {
    return Promise.resolve(`memory://${input.key}`);
  }

  healthCheck(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/**
 * A file in a FILES cell as an upload leaves it, written straight to the
 * table and the bucket: the row, the mark, the object and, when given, the
 * text and the preview. The tests that use it are about what happens to such
 * a file afterwards, not about the upload.
 */
export async function seedCellFile(
  prisma: PrismaClient,
  storage: MemoryStorage,
  input: {
    workspaceId: string;
    rowId: string;
    propertyId: string;
    createdById: string;
    filename: string;
    mimeType: string;
    body: Buffer;
    extension: string;
    preview?: Buffer;
    text?: Partial<Prisma.AttachmentUncheckedCreateInput>;
  },
): Promise<{ id: string; storageKey: string; previewKey: string | null }> {
  const created = await prisma.attachment.create({
    data: {
      workspaceId: input.workspaceId,
      documentId: input.rowId,
      propertyId: input.propertyId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.body.byteLength,
      storageKey: `pending:${randomUUID()}`,
      createdById: input.createdById,
      ...input.text,
    },
  });
  const storageKey = `workspaces/${input.workspaceId}/2026/11/${created.id}.${input.extension}`;
  const previewKey =
    input.preview === undefined ? null : storageKey.replace(/\.[^.]+$/, '.preview.webp');
  storage.objects.set(storageKey, input.body);
  if (input.preview !== undefined && previewKey !== null) {
    storage.objects.set(previewKey, input.preview);
  }
  await prisma.attachment.update({
    where: { id: created.id },
    data: {
      storageKey,
      ...(previewKey === null || input.preview === undefined
        ? {}
        : {
            previewKey,
            previewMimeType: 'image/webp',
            previewByteSize: input.preview.byteLength,
          }),
    },
  });
  return { id: created.id, storageKey, previewKey };
}
