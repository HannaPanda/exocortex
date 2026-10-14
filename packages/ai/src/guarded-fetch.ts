import * as http from 'node:http';
import { type IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { isPublicAddress, PrivateAddressError, publicOnlyLookup } from './public-address';

/**
 * A `fetch` for requests to an address somebody else chose (issue #196).
 *
 * The MCP SDK takes a `fetch` and makes every request of a connection through
 * it, which is the one seam where the address rules of ADR-033 can be applied
 * to a third-party protocol client without forking it. Built on `node:http`
 * rather than the global `fetch`, because the global one resolves the name
 * itself and cannot be handed a `lookup`; with `publicOnlyLookup` on the socket
 * the address judged is the address dialled (issue #178), so a name that
 * answers publicly at the check and privately at the connect gets nowhere.
 *
 * Three more rules than `publicOnlyLookup` alone:
 *
 * - **A literal address is judged here.** Node never calls a `lookup` for
 *   `https://127.0.0.1/`, so the socket-level guard would wave it through.
 * - **Plain `http` is refused** unless the caller says otherwise. A bearer
 *   token sent in the clear is a token for whoever is on the path; the only
 *   caller that turns this off is a test talking to its own loopback server.
 * - **Nothing is followed.** A redirect comes back as the 3xx it is, and the
 *   SDK decides whether to ask again (it only does so within the origin). The
 *   next request passes through here again, so a redirect into the host's own
 *   network is refused like any other private address.
 *
 * The body is counted while it streams and the connection is torn down at
 * `maxResponseBytes`, so a server that answers forever costs a bounded amount
 * of memory rather than a worker.
 */

export interface GuardedFetchOptions {
  /** Upper bound for one response body, in bytes. */
  maxResponseBytes: number;
  /**
   * Called when a body is cut at the limit. A client that reads the stream in
   * the background (the MCP SDK does, for SSE) may swallow the stream's error
   * and wait for an answer that will never come; this lets the caller abort
   * the whole operation instead.
   */
  onResponseTooLarge?: (error: ResponseTooLargeError) => void;
  /** Only for tests: allow `http:` and use this lookup instead of the public-only one. */
  insecureForTests?: {
    lookup: LookupFunction;
    allowLiteral: (address: string) => boolean;
  };
}

export type GuardedFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** A response body that went over `maxResponseBytes`. */
export class ResponseTooLargeError extends Error {
  readonly code = 'ERESPONSETOOLARGE';

  constructor(readonly limit: number) {
    super(`The response exceeded ${String(limit)} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** A URL the guard refused before any connection was opened. */
export class RefusedAddressError extends Error {
  readonly code = 'EREFUSEDADDRESS';

  constructor(
    readonly reason: 'unsupported_scheme' | 'private_address' | 'credentials_in_url',
    readonly detail: string,
  ) {
    super(`Address refused (${reason}): ${detail}`);
    this.name = 'RefusedAddressError';
  }
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyBytes(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  // The SDK only ever sends JSON strings. Anything else would be a change in
  // the SDK that should fail here, visibly, rather than be sent half-encoded.
  throw new TypeError('guardedFetch only sends string or byte bodies');
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  return headers;
}

/**
 * The response body as a web stream, counted as it goes.
 *
 * Pull-driven, so a consumer that stops reading stops the socket too instead
 * of the bytes piling up in the controller's queue.
 */
function cappedStream(
  message: IncomingMessage,
  limit: number,
  onTooLarge: ((error: ResponseTooLargeError) => void) | undefined,
): ReadableStream<Uint8Array> {
  let received = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      message.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > limit) {
          const error = new ResponseTooLargeError(limit);
          message.destroy(error);
          controller.error(error);
          onTooLarge?.(error);
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) message.pause();
      });
      message.on('end', () => {
        try {
          controller.close();
        } catch {
          // Already errored by the size cap; nothing left to close.
        }
      });
      message.on('error', (error) => {
        try {
          controller.error(error);
        } catch {
          // Already closed or errored.
        }
      });
    },
    pull() {
      message.resume();
    },
    cancel() {
      message.destroy();
    },
  });
}

export function createGuardedFetch(options: GuardedFetchOptions): GuardedFetch {
  const lookup = options.insecureForTests?.lookup ?? publicOnlyLookup();
  const allowLiteral = options.insecureForTests?.allowLiteral ?? isPublicAddress;
  const allowedProtocols = options.insecureForTests ? ['https:', 'http:'] : ['https:'];

  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof URL ? input.toString() : input);
      if (!allowedProtocols.includes(url.protocol)) {
        reject(new RefusedAddressError('unsupported_scheme', url.protocol));
        return;
      }
      if (url.username !== '' || url.password !== '') {
        reject(new RefusedAddressError('credentials_in_url', url.host));
        return;
      }
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      if (isIP(host) !== 0 && !allowLiteral(host)) {
        reject(new RefusedAddressError('private_address', host));
        return;
      }

      const signal = init?.signal ?? undefined;
      if (signal?.aborted === true) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
        return;
      }

      const transport = url.protocol === 'https:' ? https : http;
      const body = bodyBytes(init?.body);
      const request = transport.request(
        url,
        {
          method: init?.method ?? 'GET',
          headers: headerRecord(init),
          lookup,
          // No pooled sockets: a connection kept alive past this request would
          // carry the address judged for it into a later one.
          agent: false,
          ...(signal ? { signal } : {}),
        },
        (message) => {
          const status = message.statusCode ?? 0;
          const noBody = status === 204 || status === 304 || init?.method === 'HEAD';
          if (noBody) message.resume();
          resolve(
            new Response(
              noBody
                ? null
                : cappedStream(message, options.maxResponseBytes, options.onResponseTooLarge),
              {
                status,
                statusText: message.statusMessage ?? '',
                headers: responseHeaders(message),
              },
            ),
          );
        },
      );
      request.on('error', (error) => {
        reject(
          error instanceof PrivateAddressError
            ? new RefusedAddressError('private_address', error.detail)
            : error,
        );
      });
      request.end(body);
    });
}
