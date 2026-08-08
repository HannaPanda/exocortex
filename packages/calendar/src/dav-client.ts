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

  /**
   * The object changed on the server since the etag we sent.
   *
   * Not a failure to retry: our body was written against a version that no
   * longer exists, so the only safe answer is to read the new one first. Every
   * write here is conditional precisely so this shows up as a status instead of
   * as a silently overwritten appointment.
   */
  get isPreconditionFailed(): boolean {
    return this.status === 412;
  }

  /** The object is not there. For a delete, that is the desired end state. */
  get isNotFound(): boolean {
    return this.status === 404 || this.status === 410;
  }
}

export interface DavRequestOptions {
  method: 'PROPFIND' | 'REPORT' | 'GET' | 'OPTIONS' | 'PUT' | 'DELETE';
  /** Absolute URL, or a server path such as `/caldav/`. */
  url: string;
  body?: string;
  depth?: '0' | '1';
  /** Overrides the default 30s. A multiget over a year of events needs longer. */
  timeoutMs?: number;
  /** Overrides the default `application/xml`. A calendar object is `text/calendar`. */
  contentType?: string;
  /** Extra headers, lowercase keys. Conditional writes travel here. */
  headers?: Readonly<Record<string, string>>;
  /**
   * Which statuses count as success. Defaults to the read statuses, because a
   * write answers 201 Created or 204 No Content and has to say so itself.
   */
  okStatuses?: readonly number[];
}

export interface DavResponse {
  status: number;
  text: string;
  /** Parsed only for `multistatus` bodies; null for an empty or non-XML one. */
  xml: Record<string, XmlNode> | null;
  /**
   * The version the server reports for the resource, when it reports one on the
   * response itself. A write that gets an etag back saves the next pass a fetch;
   * a server that omits it is entirely within its rights, hence nullable.
   */
  etag: string | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** 200 OK for a GET or OPTIONS, 207 Multi-Status for the report-style reads. */
const READ_OK_STATUSES = [200, 207] as const;

/** Fetch, narrowed to what this client uses, so tests can hand in a fake. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  text: () => Promise<string>;
  /** Optional so a test fake can stay a two-liner. */
  headers?: { get: (name: string) => string | null };
}>;

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
      ...options.headers,
    };
    if (options.body !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/xml; charset=utf-8';
    }
    if (options.depth !== undefined) headers.depth = options.depth;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let status: number;
    let text: string;
    let etag: string | null;
    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
      etag = response.headers?.get('etag') ?? null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CalDavError(`${options.method} ${url} failed: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }

    // Method, URL and status only. A CalDAV body is calendar content.
    this.options.logger.debug('CalDAV request', { method: options.method, url, status });

    const ok = options.okStatuses ?? READ_OK_STATUSES;
    if (!ok.includes(status)) {
      throw new CalDavError(
        `${options.method} ${url} -> HTTP ${status}: ${excerpt(text)}`,
        status,
      );
    }

    return { status, text, xml: parseIfXml(text), etag };
  }
}

/**
 * Parses a body only when it actually looks like XML.
 *
 * A read always answers `multistatus`, but a write answers with nothing at all,
 * and an accepted PUT that returned a courtesy HTML page must not fail the write
 * it just completed.
 */
function parseIfXml(text: string): Record<string, XmlNode> | null {
  const trimmed = text.trim();
  return trimmed.startsWith('<') ? parseXml(trimmed) : null;
}

/**
 * A short, single-line excerpt for an error message. Bounded because a CalDAV
 * error body can carry the whole rejected calendar object, and an appointment's
 * contents do not belong in a log line.
 */
function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}
