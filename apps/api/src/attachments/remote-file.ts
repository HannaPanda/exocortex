import * as http from 'node:http';
import { type IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { type LookupFunction } from 'node:net';

import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import {
  checkPublicAddress,
  PrivateAddressError,
  publicOnlyLookup,
  type Resolver,
} from '../research/public-address';

/**
 * Fetching a file somebody named by address (issue #117).
 *
 * Its own file rather than three more methods on `AttachmentsService`: what it
 * does has nothing to do with attachments. It makes an outgoing request on a
 * caller's behalf, which is a thing with its own rules -- the address check of
 * ADR-033 before every hop, a timeout, a size ceiling -- and those rules are
 * easier to audit in one place than interleaved with object-storage keys and
 * MIME sniffing.
 *
 * `node:http` rather than `fetch`, because the socket has to be handed the
 * `lookup` that judged the address (issue #178). With `fetch` the check and
 * the connection resolved the name twice, independently, and a name with a
 * short TTL could answer publicly to the first and with this host's Docker
 * network to the second.
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
function filenameFor(response: IncomingMessage, url: string): string {
  const disposition = response.headers['content-disposition'] ?? '';
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
async function readCapped(body: IncomingMessage, maxBytes: number, url: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const value = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
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
  } catch (error) {
    if (error instanceof AppError) throw error;
    // A timeout or a dropped connection halfway through the body.
    throw new AppError('web_fetch_failed', 'The address could not be fetched', { url });
  } finally {
    body.destroy();
  }
  return Buffer.concat(chunks);
}

/**
 * One request, no redirects followed, on a socket whose address came from
 * `lookup`. `agent: false` so no pooled socket from another lookup is reused.
 * `accept-encoding: identity` because `node:http` decompresses nothing, and
 * the size ceiling is meant for the bytes that are stored.
 */
function requestOnce(url: string, lookup: LookupFunction): Promise<IncomingMessage> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: 'GET',
        agent: false,
        lookup,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: '*/*', 'accept-encoding': 'identity' },
      },
      resolve,
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Fetches an address, following redirects by hand so every hop is checked.
 *
 * Following redirects by hand is the point of the loop. Letting the client
 * follow one would mean the only address ever judged is the one the caller typed,
 * and a redirect into this host's Docker network is the cheapest way past a
 * check that stops there (ADR-033).
 */
export async function fetchRemoteFile(
  url: string,
  options: {
    maxBytes: number;
    logger: Logger;
    correlationId: string;
    /** Only for tests: a resolver that can change its answer between calls. */
    resolve?: Resolver;
  },
): Promise<RemoteFile> {
  const lookup = publicOnlyLookup(options.resolve);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const checked = await checkPublicAddress(current, options.resolve);
    if (!checked.allowed) {
      throw new AppError('web_address_refused', 'This address may not be fetched', {
        reason: checked.reason,
        detail: checked.detail,
      });
    }

    let response: IncomingMessage;
    try {
      response = await requestOnce(checked.url, lookup);
    } catch (error) {
      // The name answered differently at the socket than at the check above.
      // That is the rebinding this exists to stop, and it is the same refusal.
      if (error instanceof PrivateAddressError) {
        options.logger.warn('Refused an address at connect time', {
          url: checked.url,
          correlationId: options.correlationId,
          detail: error.detail,
        });
        throw new AppError('web_address_refused', 'This address may not be fetched', {
          reason: 'private_address',
          detail: error.detail,
        });
      }
      options.logger.info('Could not fetch a file', {
        url: checked.url,
        correlationId: options.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new AppError('web_fetch_failed', 'The address could not be fetched', {
        url: checked.url,
      });
    }

    const status = response.statusCode ?? 0;
    if (REDIRECT_STATUS.has(status)) {
      const location = response.headers.location;
      response.destroy();
      if (location === undefined) {
        throw new AppError('web_fetch_failed', 'The address redirected nowhere');
      }
      current = new URL(location, checked.url).toString();
      continue;
    }

    if (status < 200 || status > 299) {
      response.destroy();
      throw new AppError('web_fetch_failed', 'The address answered with an error', {
        url: checked.url,
        statusCode: status,
      });
    }

    return {
      url: checked.url,
      filename: filenameFor(response, checked.url),
      contentType: response.headers['content-type']?.split(';')[0]?.trim(),
      body: await readCapped(response, options.maxBytes, checked.url),
    };
  }

  throw new AppError('web_fetch_failed', 'The address redirected too many times', { url });
}
