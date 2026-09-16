import { lookup as resolveHostname } from 'node:dns';
import { type ClientRequest, type IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { type LookupFunction } from 'node:net';

import { disallowedWebhookAddressReason, isIpAddressLiteral } from '@exocortex/contracts';

/**
 * Sending one webhook POST, and nowhere else (issue #63).
 *
 * The host allowlist governs the URL a rule was written with. It cannot govern
 * where that URL *leads*: `fetch()` follows a redirect by default, so an
 * allowed host answering `307` hands the signed body to a target nobody ever
 * checked, and `307` keeps the method and the body intact. That is an SSRF path
 * out of the worker's network, which is the one network in this deployment that
 * can reach the database, Redis and MinIO.
 *
 * So this does not use `fetch` at all. `node:http` follows nothing by itself,
 * and it lets the connection be made through a lookup of our own -- which is the
 * second half of the fix, because an allowed *name* may still resolve into the
 * machine's own network, today or after the DNS record changes. The address is
 * judged in the moment the socket is opened, and it is the address the socket
 * actually uses.
 *
 * A redirect is not a feature this needs. A receiver that has moved can be
 * written into the rule again, and checked against the allowlist again.
 */

export interface WebhookRequestInput {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
}

/** What the run log records about a delivery. Never the receiver's body. */
export interface WebhookResult {
  status: number;
}

export type WebhookSender = (input: WebhookRequestInput) => Promise<WebhookResult>;

export interface WebhookSenderOptions {
  /**
   * Which resolved addresses are refused. Injected so a test can aim a real
   * request at a real server on this machine; production has exactly one
   * answer and it is the one below.
   */
  addressRefusal?: (address: string) => string | null;
}

export function createWebhookSender(options: WebhookSenderOptions = {}): WebhookSender {
  const refusal = options.addressRefusal ?? disallowedWebhookAddressReason;
  const lookup = guardedLookup(refusal);

  return async (input) => {
    const target = new URL(input.url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error('A webhook may only be sent over http or https');
    }
    // A URL that already carries an address never reaches the lookup below:
    // the socket layer skips DNS for a literal, so the guard has to be here as
    // well or `http://127.0.0.1/` walks straight past it.
    if (isIpAddressLiteral(target.hostname)) {
      const written = refusal(target.hostname);
      if (written !== null) throw new Error(written);
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return await new Promise<WebhookResult>((resolve, reject) => {
      const request = send(
        target,
        {
          method: 'POST',
          headers: {
            ...input.headers,
            'content-length': String(Buffer.byteLength(input.body)),
          },
          lookup,
          // No pooling: a reused socket is a connection whose address was
          // judged at some earlier time, and "at the time of the request" is
          // the whole point.
          agent: false,
          signal: AbortSignal.timeout(input.timeoutMs),
        },
        (response) => {
          settle(response, request, resolve, reject);
        },
      );
      request.on('error', reject);
      request.end(input.body);
    });
  };
}

/**
 * The outcome of one answer.
 *
 * A redirect fails the run rather than being followed, and it fails before the
 * body is read: what a receiver says in a `302` is of no interest, and reading
 * it would only put somebody else's text into this process.
 */
function settle(
  response: IncomingMessage,
  request: ClientRequest,
  resolve: (result: WebhookResult) => void,
  reject: (error: Error) => void,
): void {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    response.destroy();
    request.destroy();
    reject(
      new Error(
        `The webhook answered ${String(status)} with a redirect, and a webhook is never redirected`,
      ),
    );
    return;
  }
  response.resume();
  response.on('end', () => {
    resolve({ status });
  });
  response.on('error', reject);
}

/**
 * A DNS lookup that refuses to hand back an address the deployment may not
 * reach.
 *
 * Every address is judged, not only the first: with Happy Eyeballs the socket
 * layer asks for all of them and picks, so a name that answers with one public
 * and one loopback address must be refused outright rather than left to a race.
 */
function guardedLookup(refusal: (address: string) => string | null): LookupFunction {
  return (hostname, options, callback) => {
    resolveHostname(hostname, options, (error, address, family) => {
      if (error !== null) {
        callback(error, '', 0);
        return;
      }
      const addresses = typeof address === 'string' ? [address] : address.map((one) => one.address);
      for (const one of addresses) {
        const reason = refusal(one);
        if (reason !== null) {
          callback(new Error(reason), '', 0);
          return;
        }
      }
      callback(null, address, family);
    });
  };
}
