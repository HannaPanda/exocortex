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

/**
 * How long an upload ticket stays redeemable (ADR-064). Ten minutes: long
 * enough for an agent to mint one, write a script and run it, short enough
 * that a secret left in a log is worthless by the time anybody reads it.
 */
export const UPLOAD_TICKET_TTL_SECONDS = 600;

/**
 * Body of `POST /api/workspaces/:workspaceId/attachments/upload-tickets`.
 * The same target fields as the URL upload: where the file lands and, if the
 * caller wants, what it is called.
 *
 * Unlike there, the page is required. A file belongs to the page it hangs
 * off: deleting that page for good deletes the file with it, and that is the
 * only thing that ever collects one. A file hanging off no page is reachable
 * from no screen and removed by nothing, so a ticket that left the page out
 * produced exactly that the first time an agent used it. The browser has
 * never uploaded without one either.
 */
export const createUploadTicketRequestSchema = z.object({
  documentId: idSchema,
  /** Overrides the name the upload carries. The extension is still the file's. */
  filename: z.string().min(1).max(255).nullable().default(null),
});
export type CreateUploadTicketRequest = z.infer<typeof createUploadTicketRequestSchema>;

/**
 * Where a ticket stands. `open` can still be redeemed; `used` produced a file
 * (`attachmentId`, `embedUrl`); `expired` was never used in time. A ticket
 * whose upload is running right now reads as `used` without a file yet.
 */
export const UPLOAD_TICKET_STATES = ['open', 'used', 'expired'] as const;
export const uploadTicketStateSchema = z.enum(UPLOAD_TICKET_STATES);
export type UploadTicketState = z.infer<typeof uploadTicketStateSchema>;

export const uploadTicketSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  documentId: idSchema.nullable(),
  filename: z.string().nullable(),
  state: uploadTicketStateSchema,
  expiresAt: z.string(),
  usedAt: z.string().nullable(),
  attachmentId: idSchema.nullable(),
  /** `attachmentDownloadPath` of the file, once there is one. */
  embedUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;

export const createUploadTicketResponseSchema = z.object({
  ticket: uploadTicketSchema,
  /**
   * The address to POST the file to, as `multipart/form-data` with one file
   * part. Carries the secret, is shown exactly once, and works for one upload.
   * The answer to that POST is an ordinary `UploadAttachmentResponse`.
   */
  uploadUrl: z.string(),
});
export type CreateUploadTicketResponse = z.infer<typeof createUploadTicketResponseSchema>;

export const uploadTicketResponseSchema = z.object({ ticket: uploadTicketSchema });
export type UploadTicketResponse = z.infer<typeof uploadTicketResponseSchema>;

/**
 * Raster formats `GET /api/attachments/:id/image` hands over as pixels
 * (issue #204).
 *
 * SVG is absent on purpose: it is a document that can carry script, not a
 * bitmap (issue #177), and rasterizing somebody's SVG on the server would put
 * an XML parser and a renderer in front of foreign input for a picture an
 * agent can just as well download through a ticket.
 */
export const ATTACHMENT_IMAGE_SOURCE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

/**
 * What the image read answers with. The three formats every multimodal model
 * this deployment talks to accepts; a GIF (first frame) and an AVIF are
 * re-encoded as PNG.
 */
