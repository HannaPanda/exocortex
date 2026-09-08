'use client';

import { logConnection } from './connection-log';
import { publicEnv, realtimeOrigin } from './env';

/**
 * A live channel taken apart, by hand, at the moment it is broken.
 *
 * Both channels sit behind a library -- Socket.IO on one side, Hocuspocus on
 * the other -- and both libraries swallow a failed connection into a retry loop
 * that reports nothing. When a tab is stuck, the first question is not "what
 * does the library think" but "can this browser open a WebSocket to this host
 * at all", and nothing in the application could answer it.
 *
 * This opens the two sockets directly, with no library, no ticket and no
 * session, and writes down what happens. The three outcomes tell three
 * different stories:
 *
 *  - The socket opens: the transport is fine and the fault is above it, in the
 *    library or in our own reconnect logic.
 *  - The socket closes with code 1006 and no HTTP status: something between the
 *    browser and nginx refused it -- a proxy, an extension, tracking
 *    protection, or a connection limit.
 *  - `new WebSocket()` throws outright: the browser refused before any network
 *    traffic, which is a policy decision on the client and nothing else.
 *
 * Reached from the console as `window.exocortex.probe()`.
 */

/** A socket that has not opened within this is treated as stuck, not as slow. */
const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeStep {
  label: string;
  url: string;
  /** `open` means the handshake completed; everything else is a failure mode. */
  outcome: 'open' | 'closed' | 'error' | 'timeout' | 'threw';
  /** Milliseconds from the attempt to the outcome. */
  elapsedMs: number;
  /** WebSocket close code, when the socket got far enough to have one. */
  code?: number;
  reason?: string;
  message?: string;
}

export interface ProbeReport {
  at: string;
  online: boolean;
  visibility: string;
  userAgent: string;
  steps: ProbeStep[];
}

/** `https://host` -> `wss://host`, leaving an already-ws URL alone. */
function toWebSocketUrl(origin: string, path: string): string {
  return `${origin.replace(/^http/, 'ws')}${path}`;
}

/**
 * Opens one socket and reports how it ended, whichever way that was.
 *
 * Resolves exactly once: the handlers race, and the first to arrive wins. The
 * socket is always closed afterwards, including on the timeout path, so a probe
 * run leaves nothing behind that could count against the browser's per-host
 * connection limit.
 */
function probeSocket(label: string, url: string): Promise<ProbeStep> {
  return new Promise((resolve) => {
    const started = Date.now();
    const elapsed = (): number => Date.now() - started;
    let settled = false;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return resolve({ label, url, outcome: 'threw', elapsedMs: elapsed(), message });
    }

    const finish = (step: Omit<ProbeStep, 'label' | 'url' | 'elapsedMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: ProbeStep = { label, url, elapsedMs: elapsed(), ...step };
      logConnection('probe', `probe.${label}.${step.outcome}`, {
        ms: result.elapsedMs,
        code: step.code ?? null,
        reason: step.reason ?? null,
        message: step.message ?? null,
      });
      try {
        socket.close();
      } catch {
        // Closing a socket that never opened is not interesting.
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ outcome: 'timeout', code: socket.readyState }),
      PROBE_TIMEOUT_MS,
    );

    socket.onopen = () => finish({ outcome: 'open' });
    socket.onerror = () => finish({ outcome: 'error' });
    socket.onclose = (event) =>
      finish({ outcome: 'closed', code: event.code, reason: event.reason });
  });
}

/**
 * The plain HTTPS request, so a dead socket can be told from a dead host.
 *
 * `/health/live` without the `/api` prefix: nginx gives liveness a location of
 * its own and passes the path through untouched, so `/api/health/live` reaches
 * the API as `/api/health/live` and answers 404.
 */
async function probeHttp(): Promise<ProbeStep> {
  const url = `${realtimeOrigin()}/health/live`;
  const started = Date.now();
  try {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
    const step: ProbeStep = {
      label: 'https',
      url,
      outcome: response.ok ? 'open' : 'closed',
      elapsedMs: Date.now() - started,
      code: response.status,
    };
    logConnection('probe', `probe.https.${step.outcome}`, {
      ms: step.elapsedMs,
      status: step.code ?? null,
    });
    return step;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logConnection('probe', 'probe.https.error', { ms: Date.now() - started, message });
    return { label: 'https', url, outcome: 'error', elapsedMs: Date.now() - started, message };
  }
}

/**
 * Runs the three checks in order and returns the report.
 *
 * In order rather than at once on purpose: three sockets opening in the same
 * millisecond would themselves be a plausible cause of a refusal, and a probe
 * must not be able to produce the fault it is looking for.
 */
export async function probeConnections(): Promise<ProbeReport> {
  logConnection('probe', 'probe.start');
  const steps: ProbeStep[] = [await probeHttp()];
  steps.push(
    await probeSocket(
      'realtime',
      toWebSocketUrl(realtimeOrigin(), '/realtime/?EIO=4&transport=websocket'),
    ),
  );
  steps.push(await probeSocket('collab', publicEnv.PUBLIC_COLLABORATION_URL));
  logConnection('probe', 'probe.done', {
    outcomes: steps.map((step) => `${step.label}:${step.outcome}`).join(','),
  });
  return {
    at: new Date().toISOString(),
    online: navigator.onLine,
    visibility: document.visibilityState,
    userAgent: navigator.userAgent,
    steps,
  };
}

/** The report as text, in the same shape as the connection log's dump. */
export function formatProbeReport(report: ProbeReport): string {
  const lines = [
    `probe ${report.at}`,
    `online=${report.online} visibility=${report.visibility}`,
    ...report.steps.map(
      (step) =>
        `  ${step.label.padEnd(9)} ${step.outcome.padEnd(8)} ${String(step.elapsedMs).padStart(5)}ms` +
        `${step.code === undefined ? '' : ` code=${step.code}`}` +
        `${step.reason ? ` reason=${step.reason}` : ''}` +
        `${step.message ? ` message=${step.message}` : ''}`,
    ),
  ];
  return lines.join('\n');
}
