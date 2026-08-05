import { type ApiErrorResponse } from '@exocortex/contracts';

import { messageForCode } from './error-messages';

/** Error thrown by every failed API call. Carries the German message for the UI. */
export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly correlationId: string | null;
  public readonly details: unknown;

  constructor(status: number, body: Partial<ApiErrorResponse> | null) {
    super(messageForCode(body?.code));
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code ?? 'internal_error';
    this.correlationId = body?.correlationId ?? null;
    this.details = body?.details;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
