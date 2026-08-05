import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import { type FastifyReply } from 'fastify';

import { AuthorizationError } from '@exocortex/auth';
import { API_ERROR_STATUS, type ApiErrorCode, type ApiErrorResponse } from '@exocortex/contracts';
import { Prisma } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { ObjectStorageError } from '@exocortex/storage';

import { AppError } from './app-error';
import { CORRELATION_HEADER, currentCorrelationId } from './correlation';
import { LOGGER } from './logger.provider';

interface NormalizedError {
  code: ApiErrorCode;
  status: number;
  message: string;
  details?: unknown;
  /** Whether the underlying error should be logged at error level. */
  unexpected: boolean;
}

function normalize(exception: unknown): NormalizedError {
  if (exception instanceof AppError) {
    return {
      code: exception.code,
      status: exception.status,
      message: exception.message,
      details: exception.details,
      unexpected: exception.status >= 500,
    };
  }

  if (exception instanceof AuthorizationError) {
    // The shared contract owns the code -> status mapping, so a policy denial
    // and an explicitly thrown AppError answer with the same status.
    return {
      code: exception.code,
      status: API_ERROR_STATUS[exception.code],
      message: exception.message,
      unexpected: false,
    };
  }

  if (exception instanceof ObjectStorageError) {
    return {
      code: 'internal_error',
      status: 500,
      message: 'Object storage operation failed',
      unexpected: true,
    };
  }

  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    if (exception.code === 'P2002') {
      return {
        code: 'conflict',
        status: 409,
        message: 'A record with the same unique value already exists',
        unexpected: false,
      };
    }
    if (exception.code === 'P2025') {
      return { code: 'not_found', status: 404, message: 'Record not found', unexpected: false };
    }
    return {
      code: 'internal_error',
      status: 500,
      message: 'Database request failed',
      unexpected: true,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const map: Record<number, ApiErrorCode> = {
      400: 'validation_failed',
      401: 'unauthenticated',
      403: 'forbidden',
      404: 'not_found',
      409: 'conflict',
      413: 'payload_too_large',
      415: 'unsupported_media_type',
      429: 'rate_limited',
    };
    return {
      code: map[status] ?? 'internal_error',
      status,
      message: exception.message,
      unexpected: status >= 500,
    };
  }

  return {
    code: 'internal_error',
    status: 500,
    message: 'Unexpected internal error',
    unexpected: true,
  };
}

/**
 * Converts every thrown error into the shared `ApiErrorResponse` shape.
 *
 * Stack traces are never sent to clients. Unexpected errors are logged with the
 * correlation id so a report from a user can be traced in the logs.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const correlationId = currentCorrelationId();
    const normalized = normalize(exception);

    if (normalized.unexpected) {
      this.logger.error('Request failed', exception, { correlationId, code: normalized.code });
    } else {
      this.logger.warn('Request rejected', {
        correlationId,
        code: normalized.code,
        status: normalized.status,
        reason: normalized.message,
      });
    }

    const body: ApiErrorResponse = {
      code: normalized.code,
      // Developer-facing English message. The web client maps codes to German.
      message: normalized.message,
      correlationId,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    };

    const reply = host.switchToHttp().getResponse<FastifyReply>();
    void reply.status(normalized.status).header(CORRELATION_HEADER, correlationId).send(body);
  }
}
