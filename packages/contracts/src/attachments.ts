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

/** State machine for the cached text extraction of an attachment (D6). */
export const attachmentTextStatusSchema = z.enum([
  'not_applicable',
  'pending',
  'ready',
  'failed',
]);
export type AttachmentTextStatus = z.infer<typeof attachmentTextStatusSchema>;

/**
 * What an extraction engine could tell about the document.
 *
 * Every field but `extractor` is nullable because the engines see different
 * things: the hosted `pdf-text` plugin reports the PDF's own metadata
 * dictionary (title, author, dates) and nothing about layout, while Docling
 * reports layout (pages, tables, pictures, whether OCR ran) and nothing from
 * the metadata dictionary. When the chain tries both, the result is the union.
 * A null therefore means "no engine could tell", never "zero".
 */
export const pdfMetadataSchema = z.object({
  /** Engine whose text was kept, e.g. `openrouter` or `docling`. */
  extractor: z.string(),
  title: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
  creator: z.string().nullable().default(null),
  producer: z.string().nullable().default(null),
  createdAt: isoDateTimeSchema.nullable().default(null),
  modifiedAt: isoDateTimeSchema.nullable().default(null),
  pageCount: z.number().int().nonnegative().nullable().default(null),
  tableCount: z.number().int().nonnegative().nullable().default(null),
  pictureCount: z.number().int().nonnegative().nullable().default(null),
  /** The engine's own confidence in the conversion, 0 to 1. */
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** Whether OCR contributed text, i.e. the document had bitmap content. */
  ocrUsed: z.boolean().nullable().default(null),
});
export type PdfMetadata = z.infer<typeof pdfMetadataSchema>;

/**
 * Extracted text is capped here; a 400k character page is already enormous
 * context. Shared between the worker (which cuts the text) and the API (which
 * caps a human correction to the same length), so the two limits cannot drift.
 */
export const ATTACHMENT_TEXT_MAX_CHARS = 400_000;

/**
 * Records that a person edited the extracted text by hand (issue #2).
 *
 * Deliberately metadata only, no text: this rides along on the lightweight
 * `.../text/info` read too, so a block can show "von Hand korrigiert" without
 * pulling the correction itself.
 */
export const attachmentTextCorrectionSchema = z.object({
  editedAt: isoDateTimeSchema,
  editedById: idSchema,
});
export type AttachmentTextCorrection = z.infer<typeof attachmentTextCorrectionSchema>;

export const attachmentTextResponseSchema = z.object({
  attachmentId: idSchema,
  filename: z.string(),
  mimeType: z.string(),
  status: attachmentTextStatusSchema,
  /**
   * The version every reader sees: the human correction when there is one,
   * the machine result otherwise. `exo_attachment_read_text` returns exactly
   * this field, so a correction the AI cannot see would defeat its own point.
   */
  text: z.string().nullable(),
  /**
   * The machine result on its own, regardless of whether a correction exists.
   * Lets the correction dialog show what the engine actually produced next to
   * what a person changed it to.
   */
  machineText: z.string().nullable(),
  /** Present once a person has corrected the text; absent otherwise. */
  correction: attachmentTextCorrectionSchema.nullable(),
  /** True when `machineText` was cut off at `ATTACHMENT_TEXT_MAX_CHARS`. */
  truncated: z.boolean(),
  /** Null until an extraction succeeded, and for engines that report nothing. */
  metadata: pdfMetadataSchema.nullable(),
  extractedAt: isoDateTimeSchema.nullable(),
  error: z.string().nullable(),
});
export type AttachmentTextResponse = z.infer<typeof attachmentTextResponseSchema>;

/**
 * The same answer without the two fields that can be 400,000 characters long.
 *
 * A rendered PDF block wants the page count, the title and whether a
 * correction exists, which together are a few dozen bytes; `text` and
 * `machineText` next to them can each be 400,000 characters. Every PDF on a
 * page would pull all of that just to draw a one-line header, so the two
 * reads are separate. This one is also side-effect free: reading it never
 * starts an extraction, because a render must not enqueue work.
 */
export const attachmentTextInfoResponseSchema = attachmentTextResponseSchema.omit({
  text: true,
  machineText: true,
});
export type AttachmentTextInfoResponse = z.infer<typeof attachmentTextInfoResponseSchema>;

/**
 * Body of `PATCH /api/attachments/:id/text`.
 *
 * `text: null` clears an existing correction, reverting the effective text to
 * the machine result -- the explicit "discard my correction" the concept
 * asked for, rather than an empty string silently meaning the same thing.
 */
export const attachmentTextCorrectionInputSchema = z.object({
  text: z.string().max(ATTACHMENT_TEXT_MAX_CHARS).nullable(),
});
export type AttachmentTextCorrectionInput = z.infer<typeof attachmentTextCorrectionInputSchema>;
