import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { checkPublicAddress } from '../research/public-address';

/**
 * Fetching a file somebody named by address (issue #117).
 *
 * Its own file rather than three more methods on `AttachmentsService`: what it
 * does has nothing to do with attachments. It makes an outgoing request on a
 * caller's behalf, which is a thing with its own rules -- the address check of
 * ADR-033 before every hop, a timeout, a size ceiling -- and those rules are
 * easier to audit in one place than interleaved with object-storage keys and
 * MIME sniffing.
 */

/** Redirect hops this follows. Enough for a CDN, not for a loop. */
const MAX_REDIRECTS = 3;

/** How long one hop may take. A picture slower than this is not worth waiting for. */
const FETCH_TIMEOUT_MS = 15_000;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface RemoteFile {
  /** The address that finally answered, after any redirects. */
  url: string;
  filename: string;
  /** What the far side said it is. Only ever a hint; the bytes decide. */
  contentType: string | undefined;
  body: Buffer;
}

/**
 * A name for what an address served.
 *
 * `content-disposition` first, because a server that names its file means it;
 * the last path segment otherwise. `sanitizeFilename` still has the last word
 * on the extension, which it takes from the detected type rather than from
 * anything the far side said.
 */
function filenameFor(response: Response, url: string): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const quoted = /filename="([^"]+)"/.exec(disposition)?.[1];
  const bare = /filename=([^;]+)/.exec(disposition)?.[1]?.trim();
  const fromHeader = quoted ?? bare;
  if (fromHeader !== undefined && fromHeader.length > 0) return fromHeader.slice(0, 255);

  const segment = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  return segment.length > 0 ? segment.slice(0, 255) : 'download';
}

/**
 * Reads a body into memory, refusing at `maxBytes` rather than past it.
 *
 * Through the stream with a running count rather than with `arrayBuffer()`: a
 * server that answers without a `content-length` and then streams forever is
 * cut off at the limit instead of filling this process's memory.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  url: string,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new AppError(
          'payload_too_large',
          `The file exceeds the maximum upload size of ${maxBytes} bytes`,
          { url },
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetches an address, following redirects by hand so every hop is checked.
 *
 * `redirect: 'manual'` is the point of the loop. Letting `fetch` follow a
 * redirect would mean the only address ever judged is the one the caller typed,
 * and a redirect into this host's Docker network is the cheapest way past a
 * check that stops there (ADR-033).
 */
export async function fetchRemoteFile(
  url: string,
  options: { maxBytes: number; logger: Logger; correlationId: string },
): Promise<RemoteFile> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const checked = await checkPublicAddress(current);
    if (!checked.allowed) {
      throw new AppError('web_address_refused', 'This address may not be fetched', {
        reason: checked.reason,
        detail: checked.detail,
      });
    }

    let response: Response;
    try {
      response = await fetch(checked.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: '*/*' },
      });
    } catch (error) {
      options.logger.info('Could not fetch a file', {
        url: checked.url,
        correlationId: options.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new AppError('web_fetch_failed', 'The address could not be fetched', {
        url: checked.url,
      });
    }

    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get('location');
      if (location === null) {
        throw new AppError('web_fetch_failed', 'The address redirected nowhere');
      }
      current = new URL(location, checked.url).toString();
      continue;
    }

    if (!response.ok || response.body === null) {
      throw new AppError('web_fetch_failed', 'The address answered with an error', {
        url: checked.url,
        statusCode: response.status,
      });
    }

    return {
      url: checked.url,
      filename: filenameFor(response, checked.url),
      contentType: response.headers.get('content-type')?.split(';')[0]?.trim(),
      body: await readCapped(response.body, options.maxBytes, checked.url),
    };
  }

  throw new AppError('web_fetch_failed', 'The address redirected too many times', { url });
}
