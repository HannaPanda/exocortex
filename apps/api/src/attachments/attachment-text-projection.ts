import {
  attachmentPageUnits,
  type AttachmentTextReadQuery,
  type AttachmentTextReadResponse,
  type AttachmentTextResponse,
  attachmentTrustFor,
  documentTextMetadataSchema,
  isAttachmentTextErrorCode,
  readAttachmentText,
  screeningFromColumn,
} from '@exocortex/contracts';

import { AppError } from '../common/app-error';

/** The columns a text read projects; what `findAttachmentContext` selects. */
export interface AttachmentTextRow {
  createdById: string;
  filename: string;
  mimeType: string;
  textStatus: 'NOT_APPLICABLE' | 'PENDING' | 'READY' | 'FAILED';
  extractedText: string | null;
  textExtractedAt: Date | null;
  textExtractionError: string | null;
  textErrorCode: string | null;
  textMetadata: unknown;
  textTruncated: boolean;
  /** Where each page begins in `extractedText` (ADR-101); empty when unknown. */
  textPageStarts: number[];
  correctedText: string | null;
  textCorrectedAt: Date | null;
  textCorrectedById: string | null;
  screening: 'CLEAN' | 'FLAGGED' | 'FAILED' | null;
  fetchedFromUrl: boolean;
}

/**
 * The stored row as the text read answers it, for one reader, truthfully and
 * without side effects: `failed` is reported as failed. Who reads matters,
 * because the trust answer is the reader's (ADR-096).
 */
export function projectAttachmentText(
  attachmentId: string,
  attachment: AttachmentTextRow,
  userId: string,
): AttachmentTextResponse {
  // Who reads decides whether the text is the reader's own (ADR-096): the
  // same file is trusted for its uploader and foreign for everybody else.
  const trust = attachmentTrustFor({
    createdById: attachment.createdById,
    readerId: userId,
    correctedById: attachment.correctedText === null ? null : attachment.textCorrectedById,
    fetchedFromUrl: attachment.fetchedFromUrl,
    screening: screeningFromColumn(attachment.screening),
  });
  // A row written before `documentTextMetadataSchema` existed, or by a future engine
  // reporting an extra field, must not turn a read into a 500: an unparsable
  // blob is reported as "no metadata".
  const parsedMetadata = documentTextMetadataSchema.safeParse(attachment.textMetadata);
  const correction =
    attachment.correctedText === null || attachment.textCorrectedById === null
      ? null
      : {
          editedAt: attachment.textCorrectedAt?.toISOString() ?? new Date(0).toISOString(),
          editedById: attachment.textCorrectedById,
        };
  // The correction wins whenever there is one: it is what `exo_attachment_
  // read_text` and the correction dialog both read as "the text".
  const effectiveText = attachment.correctedText ?? attachment.extractedText;
  const base = {
    attachmentId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    metadata: parsedMetadata.success ? parsedMetadata.data : null,
    text: effectiveText,
    machineText: attachment.extractedText,
    correction,
    truncated: attachment.textTruncated,
    extractedAt: null,
    error: null,
    errorCode: null,
    trust,
  };

  if (attachment.textStatus === 'READY') {
    return {
      ...base,
      status: 'ready',
      extractedAt: attachment.textExtractedAt?.toISOString() ?? null,
    };
  }

  if (attachment.textStatus === 'PENDING') {
    return { ...base, status: 'pending' };
  }

  if (attachment.textStatus === 'FAILED') {
    return {
      ...base,
      status: 'failed',
      error: attachment.textExtractionError,
      errorCode: isAttachmentTextErrorCode(attachment.textErrorCode)
        ? attachment.textErrorCode
        : null,
    };
  }

  return { ...base, status: 'not_applicable' };
}

/** Where the effective text's pages begin: none for a correction (ADR-101). */
export function effectivePageStarts(
  attachment: Pick<AttachmentTextRow, 'correctedText' | 'textPageStarts'>,
): readonly number[] {
  return attachment.correctedText === null ? attachment.textPageStarts : [];
}

/**
 * The text read as asked for (issue #133, ADR-101): the whole text when the
 * request names neither a budget nor a stretch, otherwise the stretch, or its
 * map when it is over the budget.
 *
 * `pageStarts` describe the effective text, which the caller decides: a
 * correction is a person's text and may have moved a paragraph across a page,
 * so a corrected text is read with none and mapped by its headings and
 * paragraphs like any text without pages.
 */
export function shapeTextRead(
  projected: AttachmentTextResponse,
  pageStarts: readonly number[],
  query: AttachmentTextReadQuery,
): AttachmentTextReadResponse {
  const text = projected.text;
  const pages =
    text === null ? null : (attachmentPageUnits(pageStarts, text.length).at(-1)?.toPage ?? null);
  const base = { totalChars: text?.length ?? null, pages };
  const asked = Object.values(query).some((value) => value !== undefined);
  if (!asked || text === null) {
    return { ...projected, ...base, view: 'content', map: null, range: null };
  }
  const read = readAttachmentText(text, pageStarts, query);
  if (!read.ok) {
    throw new AppError(
      'attachment_text_range_invalid',
      'The requested stretch of text is not there',
      { reason: read.reason, totalChars: text.length, pages },
    );
  }
  return {
    ...projected,
    ...base,
    text: read.text,
    machineText: null,
    view: read.view,
    map: read.map,
    range: read.range,
  };
}
