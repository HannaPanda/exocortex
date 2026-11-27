import {
  type AttachmentTextResponse,
  attachmentTrustFor,
  documentTextMetadataSchema,
  isAttachmentTextErrorCode,
  screeningFromColumn,
} from '@exocortex/contracts';

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
