import { randomUUID } from 'node:crypto';

import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';

import { REDACTED_PATHS, REDACTION_PLACEHOLDER } from './redaction';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface LoggerContext {
  /** Correlation identifier shared by a request, socket session or job. */
  correlationId?: string;
  userId?: string;
  workspaceId?: string;
  documentId?: string;
  jobId?: string;
  queue?: string;
  [key: string]: unknown;
}

export interface Logger {
  trace(message: string, context?: LoggerContext): void;
  debug(message: string, context?: LoggerContext): void;
  info(message: string, context?: LoggerContext): void;
  warn(message: string, context?: LoggerContext): void;
  error(message: string, error?: unknown, context?: LoggerContext): void;
  fatal(message: string, error?: unknown, context?: LoggerContext): void;
  /** Returns a logger that automatically attaches the given context. */
  child(context: LoggerContext): Logger;
  /** Access to the underlying pino instance for framework integrations. */
  readonly raw: PinoLogger;
}

export interface CreateLoggerOptions {
  name: string;
  level?: LogLevel;
  /** Pretty-print for local development. JSON is always used in production. */
  pretty?: boolean;
}

function normalizeError(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) {
    return {
      err: {
        type: error.name,
        message: error.message,
        stack: error.stack,
        ...(error.cause instanceof Error
          ? { cause: { type: error.cause.name, message: error.cause.message } }
          : {}),
      },
    };
  }
  return { err: { type: 'UnknownError', message: String(error) } };
}

function wrap(instance: PinoLogger): Logger {
  return {
    raw: instance,
    trace: (message, context) => instance.trace(context ?? {}, message),
    debug: (message, context) => instance.debug(context ?? {}, message),
    info: (message, context) => instance.info(context ?? {}, message),
    warn: (message, context) => instance.warn(context ?? {}, message),
    error: (message, error, context) =>
      instance.error({ ...(context ?? {}), ...normalizeError(error) }, message),
    fatal: (message, error, context) =>
      instance.fatal({ ...(context ?? {}), ...normalizeError(error) }, message),
    child: (context) => wrap(instance.child(context)),
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const usePretty = options.pretty ?? process.env.NODE_ENV === 'development';

  const pinoOptions: LoggerOptions = {
    name: options.name,
    level: options.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    base: { service: options.name },
    redact: { paths: [...REDACTED_PATHS], censor: REDACTION_PLACEHOLDER, remove: false },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (usePretty) {
    return wrap(
      pino({
        ...pinoOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }),
    );
  }

  return wrap(pino(pinoOptions));
}

/** Creates a new correlation identifier. */
export function createCorrelationId(): string {
  return randomUUID();
}
