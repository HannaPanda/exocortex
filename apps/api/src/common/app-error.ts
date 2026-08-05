import { API_ERROR_STATUS, type ApiErrorCode } from '@exocortex/contracts';

/**
 * The single error type the API throws.
 *
 * Every error carries a machine-readable `code` from the shared contract, which
 * maps to a fixed HTTP status. Stack traces and internal details never reach the
 * client in production (see `ApiExceptionFilter`).
 */
export class AppError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.details = details;
  }

  static notFound(what: string): AppError {
    return new AppError('not_found', `${what} was not found`);
  }

  static unauthenticated(reason = 'No valid session'): AppError {
    return new AppError('unauthenticated', reason);
  }

  static forbidden(reason: string): AppError {
    return new AppError('forbidden', reason);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError('validation_failed', message, details);
  }

  static conflict(message: string): AppError {
    return new AppError('conflict', message);
  }

  static internal(message = 'Unexpected internal error'): AppError {
    return new AppError('internal_error', message);
  }
}
