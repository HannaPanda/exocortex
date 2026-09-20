import { type PushNotificationPayload } from '@exocortex/contracts';

import { encryptPushPayload, MAX_PAYLOAD_BYTES, type PushKeys } from './encrypt';
import { vapidAuthorizationHeader, type VapidKeys } from './vapid';

/**
 * Posting one encrypted notification to one endpoint.
 *
 * Everything above this file works with people and devices; this is the only
 * place that knows a push service exists. It is deliberately a plain `fetch`:
 * the protocol is one POST, and the interesting part -- what a status code
 * means -- is a decision, not a transport detail.
 */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushOutcome =
  /** The push service accepted it. It says nothing about the device. */
  | { status: 'delivered' }
  /**
   * The subscription no longer exists: the browser was uninstalled, the
   * permission withdrawn, the profile wiped. The row is deleted, because
   * retrying is the one thing that is certainly pointless.
   */
  | { status: 'gone'; reason: string }
  /** Anything else. Counted, retried, and eventually given up on. */
  | { status: 'failed'; reason: string; retryAfterSeconds: number | null };

export interface PushSender {
  send(target: PushTarget, payload: PushNotificationPayload): Promise<PushOutcome>;
}

export interface CreatePushSenderOptions {
  keys: VapidKeys;
  /** How long the push service should hold it for a device that is offline. */
  ttlSeconds?: number;
  timeoutMs?: number;
  /** Injected by the test; production uses the global. */
  fetchImpl?: typeof fetch;
}

/**
 * Four hours.
 *
 * Long enough that a phone which was in flight mode over lunch still learns
 * about the comment, short enough that nothing arrives the next morning
 * announcing an appointment that happened yesterday. A calendar reminder is
 * the shortest-lived thing here and it is what sets the number.
 */
const DEFAULT_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 15_000;

export function createPushSender(options: CreatePushSenderOptions): PushSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(target: PushTarget, payload: PushNotificationPayload): Promise<PushOutcome> {
      const text = JSON.stringify(payload);
      if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
        // Not retryable and not the device's fault: the caller built something
        // too big, and the contracts cap every field well below this.
        return {
          status: 'failed',
          reason: 'Notification payload too large',
          retryAfterSeconds: null,
        };
      }

      let body: Buffer;
      let authorization: string;
      try {
        body = encryptPushPayload(text, target as PushKeys);
        authorization = vapidAuthorizationHeader(options.keys, target.endpoint);
      } catch (error) {
        // A subscription whose keys do not parse can never be encrypted to, so
        // it is as dead as one the service has forgotten.
        return { status: 'gone', reason: reasonOf(error) };
      }

      const abort = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(target.endpoint, {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(ttl),
            // "Wake the device up." The alternative, `normal`, lets a phone
            // batch the message until it next talks to its push service, and
            // a notification that arrives an hour late is worse than none.
            Urgency: 'high',
          },
          body: new Uint8Array(body),
          signal: abort,
        });
      } catch (error) {
        return { status: 'failed', reason: reasonOf(error), retryAfterSeconds: null };
      }

      if (response.ok) return { status: 'delivered' };

      /*
       * 404 and 410 are the protocol's way of saying the subscription is over
       * (RFC 8030 section 7.3). Every other code is this deployment's problem
       * or the service's, and both are worth trying again.
       */
      if (response.status === 404 || response.status === 410) {
        return { status: 'gone', reason: `Push service answered ${response.status}` };
      }

      const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
      return {
        status: 'failed',
        reason: `Push service answered ${response.status}${detail === '' ? '' : `: ${detail}`}`,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
      };
    },
  };
}

/**
 * `Retry-After` as seconds, in either of its two spellings.
 *
 * Read but not obeyed: BullMQ's backoff is what actually schedules the retry,
 * and this value is logged so a service that is throttling us says so in the
 * worker's output rather than only in a metric.
 */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.round((date - Date.now()) / 1000));
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
