/**
 * Newline-delimited JSON-RPC 2.0 over stdio.
 *
 * Reads line-delimited JSON from stdin (MCP's stdio transport) and writes one
 * JSON object per line to stdout. stdout is reserved exclusively for protocol
 * traffic: `console.log` is shadowed at startup (see `main.ts`) so a stray log
 * line can never corrupt the stream. This is one of the two Hermes rules that
 * are absolute: only JSON-RPC messages ever reach stdout, and an error
 * response always carries the request's own `id` whenever that id could be
 * determined at all.
 */

import {
  JSON_RPC_ERROR_CODES,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@exocortex/mcp-tools';

export type {
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from '@exocortex/mcp-tools';

/**
 * Everything that may travel from server to client: an answer, or a
 * server-initiated notification (`notifications/resources/updated`). Both are
 * one JSON object on one line; the transport does not care which it is.
 */
export type OutgoingMessage = JsonRpcResponse | JsonRpcNotification;

const {
  parseError: PARSE_ERROR,
  invalidRequest: INVALID_REQUEST,
  internalError: INTERNAL_ERROR,
} = JSON_RPC_ERROR_CODES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extracts a usable JSON-RPC id from an otherwise-unvalidated parsed value. */
function extractId(value: unknown): JsonRpcId {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null;
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function isValidRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && typeof value.method === 'string';
}

export function writeMessage(message: OutgoingMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * A minimal subset of `NodeJS.ReadableStream`/exit hook, injectable so
 * `stdio.test.ts` can drive the server with a fake stream instead of the
 * process's real stdin (which is a shared, global, hard-to-isolate resource
 * in a test process). `main.ts` calls `createStdioServer(handler)` with no
 * second argument, which defaults to the real `process.stdin`/`process.exit`.
 */
export interface StdioIo {
  input: {
    setEncoding(encoding: 'utf8'): void;
    on(event: 'data', listener: (chunk: string) => void): void;
    on(event: 'end', listener: () => void): void;
  };
  write: (message: OutgoingMessage) => void;
  onEnd: () => void;
}

const DEFAULT_IO: StdioIo = {
  input: process.stdin,
  write: writeMessage,
  onEnd: () => process.exit(0),
};

/**
 * Builds the stdio server. `handler` returns `null` for notifications (no
 * `id`), which get no response at all — writing nothing is itself the
 * correct behaviour, not an omission.
 */
export function createStdioServer(
  handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>,
  io: StdioIo = DEFAULT_IO,
): { start: () => void; notify: (message: JsonRpcNotification) => void } {
  let buffer = '';
  let inFlight = 0;
  let ended = false;

  /**
   * Hermes closes stdin to signal shutdown, and the process must then exit.
   * But a `tools/call` in flight is usually a real network request to the
   * API, which does not resolve synchronously — exiting the moment `end`
   * fires would kill that request mid-flight and silently drop its response.
   * `onEnd` therefore only actually fires once every in-flight line has
   * finished writing its response.
   */
  function maybeExit(): void {
    if (ended && inFlight === 0) {
      io.onEnd();
    }
  }

  async function handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      io.write(errorResponse(null, PARSE_ERROR, 'Parse error'));
      return;
    }

    if (!isValidRequest(parsed)) {
      io.write(errorResponse(extractId(parsed), INVALID_REQUEST, 'Invalid Request'));
      return;
    }

    try {
      const response = await handler(parsed);
      if (response !== null) {
        io.write(response);
      }
    } catch (error) {
      const id = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
      io.write(
        errorResponse(id, INTERNAL_ERROR, 'Internal error', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return {
    start(): void {
      io.input.setEncoding('utf8');
      io.input.on('data', (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          inFlight += 1;
          void handleLine(line).finally(() => {
            inFlight -= 1;
            maybeExit();
          });
          newlineIndex = buffer.indexOf('\n');
        }
      });
      io.input.on('end', () => {
        ended = true;
        maybeExit();
      });
    },

    /**
     * Writes a server-initiated message. The one caller is the change feed,
     * and it goes through the same `io.write` as every answer so that stdout
     * has exactly one writer -- two writers and a notification could land in
     * the middle of a response line.
     */
    notify(message: JsonRpcNotification): void {
      io.write(message);
    },
  };
}
