import { type MediaDocumentInfo, type MediaDocumentMetadata } from './media-info';

/**
 * What a media block says about its file, as short German labels.
 *
 * Pure functions, no DOM: the meta bar and the text dialog both render from
 * these, and neither needs the other to do it (issue #97).
 */

/** `2026-04-26T11:56:10.000Z` as `26.04.2026`, without depending on a locale. */
export function formatDay(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${parsed.getUTCFullYear()}`;
}

/**
 * The document's facts as short German labels.
 *
 * Only what is actually known is listed. A null means no source could tell, not
 * zero, so "0 Tabellen" would be a claim nobody made -- and a row of "unbekannt"
 * would be noise in a header that has to stay one line.
 */
export function describeDocument(metadata: MediaDocumentMetadata | null): string[] {
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
  if (metadata.pageCount !== null) {
    chips.push(metadata.pageCount === 1 ? '1 Seite' : `${metadata.pageCount} Seiten`);
  }
  if (metadata.tableCount !== null && metadata.tableCount > 0) {
    chips.push(metadata.tableCount === 1 ? '1 Tabelle' : `${metadata.tableCount} Tabellen`);
  }
  if (metadata.pictureCount !== null && metadata.pictureCount > 0) {
    chips.push(metadata.pictureCount === 1 ? '1 Bild' : `${metadata.pictureCount} Bilder`);
  }
  if (metadata.createdAt !== null) {
    const day = formatDay(metadata.createdAt);
    if (day !== null) chips.push(day);
  }
  if (metadata.ocrUsed === true) chips.push('per Texterkennung gelesen');
  return chips;
}

/**
 * `not_applicable` only ever reaches this point for a file that *could* be
 * read, because the silent case returns earlier: it means nobody has asked yet.
 *
 * `ready` used to be `null`, i.e. silent: a successfully read PDF said nothing
 * at all, which left no visible way to get to the text (issue #2). Saying so
 * is also what gives the "Ansehen" action somewhere to sit.
 */
export const STATUS_NOTES: Record<MediaDocumentInfo['status'], string | null> = {
  not_applicable: 'Noch nicht ausgelesen',
  pending: 'Text wird ausgelesen …',
  ready: 'Text gelesen',
  failed: 'Kein Text lesbar',
};

/**
 * Independent of `status`: a correction can exist on a `failed` or even a
 * `not_applicable` attachment (a person can describe a scan by hand when
 * automatic extraction is switched off), and a truncation is a fact about the
 * last successful read, not about the current one.
 */
export function describeCorrectionAndTruncation(info: MediaDocumentInfo): string[] {
  const chips: string[] = [];
  if (info.correction !== null) chips.push('Von Hand korrigiert');
  if (info.truncated) chips.push('Gekürzt');
  return chips;
}
