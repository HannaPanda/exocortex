import {
  mcpChangeFeedReadySchema,
  type McpResourceChange,
  mcpResourceChangeSchema,
} from '@exocortex/contracts';

/**
 * The stdio transport's ear (issue #48, ADR-035).
 *
 * A subprocess has a permanent connection to its client and none at all to the
 * deployment: every tool call is a fresh HTTP request, so between two calls
 * this process learns nothing. `resources/subscribe` promises the opposite, so
 * the bin opens one long-lived stream of its own, `GET /api/mcp/changes`, and
 * turns what arrives there into `notifications/resources/updated` on stdout.
 *
 * Three properties matter more than the parsing:
 *
 *  * **It starts only when something is subscribed.** A client that never
 *    subscribes never opens a second connection, which is most of them.
 *  * **It reconnects, and it gives up loudly rather than quietly.** A feed
 *    that died and stayed dead would leave the promise broken with no symptom
 *    at all; every attempt is logged to the diagnostics log.
 *  * **A silent socket counts as a dead one.** The server sends a heartbeat on
 *    a known interval, so a stream that says nothing for several of them is a
 *    connection that is being held open by something in between, not a quiet
 *    workspace.
 */

export interface ChangeFeedLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface ChangeFeedOptions {
  baseUrl: string;
  token: string;
  /** Extra headers, e.g. HTTP basic auth in front of a remote deployment. */
  headers?: Readonly<Record<string, string>>;
  logger: ChangeFeedLogger;
  /** Called with the changed resource URIs, in the order the server sent them. */
  onChange: (uris: readonly string[]) => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

export interface ChangeFeed {
  /** Opens the stream if it is not open yet. Safe to call on every subscribe. */
  ensureStarted(): void;
  /** Closes it and stops reconnecting. */
  stop(): void;
}

/** First retry delay; doubles up to the cap below. */
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/** How many missed heartbeats count as a dead connection. */
const HEARTBEAT_TOLERANCE = 3;

/** Used until the server's `ready` message says otherwise. */
const ASSUMED_HEARTBEAT_SECONDS = 30;

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // `unref`, so a pending backoff never keeps the process alive after the
    // client closed stdin: the exit path in `stdio.ts` waits for in-flight
    // requests, and a reconnect timer is not one.
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

export function createChangeFeed(options: ChangeFeedOptions): ChangeFeed {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delay = options.delay ?? defaultDelay;
  const url = new URL('/api/mcp/changes', options.baseUrl).toString();

  let running = false;
  let controller: AbortController | null = null;

  /** One connection attempt. Returns when the stream ended, however it ended. */
  async function consume(): Promise<void> {
    const attempt = new AbortController();
    controller = attempt;
    let watchdog: NodeJS.Timeout | null = null;
    let heartbeatSeconds = ASSUMED_HEARTBEAT_SECONDS;

    const armWatchdog = (): void => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(
        () => {
          options.logger.warn('MCP change feed went silent, reconnecting', { heartbeatSeconds });
          attempt.abort();
        },
        heartbeatSeconds * HEARTBEAT_TOLERANCE * 1000,
      );
      watchdog.unref();
    };

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${options.token}`,
          ...options.headers,
        },
        signal: attempt.signal,
      });

      if (!response.ok || response.body === null) {
        options.logger.warn('MCP change feed was refused', { status: response.status });
        return;
      }

      armWatchdog();
      // Re-armed on every frame, including the heartbeat comments, which carry
      // no payload and never reach the loop below. Arming only on a payload
      // would declare a quiet workspace dead every three heartbeats.
      for await (const payload of readEvents(response.body, armWatchdog)) {
        const ready = mcpChangeFeedReadySchema.safeParse(payload);
        if (ready.success) {
          heartbeatSeconds = ready.data.heartbeatSeconds;
          options.logger.info('MCP change feed open', { heartbeatSeconds });
          continue;
        }
        const change: { success: true; data: McpResourceChange } | { success: false } =
          mcpResourceChangeSchema.safeParse(payload);
        if (change.success) {
          options.onChange(change.data.uris);
        }
      }
    } catch (error) {
      if (!attempt.signal.aborted || running) {
        options.logger.warn('MCP change feed failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (watchdog !== null) clearTimeout(watchdog);
      if (controller === attempt) controller = null;
    }
  }

  async function loop(): Promise<void> {
    let backoff = INITIAL_BACKOFF_MS;
    while (running) {
      const openedAt = Date.now();
      await consume();
      if (!running) break;
      // A connection that lasted a while was healthy; only a stream that dies
      // immediately is worth backing away from. Otherwise a deployment
      // restart every few hours would slowly push the delay to a minute.
      backoff = Date.now() - openedAt > MAX_BACKOFF_MS ? INITIAL_BACKOFF_MS : backoff;
      await delay(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  return {
    ensureStarted(): void {
      if (running) return;
      running = true;
      void loop();
    },
    stop(): void {
      running = false;
      controller?.abort();
    },
  };
}

/**
 * Server-sent events, reduced to what this feed uses: `data:` lines joined per
 * event, parsed as JSON. Comment lines (the heartbeat) yield nothing and still
 * report activity, because arriving at all is their whole job.
 */
async function* readEvents(
  body: ReadableStream<Uint8Array>,
  onFrame: () => void,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  // An explicit reader rather than `for await`: a web stream is only
  // asynchronously iterable on recent runtimes, and `getReader` is the one
  // spelling that works on all of them.
  const reader = body.getReader();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      onFrame();
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
      if (data.length > 0) {
        try {
          yield JSON.parse(data);
        } catch {
          // A frame this server did not write. Ignored rather than fatal: one
          // unreadable message must not close a stream that is otherwise fine.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
