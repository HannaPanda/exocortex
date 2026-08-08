import { CalDavError, type DavClient } from './dav-client';

/**
 * Writing to a CalDAV collection.
 *
 * Every write here is conditional, without an escape hatch. A PUT that creates
 * carries `If-None-Match: *`, a PUT that replaces carries `If-Match: <etag>`, and
 * a delete carries the etag as well. That is not caution for its own sake: the
 * calendar on the other side is also open in a phone and in a mail client, and an
 * unconditional PUT silently discards whatever those wrote in between. A rejected
 * precondition is reported as data, so the caller re-reads instead of retrying
 * with the same stale body.
 */

const CALENDAR_CONTENT_TYPE = 'text/calendar; charset=utf-8';

export interface PutCalendarObjectInput {
  /** Full path of the object, e.g. `/caldav/main/abc.ics`. */
  href: string;
  ics: string;
  /**
   * The version being replaced. Null means "must not exist yet" and sends
   * `If-None-Match: *`, which is what makes a create fail rather than overwrite
   * a stranger's object that happens to sit at the same path.
   */
  ifMatch: string | null;
}

export interface PutCalendarObjectResult {
  /**
   * The new version, when the server states it on the write. Null means the next
   * read has to fetch the body once to learn it, which costs one request and no
   * correctness.
   */
  etag: string | null;
  /** False when the server rejected our precondition; nothing was written. */
  written: boolean;
}

export async function putCalendarObject(
  client: DavClient,
  input: PutCalendarObjectInput,
): Promise<PutCalendarObjectResult> {
  try {
    const response = await client.request({
      method: 'PUT',
      url: input.href,
      body: input.ics,
      contentType: CALENDAR_CONTENT_TYPE,
      headers: input.ifMatch === null ? { 'if-none-match': '*' } : { 'if-match': input.ifMatch },
      // 201 for a create, 204 for a replace, 200 for a server that answers with
      // the stored object.
      okStatuses: [200, 201, 204],
    });
    return { etag: response.etag, written: true };
  } catch (error) {
    if (error instanceof CalDavError && error.isPreconditionFailed) {
      return { etag: null, written: false };
    }
    throw error;
  }
}

/**
 * Deletes an object. Returns false when the precondition failed, true when the
 * object is gone -- including when it was already gone, because that is the state
 * the caller asked for and reporting it as a failure would make the caller retry
 * forever.
 */
export async function deleteCalendarObject(
  client: DavClient,
  input: { href: string; ifMatch: string | null },
): Promise<boolean> {
  try {
    await client.request({
      method: 'DELETE',
      url: input.href,
      headers: input.ifMatch === null ? {} : { 'if-match': input.ifMatch },
      okStatuses: [200, 202, 204, 404, 410],
    });
    return true;
  } catch (error) {
    if (error instanceof CalDavError && error.isPreconditionFailed) return false;
    throw error;
  }
}

/**
 * Where a new object goes inside a collection.
 *
 * The UID as the filename is convention, not requirement, and it is worth
 * following: a server's own listings become readable, and a second create with
 * the same UID lands on the same path instead of quietly duplicating the
 * appointment. Percent-encoded, since a UID may legally contain a slash.
 */
export function calendarObjectHref(collectionHref: string, uid: string): string {
  const base = collectionHref.endsWith('/') ? collectionHref : `${collectionHref}/`;
  return `${base}${encodeURIComponent(uid)}.ics`;
}