export const ATTACHMENT_IMAGE_OUTPUT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export function isAttachmentImageSource(mimeType: string): boolean {
  return (ATTACHMENT_IMAGE_SOURCE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Longest edge the image read returns unless asked otherwise. 1568 pixels is
 * where the large vision models stop gaining detail and start scaling down on
 * their side, so anything above it is bandwidth and tokens for nothing.
 */
export const ATTACHMENT_IMAGE_DEFAULT_MAX_EDGE = 1_568;
/** The most a caller may ask for: the size of a stored preview (`image-preview.ts`). */
export const ATTACHMENT_IMAGE_MAX_EDGE = 2_048;
export const ATTACHMENT_IMAGE_MIN_EDGE = 64;

/**
 * The most bytes one image answer carries before Base64. Base64 adds a third,
 * which lands just under the five megabytes a model provider accepts per image,
 * and keeps a single tool answer from swallowing a context window.
 */
export const ATTACHMENT_IMAGE_MAX_BYTES = 3_750_000;

/** Query of `GET /api/attachments/:attachmentId/image`. */
export const attachmentImageQuerySchema = z.object({
  maxEdge: z.coerce
    .number()
    .int()
    .min(ATTACHMENT_IMAGE_MIN_EDGE)
    .max(ATTACHMENT_IMAGE_MAX_EDGE)
    .default(ATTACHMENT_IMAGE_DEFAULT_MAX_EDGE),
});
export type AttachmentImageQuery = z.infer<typeof attachmentImageQuerySchema>;

/**
 * An image attachment as pixels (issue #204).
 *
 * JSON with the bytes as Base64 rather than the stream the download route
 * sends, because every tool reaches the domain through a JSON API (ADR-014)
 * and an MCP image content element is Base64 anyway. The original stays where
 * it is: an image small enough is passed through byte for byte, so a
 * screenshot diff keeps every pixel, and one that is too large is scaled down
 * and says so in `resized`.
 */
export const attachmentImageResponseSchema = z.object({
  attachmentId: idSchema,
  documentId: idSchema.nullable(),
  filename: z.string(),
  /** The stored file. */
  sourceMimeType: z.string(),
  sourceByteSize: z.number().int().nonnegative(),
  originalWidth: z.number().int().positive(),
  originalHeight: z.number().int().positive(),
  /** What `data` holds. */
  mimeType: z.enum(ATTACHMENT_IMAGE_OUTPUT_MIME_TYPES),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** True when `data` is not the stored file: scaled down, or re-encoded. */
  resized: z.boolean(),
  data: z.string(),
});
export type AttachmentImageResponse = z.infer<typeof attachmentImageResponseSchema>;

/**
 * How long a download ticket stays redeemable (issue #204). The same ten
 * minutes as an upload ticket, for the same reason.
 */
export const DOWNLOAD_TICKET_TTL_SECONDS = 600;

export const downloadTicketSchema = z.object({
  id: idSchema,
  attachmentId: idSchema,
  filename: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type DownloadTicket = z.infer<typeof downloadTicketSchema>;

/** Answer of `POST /api/attachments/:attachmentId/download-tickets`. */
export const createDownloadTicketResponseSchema = z.object({
  ticket: downloadTicketSchema,
  /**
   * The address to GET the file from, once. Carries the secret and is shown
   * exactly once. Not an embed address: a page uses `attachmentDownloadPath`.
   */
  downloadUrl: z.string(),
});
export type CreateDownloadTicketResponse = z.infer<typeof createDownloadTicketResponseSchema>;

/**
 * Why an attachment's text could not be read, as a code each reader words in
 * its own language (issue #98): the engine is switched off, the file is over
 * the size limit, it has no text, or the office converter refused it for a
 * reason that names the file. `failed` is a job that ran out of retries.
 */
export const ATTACHMENT_TEXT_ERROR_CODES = [
  'pdfDisabled',
  'officeDisabled',
  'tooLarge',
  'noTextLayer',
  'empty',
  'unsupported',
  'malformed',
  'encrypted',
  'missingPart',
  'resourceLimit',
  'needsOcr',
  'failed',
] as const;
export type AttachmentTextErrorCode = (typeof ATTACHMENT_TEXT_ERROR_CODES)[number];

export function isAttachmentTextErrorCode(value: unknown): value is AttachmentTextErrorCode {
  return (ATTACHMENT_TEXT_ERROR_CODES as readonly unknown[]).includes(value);
}

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
  /** The English detail of a failure, for a log or a person debugging it. */
  error: z.string().nullable(),
  /** Why it failed, as a code to word; null for a row from before the codes. */
  errorCode: z.enum(ATTACHMENT_TEXT_ERROR_CODES).nullable(),
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
