import { type ApiErrorResponse } from '@exocortex/contracts';

import { messageForCode } from './error-messages';

/**
 * Error thrown by every failed API call. `message` is the sentence for the
 * UI, read in the active language when it is read rather than when the call
 * failed, so an error still on screen follows a change of language.
 */
export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly correlationId: string | null;
  public readonly details: unknown;

  constructor(status: number, body: Partial<ApiErrorResponse> | null) {
    super();
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code ?? 'internal_error';
    this.correlationId = body?.correlationId ?? null;
    this.details = body?.details;
  }

  override get message(): string {
    return messageForCode(this.code);
  }
}

export interface RequestOptions {
  // PUT joins the four for the one endpoint that replaces a value whole
  // rather than patching it: a workspace's own provider key (ADR-023).
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Thin fetch wrapper.
 *
 * Always same-origin and always with credentials, so the session cookie is sent
 * and CSRF protection (origin checking in Better Auth) applies.
 */
export async function apiRequest<TResponse>(
  path: string,
  options: RequestOptions = {},
): Promise<TResponse> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers:
      options.body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (response.status === 204) return undefined as TResponse;

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError(response.status, payload as Partial<ApiErrorResponse> | null);
  }
  return payload as TResponse;
}

/**
 * Posts a file as `multipart/form-data`.
 *
 * `fetch` directly rather than `apiRequest`: the browser has to set the
 * multipart boundary itself, which it only does when no content type is given.
 */
export async function uploadRequest<TResponse>(path: string, form: FormData): Promise<TResponse> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    body: form,
  });

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError(response.status, payload as Partial<ApiErrorResponse> | null);
  }
  return payload as TResponse;
}
