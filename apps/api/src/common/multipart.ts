import { type FastifyRequest } from 'fastify';

import { AppError } from './app-error';

export interface UploadedFile {
  filename: string;
  /** What the browser claimed. The real type is sniffed from the magic bytes. */
  declaredMimeType: string | undefined;
  body: Buffer;
  /** Plain text fields sent alongside the binary part. */
  fields: Record<string, string>;
}

/**
 * Reads the single file part of a `multipart/form-data` request.
 *
 * `@fastify/multipart` enforces the size limit while streaming, so an oversized
 * file never reaches memory in full; it signals that by throwing out of
 * `toBuffer()`, which is why the limit is reported from the catch block.
 */
export async function readUploadedFile(
  request: FastifyRequest,
  maxUploadBytes: number,
): Promise<UploadedFile> {
  if (!request.isMultipart()) {
    throw new AppError('unsupported_media_type', 'Expected a multipart/form-data request');
  }

  const file = await request.file({ limits: { fileSize: maxUploadBytes } });
  if (file === undefined) {
    throw AppError.validation('No file part was provided');
  }

  let body: Buffer;
  try {
    body = await file.toBuffer();
  } catch (error) {
    throw new AppError(
      'payload_too_large',
      `The file exceeds the maximum upload size of ${maxUploadBytes} bytes`,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }

  const fields: Record<string, string> = {};
  for (const [name, field] of Object.entries(file.fields)) {
    if (field === undefined || Array.isArray(field) || field.type !== 'field') continue;
    fields[name] = String(field.value);
  }

  return { filename: file.filename, declaredMimeType: file.mimetype, body, fields };
}
