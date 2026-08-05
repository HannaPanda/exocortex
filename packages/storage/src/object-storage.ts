import { type Readable } from 'node:stream';

export interface PutObjectInput {
  key: string;
  body: Uint8Array | Buffer;
  contentType: string;
  /** Attachment filename used for `Content-Disposition` on download. */
  filename?: string;
  metadata?: Record<string, string>;
}

export interface StoredObject {
  key: string;
  byteSize: number;
  etag: string | null;
  contentType: string;
}

export interface GetObjectInput {
  key: string;
}

export interface DeleteObjectInput {
  key: string;
}

export interface DownloadUrlInput {
  key: string;
  /** Seconds the URL stays valid. */
  expiresInSeconds?: number;
  filename?: string;
}

/**
 * Storage abstraction used by the application.
 *
 * The only implementation today is S3-compatible (`S3ObjectStorage`, MinIO
 * locally). A different backend only has to implement this interface; see
 * docs/architecture.md, "Adding a storage backend".
 */
export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getObject(input: GetObjectInput): Promise<Readable>;
  deleteObject(input: DeleteObjectInput): Promise<void>;
  /** Pre-signed, time-limited URL. Never a public bucket URL. */
  createDownloadUrl(input: DownloadUrlInput): Promise<string>;
  /** Readiness probe used by `GET /health/ready`. */
  healthCheck(): Promise<boolean>;
}

export class ObjectStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ObjectStorageError';
  }
}

/**
 * Builds the storage object key.
 *
 * Keys are always derived server-side from the workspace, the current date and a
 * random identifier. Clients can never choose a key, which prevents both path
 * traversal and cross-workspace overwrites.
 */
export function buildAttachmentKey(input: {
  workspaceId: string;
  attachmentId: string;
  extension: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeExtension = /^[a-z0-9]{1,10}$/.test(input.extension) ? input.extension : 'bin';
  return `workspaces/${input.workspaceId}/${year}/${month}/${input.attachmentId}.${safeExtension}`;
}
