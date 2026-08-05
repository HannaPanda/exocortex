import { type Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { type Logger } from '@exocortex/logger';

import {
  type DeleteObjectInput,
  type DownloadUrlInput,
  type GetObjectInput,
  type ObjectStorage,
  ObjectStorageError,
  type PutObjectInput,
  type StoredObject,
} from './object-storage';

export interface S3ObjectStorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO requires path-style addressing. */
  forcePathStyle: boolean;
  logger: Logger;
  defaultDownloadExpirySeconds?: number;
}

function contentDisposition(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  // RFC 5987 encoding so non-ASCII filenames survive.
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** S3-compatible implementation. Used with MinIO locally and any S3 provider in production. */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly logger: Logger;
  private readonly defaultExpiry: number;

  constructor(options: S3ObjectStorageOptions) {
    this.bucket = options.bucket;
    this.logger = options.logger.child({ component: 's3-object-storage' });
    this.defaultExpiry = options.defaultDownloadExpirySeconds ?? 300;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ContentDisposition: contentDisposition(input.filename),
          Metadata: input.metadata,
        }),
      );
      this.logger.debug('Object stored', { key: input.key, byteSize: input.body.byteLength });
      return {
        key: input.key,
        byteSize: input.body.byteLength,
        etag: result.ETag ?? null,
        contentType: input.contentType,
      };
    } catch (error) {
      this.logger.error('Failed to store object', error, { key: input.key });
      throw new ObjectStorageError(`Failed to store object "${input.key}"`, { cause: error });
    }
  }

  async getObject(input: GetObjectInput): Promise<Readable> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: input.key }),
      );
      const body = result.Body;
      if (body === undefined) {
        throw new ObjectStorageError(`Object "${input.key}" has no body`);
      }
      // In Node the SDK returns a Readable; the union also covers browser types.
      return body as Readable;
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;
      this.logger.error('Failed to read object', error, { key: input.key });
      throw new ObjectStorageError(`Failed to read object "${input.key}"`, { cause: error });
    }
  }

  async deleteObject(input: DeleteObjectInput): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: input.key }));
      this.logger.debug('Object deleted', { key: input.key });
    } catch (error) {
      this.logger.error('Failed to delete object', error, { key: input.key });
      throw new ObjectStorageError(`Failed to delete object "${input.key}"`, { cause: error });
    }
  }

  async createDownloadUrl(input: DownloadUrlInput): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          ResponseContentDisposition: contentDisposition(input.filename),
        }),
        { expiresIn: input.expiresInSeconds ?? this.defaultExpiry },
      );
    } catch (error) {
      this.logger.error('Failed to sign download URL', error, { key: input.key });
      throw new ObjectStorageError(`Failed to sign download URL for "${input.key}"`, {
        cause: error,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (error) {
      this.logger.warn('Object storage health check failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}
