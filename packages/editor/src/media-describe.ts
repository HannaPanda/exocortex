import { type EditorWords } from './editor-words';
import { type MediaDocumentInfo, type MediaDocumentMetadata } from './media-info';

/**
 * What a media block says about its file, as short labels in the words the
 * host handed in (`EditorWords`, issue #98).
 *
 * Pure functions, no DOM: the meta bar and the text dialog both render from
 * these, and neither needs the other to do it (issue #97).
 */

type MediaWords = EditorWords['media'];

/**
 * The document's facts as short labels.
 *
 * Only what is actually known is listed. A null means no source could tell, not
 * zero, so "0 Tabellen" would be a claim nobody made -- and a row of "unbekannt"
 * would be noise in a header that has to stay one line.
 */
export function describeDocument(
  metadata: MediaDocumentMetadata | null,
  words: MediaWords,
): string[] {
  if (metadata === null) return [];

  const chips: string[] = [];
  if (metadata.title !== null) chips.push(metadata.title);
  if (metadata.author !== null) chips.push(metadata.author);
  // A scan usually carries neither a title nor an author, and then the software
  // that produced it ("PFU ScanSnap Home 3.6.1") is the only thing identifying
  // where the document came from. Next to a real title it would just be noise,
  // so it fills in rather than adding on.
  if (metadata.title === null && metadata.author === null && metadata.creator !== null) {
    chips.push(metadata.creator);
  }
  if (metadata.pageCount !== null) chips.push(words.pages(metadata.pageCount));
  if (metadata.tableCount !== null && metadata.tableCount > 0) {
    chips.push(words.tables(metadata.tableCount));
  }
  if (metadata.pictureCount !== null && metadata.pictureCount > 0) {
    chips.push(words.pictures(metadata.pictureCount));
  }
  if (metadata.createdAt !== null) {
    const day = words.day(metadata.createdAt);
    if (day !== null) chips.push(day);
  }
  if (metadata.ocrUsed === true) chips.push(words.ocrUsed);
  return chips;
}

/**
 * Why the last read failed, in the reader's words when the row carries a code
 * and in the stored English detail when it is older than the codes.
 */
export function describeTextError(info: MediaDocumentInfo, words: MediaWords): string | null {
  if (info.errorCode !== null) return words.textError(info.errorCode);
  return info.error;
}

/**
 * Independent of `status`: a correction can exist on a `failed` or even a
 * `not_applicable` attachment (a person can describe a scan by hand when
 * automatic extraction is switched off), and a truncation is a fact about the
 * last successful read, not about the current one.
 */
export function describeCorrectionAndTruncation(
  info: MediaDocumentInfo,
  words: MediaWords,
): string[] {
  const chips: string[] = [];
  if (info.correction !== null) chips.push(words.corrected);
  if (info.truncated) chips.push(words.truncated);
  return chips;
}
