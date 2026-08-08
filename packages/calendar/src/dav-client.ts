import { type Logger } from '@exocortex/logger';

import { type CalDavCredentials } from './types';
import { parseXml, type XmlNode } from './xml';

/**
 * A CalDAV request failed. Carries the HTTP status so callers can tell an
 * authentication problem from a missing collection.
 *
 * The message never contains the password, and never the response body beyond a
 * short excerpt: a CalDAV error body can include the whole calendar object that
 * caused it, which would put appointment contents into the log.
 */
export class CalDavError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'CalDavError';
  }

  /** Wrong credentials, or a password that has been revoked. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface DavRequestOptions {
  method: 'PROPFIND' | 'REPORT' | 'GET' | 'OPTIONS';
  /** Absolute URL, or a server path such as `/caldav/`. */
  url: string;
  body?: string;
  depth?: '0' | '1';
  /** Overrides the default 30s. A multiget over a year of events needs longer. */
  timeoutMs?: number;
}

export interface DavResponse {
  status: number;
  text: string;
  /** Parsed only for `multistatus` bodies; null for an empty or non-XML one. */
  xml: Record<string, XmlNode> | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Fetch, narrowed to what this client uses, so tests can hand in a fake. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface DavClientOptions {
  credentials: CalDavCredentials;
  logger: Logger;
  fetchImpl?: FetchLike;
}

export class DavClient {
  private readonly origin: string;
  private readonly authorization: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: DavClientOptions) {
    const base = new URL(options.credentials.baseUrl);
    this.origin = base.origin;
    const raw = `${options.credentials.username}:${options.credentials.password}`;
    this.authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * Turns a server-relative href into an absolute URL.
   *
   * Every href in a multistatus response is a path, not a URL, and it is
   * resolved against the *origin* rather than against the request URL: a
   * `calendar-home-set` of `/caldav/` discovered while asking about
   * `/principals/users/3` must not become `/principals/caldav/`.
   */
  resolve(href: string): string {
    return new URL(href, this.origin).toString();
  }

  async request(options: DavRequestOptions): Promise<DavResponse> {
    const url = this.resolve(options.url);
    const headers: Record<string, string> = {
      authorization: this.authorization,
      // Servers that content-negotiate hand back HTML error pages otherwise.
      accept: 'application/xml, text/xml',
    };
    if (options.body !== undefined) headers['content-type'] = 'application/xml; charset=utf-8';
    if (options.depth !== undefined) headers.depth = options.depth;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CalDavError(`${options.method} ${url} failed: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }

    // Method, URL and status only. A CalDAV body is calendar content.
    this.options.logger.debug('CalDAV request', { method: options.method, url, status });

    // 207 Multi-Status is the normal success here; 200 for OPTIONS/GET.
    if (status !== 207 && status !== 200) {
      throw new CalDavError(
        `${options.method} ${url} -> HTTP ${status}: ${excerpt(text)}`,
        status,
      );
    }

    return { status, text, xml: text.trim().length === 0 ? null : parseXml(text) };
  }
}

/**
 * A short, single-line excerpt for an error message. Bounded because a CalDAV
 * error body can carry the whole rejected calendar object, and an appointment's
 * contents do not belong in a log line.
 */
function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}
