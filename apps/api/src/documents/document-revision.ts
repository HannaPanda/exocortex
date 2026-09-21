import { AppError } from '../common/app-error';

/**
 * Optimistic concurrency for page writes, in one place (issue #120).
 *
 * There is exactly one revision of a page: `DocumentContent.yjsUpdatedAt`. It
 * is what every write compares `expectedYjsUpdatedAt` against, and since #120
 * it is also what every read answers with, so a caller never has to derive it
 * from something that looks like it.
 *
 * The check used to be four lines copied into two services and a refusal that
 * said only "the document changed". That was true and useless: the value an
 * agent had sent was usually not a stale revision at all but the frontmatter's
 * `updatedAt`, which is the `document` row's timestamp and a different clock
 * entirely. Every read-then-write therefore failed, and the only way through
 * was to drop the parameter and write without a guard. So the refusal now says
 * which of the two happened, and hands back the revision to retry with.
 */
export function assertExpectedRevision(input: {
  /** What the caller sent, or `undefined` to write unconditionally. */
  expected: string | undefined;
  /** The page's revision right now. */
  current: Date;
  /**
   * The `document` row's `updatedAt`, which is what the export writes into the
   * frontmatter. Named here only to tell the two mistakes apart; pass `null`
   * where the caller has not loaded it.
   */
  documentUpdatedAt: Date | null;
}): void {
  if (input.expected === undefined) return;
  const current = input.current.toISOString();
  if (input.expected === current) return;

  const confused =
    input.documentUpdatedAt !== null && input.expected === input.documentUpdatedAt.toISOString();
  const reason = confused
    ? `expectedYjsUpdatedAt war das updatedAt aus dem Frontmatter der Seite, nicht ihre ` +
      `Revision. Die Revision steht in derselben Leseantwort als yjsUpdatedAt und lautet ` +
      `${current}. Mit diesem Wert erneut schreiben.`
    : `Die Seite wurde seit dem Lesen geändert. Ihre Revision ist jetzt ${current}. Erneut ` +
      `lesen, die Änderung auf den neuen Stand beziehen und mit dieser Revision schreiben.`;

  throw new AppError('document_content_conflict', 'The document changed since it was last read', {
    reason,
    currentYjsUpdatedAt: current,
    /** True when the caller sent the frontmatter timestamp instead of the revision. */
    sentDocumentUpdatedAt: confused,
  });
}
