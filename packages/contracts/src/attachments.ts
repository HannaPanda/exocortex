import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * MIME types accepted for uploads. The value is verified by inspecting the file
 * magic bytes on the server; the browser-provided type is only a hint.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/zip',
  // Media for the video and audio blocks of the editor.
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
] as const;

export const attachmentMimeTypeSchema = z.enum(ALLOWED_ATTACHMENT_MIME_TYPES);
export type AttachmentMimeType = z.infer<typeof attachmentMimeTypeSchema>;

export const attachmentSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  documentId: idSchema.nullable(),
  filename: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  createdById: idSchema,
  createdAt: isoDateTimeSchema,
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const uploadAttachmentResponseSchema = z.object({
  attachment: attachmentSchema,
  downloadUrl: z.string(),
});
export type UploadAttachmentResponse = z.infer<typeof uploadAttachmentResponseSchema>;

/**
 * Multipart form fields accepted alongside the binary part. Storage object keys
 * are always derived server-side; clients cannot choose them.
 */
export const uploadAttachmentFieldsSchema = z.object({
  documentId: idSchema.optional(),
});
export type UploadAttachmentFields = z.infer<typeof uploadAttachmentFieldsSchema>;
