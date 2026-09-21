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
  'text/csv',
  'application/json',
  'application/zip',
  // Office and e-book documents, readable since 2026-09-20 (issue #38). Every
  // one of these is a container `detectMimeType` has to look inside: the OOXML
  // and OpenDocument families are ZIP archives and the legacy trio is an OLE
  // compound file, so all of them would otherwise be accepted as the generic
  // `application/zip` above and never be offered an extraction.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'application/epub+zip',
  // Media for the video and audio blocks of the editor.
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
] as const;

/**
 * Document formats the local converter reads, i.e. everything but PDF.
 *
 * PDF is deliberately absent: it has its own chain of engines behind its own
 * settings, because only that chain can read a scan. The split is what this
 * list is for -- see `attachmentTextEngine`.
 */
export const OFFICE_ATTACHMENT_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'application/epub+zip',
  'text/csv',
] as const;

/**
 * Which engine, if any, can read the text of a file with this MIME type.
 *
 * One predicate rather than a `=== 'application/pdf'` in each of the four
 * places that used to ask: the upload that decides whether to enqueue an
 * extraction, the read that decides whether to start one, the forced
 * re-extraction and the human correction. They disagreeing is what would make
 * a docx show an empty text bar it can never fill.
 */
export function attachmentTextEngine(mimeType: string): 'pdf' | 'office' | null {
  if (mimeType === 'application/pdf') return 'pdf';
  return (OFFICE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType) ? 'office' : null;
}

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

/**
 * The address a file is embedded from, and the only one that works on a page.
 *
 * Same-origin, so the Content Security Policy in `apps/web/next.config.ts`
 * (`img-src 'self' blob: data:`) lets the browser load it, and stable, so it is
 * still the right address next year. The browser has always built this string
 * for itself; naming it here is what lets an agent embed a picture without
 * inventing the route (issue #117).
 */
export function attachmentDownloadPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/download`;
}

export const uploadAttachmentResponseSchema = z.object({
  attachment: attachmentSchema,
  /**
   * A presigned object-storage URL, for a client that wants the bytes right
   * now without going through the API again. It points at a foreign origin and
   * expires in five minutes, so it must never be written into a page: that
   * combination is CSP-blocked immediately and dead shortly after (issue #117).
   */
  downloadUrl: z.string(),
  /** `attachmentDownloadPath`: the address that belongs in a page's Markdown. */
  embedUrl: z.string(),
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

/**
 * Body of `POST /api/workspaces/:workspaceId/attachments/from-url` (issue #117).
 *
 * The missing step between "an agent holds the address of a picture" and "the
 * picture is on a page". Without it the only route into the workspace is
 * Base64 through the tool call, which an agent that never had the bytes cannot
 * produce -- so it links the foreign host instead, and the reader sees a broken
 * image.
 *
 * The address goes through the same check as every other fetch this deployment
 * performs on somebody else's behalf (`checkPublicAddress`, ADR-033), before
 * the request is made and again after each redirect.
 */
export const uploadAttachmentFromUrlRequestSchema = z.object({
  url: z.string().url().max(2048),
  documentId: idSchema.nullable().default(null),
  /** Overrides the name derived from the address. The extension is still the file's. */
  filename: z.string().min(1).max(255).nullable().default(null),
});
export type UploadAttachmentFromUrlRequest = z.infer<typeof uploadAttachmentFromUrlRequestSchema>;

/** State machine for the cached text extraction of an attachment (D6). */
export const attachmentTextStatusSchema = z.enum(['not_applicable', 'pending', 'ready', 'failed']);
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
 *
 * Several fields describe a paginated document and stay null for the office
 * formats the local converter reads: a docx has no page count until something
 * lays it out, and nothing in the OOXML file says how many pages Word would
 * have drawn. That is the same "could not tell" the PDF engines already
 * express, which is why this is one schema and not two.
 */
export const documentTextMetadataSchema = z.object({
  /** Engine whose text was kept, e.g. `openrouter`, `docling` or `anydoc`. */
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
export type DocumentTextMetadata = z.infer<typeof documentTextMetadataSchema>;

/**
 * Extracted text is capped here; a 400k character page is already enormous
 * context. Shared between the worker (which cuts the text) and the API (which
 * caps a human correction to the same length), so the two limits cannot drift.
 */
export const ATTACHMENT_TEXT_MAX_CHARS = 400_000;

/**
 * How much of a page's attachments may reach its search projection (issue #101).
 *
 * The full text stays on the attachment row, which is what the reading routes
 * and the AI serve. What goes into `document_search_index.plainText` is a
 * copy, and a page carrying five 400,000-character PDFs would otherwise put two
 * million characters into one `tsvector` -- past PostgreSQL's one-megabyte
 * limit, at which point indexing the page fails outright rather than indexing
 * less of it. The budget is per page and shared by its attachments, so the
 * failure mode is a long attachment being cut, never a page dropping out of
 * the index.
 */
export const ATTACHMENT_SEARCH_TEXT_MAX_CHARS = 200_000;

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
  metadata: documentTextMetadataSchema.nullable(),
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
