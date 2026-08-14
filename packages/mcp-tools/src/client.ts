import { type z } from 'zod';

import { apiErrorResponseSchema } from '@exocortex/contracts';

/**
 * HTTP surface the tools are written against.
 *
 * The catalogue never imports Prisma, the queue or the storage package: every
 * tool goes through the REST API, so authorization, validation and business
 * logic stay in `apps/api` and an MCP call can never take a shortcut past a
 * policy check. It also means the same catalogue works against a remote
 * deployment.
 */
export interface ExocortexApiClient {
  request<T>(input: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string; // e.g. '/api/workspaces'
    query?: Readonly<Record<string, string | number | boolean | undefined>>;
    body?: unknown;
    /** Parses and validates the response. */
    responseSchema: z.ZodType<T>;
  }): Promise<T>;
  /**
   * Where a human reads this deployment, e.g. `https://exocortex.app`. Only
   * the research tools need it, to hand ChatGPT a citation URL a person can
   * actually click; every other tool answers in ids. Absent when the caller
   * did not configure one, and a tool must then fall back to the id alone.
   */
  readonly appUrl?: string;
  /** Multipart upload; separate because the body is not JSON. */
  upload<T>(input: {
    path: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    fields?: Readonly<Record<string, string>>;
    responseSchema: z.ZodType<T>;
  }): Promise<T>;
}

/** Thrown when the API answers with an `ApiErrorResponse`. */
export class ExocortexApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly correlationId: string | null,
  ) {
    super(message);
    this.name = 'ExocortexApiError';
  }
}

export interface FetchClientOptions {
  baseUrl: string;
  /** `exo_…` API token or `exos_…` service token. Sent as `Authorization: Bearer`. */
  token: string;
  timeoutMs?: number; // default 30_000
  /** Optional extra headers, e.g. HTTP basic auth when going through nginx. */
  headers?: Readonly<Record<string, string>>;
  /** Public origin a human uses, for citation URLs. See `ExocortexApiClient`. */
  appUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const url = new URL(path, baseUrl);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function throwForErrorResponse(response: Response): Promise<never> {
  let parsedBody: unknown;
  try {
    parsedBody = await response.json();
  } catch {
    parsedBody = undefined;
  }

  const parsed = apiErrorResponseSchema.safeParse(parsedBody);
  if (parsed.success) {
    throw new ExocortexApiError(
      parsed.data.code,
      parsed.data.message,
      response.status,
      parsed.data.correlationId,
    );
  }
  throw new ExocortexApiError('internal_error', response.statusText, response.status, null);
}

/**
 * Builds a `fetch`-based `ExocortexApiClient`. Every call carries the bearer
 * token and an `AbortSignal.timeout`; non-2xx responses become
 * `ExocortexApiError` with the real error code whenever the body parses as an
 * `ApiErrorResponse`, otherwise `internal_error`.
 */
export function createFetchApiClient(options: FetchClientOptions): ExocortexApiClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function baseHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${options.token}`,
      ...options.headers,
    };
  }

  return {
    appUrl: options.appUrl,

    async request<T>(input: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      path: string;
      query?: Readonly<Record<string, string | number | boolean | undefined>>;
      body?: unknown;
      responseSchema: z.ZodType<T>;
    }): Promise<T> {
      const url = buildUrl(options.baseUrl, input.path, input.query);
      const hasBody = input.body !== undefined;

      const response = await fetch(url, {
        method: input.method,
        headers: {
          ...baseHeaders(),
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(input.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        await throwForErrorResponse(response);
      }

      if (response.status === 204) {
        return input.responseSchema.parse(undefined);
      }

      const text = await response.text();
      const raw: unknown = text.length > 0 ? JSON.parse(text) : undefined;
      return input.responseSchema.parse(raw);
    },

    async upload<T>(input: {
      path: string;
      filename: string;
      contentType: string;
      bytes: Uint8Array;
      fields?: Readonly<Record<string, string>>;
      responseSchema: z.ZodType<T>;
    }): Promise<T> {
      const url = buildUrl(options.baseUrl, input.path);
      const form = new FormData();
      for (const [key, value] of Object.entries(input.fields ?? {})) {
        form.append(key, value);
      }
      // `Blob` accepts a `BufferSource`; wrapping in a Node `Buffer`-free
      // `Uint8Array` copy keeps this file free of Node-specific globals.
      form.append(
        'file',
        new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
        input.filename,
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: baseHeaders(),
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        await throwForErrorResponse(response);
      }

      const text = await response.text();
      const raw: unknown = text.length > 0 ? JSON.parse(text) : undefined;
      return input.responseSchema.parse(raw);
    },
  };
}
