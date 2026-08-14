import pino, { type Logger as PinoLogger } from 'pino';

import { type Logger, type LoggerContext } from '@exocortex/logger';

/**
 * `@exocortex/logger`'s `createLogger()` always targets `process.stdout`
 * (correct for every other process in this repo), which is exactly the one
 * stream this server must never write anything but JSON-RPC to (the Hermes
 * rule in `stdio.ts`). Rather than touch `packages/logger` to add a
 * destination option, this file re-implements the same thin pino adapter
 * shape, pointed at stderr (or `EXOCORTEX_LOG_FILE` when set) instead. `pino`
 * is already a transitive dependency of `@exocortex/logger`; declaring it
 * directly here is the explicit-dependency edge for that, not a new package.
 */
function normalizeError(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) {
    return { err: { type: error.name, message: error.message, stack: error.stack } };
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
    child: (context: LoggerContext) => wrap(instance.child(context)),
  };
}

/** Builds a `Logger` that never writes to stdout. */
export function createDiagnosticsLogger(options: { logFile?: string }): Logger {
  const destination =
    options.logFile !== undefined
      ? pino.destination({ dest: options.logFile, mkdir: true })
      : pino.destination(2);
  return wrap(
    pino(
      {
        name: 'exocortex-mcp',
        level: process.env.LOG_LEVEL ?? 'info',
        base: { service: 'exocortex-mcp' },
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      destination,
    ),
  );
}
