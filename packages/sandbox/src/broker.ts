import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import { dockerRunArguments, SANDBOX_PROFILES } from './policy';
import {
  encodeFrame,
  FRAME_EXIT,
  FRAME_STDERR,
  FRAME_STDIN,
  FRAME_STDIN_END,
  FRAME_STDOUT,
  FrameDecoder,
  MAX_REQUEST_LINE_BYTES,
  parseRequest,
  type SandboxExit,
  type SandboxRequest,
} from './protocol';

/**
 * The broker: the one process on this host that may talk to Docker on
 * eXocortex's behalf (issue #183).
 *
 * Reaching the Docker socket is root on the host, so the worker no longer
 * does: its unit hides the socket, and a build is a request to this process
 * instead. What a request can say is a profile, an image and a script; the
 * flags come from `policy.ts`, so there is no request that yields a
 * privileged container, a bind mount or a network. The broker itself runs as
 * its own system user from a root-owned copy outside the repository, because
 * the repository is writable by the very process it is protecting against.
 */

export interface BrokerOptions {
  /** The `docker` binary. Tests point it at a stand-in. */
  docker?: string;
  /** Runs at once before a request is refused. */
  maxRunning?: number;
  /** Seconds; overrides the profile's ceiling. Tests only. */
  maxSecondsOverride?: number;
  log?: (entry: Record<string, unknown>) => void;
}

/** Two queues at concurrency 1 each, with room for a run still being killed. */
const DEFAULT_MAX_RUNNING = 4;

/**
 * The CLI's default config path is the service user's home, which does not
 * exist. Pointing it at a path that does not exist either keeps it silent, and
 * there is no registry to log in to.
 */
const DOCKER_CONFIG_DIR = '/nonexistent/exocortex-docker';

export interface Broker {
  server: Server;
  /** Kills every container still running, for a clean shutdown. */
  stopAll(): void;
}

export function createBroker(options: BrokerOptions = {}): Broker {
  const docker = options.docker ?? 'docker';
  const maxRunning = options.maxRunning ?? DEFAULT_MAX_RUNNING;
  const log = options.log ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  let running = 0;
  const active = new Set<(why: string) => void>();

  const serve = (socket: Socket): void => {
    let head = Buffer.alloc(0);
    let started = false;

    const refuse = (reason: string): void => {
      log({ event: 'sandbox.refused', reason });
      socket.write(encodeFrame(FRAME_STDERR, Buffer.from(`sandbox broker: ${reason}\n`, 'utf8')));
      const exit: SandboxExit = { exitCode: null, refused: reason };
      socket.end(encodeFrame(FRAME_EXIT, Buffer.from(JSON.stringify(exit), 'utf8')));
    };

    const onHead = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const newline = head.indexOf(0x0a);
      if (newline === -1) {
        if (head.length > MAX_REQUEST_LINE_BYTES) {
          socket.off('data', onHead);
          refuse('request line too long');
        }
        return;
      }
      socket.off('data', onHead);
      started = true;
      const request = parseRequest(head.subarray(0, newline).toString('utf8'));
      if ('error' in request) {
        refuse(request.error);
        return;
      }
      if (running >= maxRunning) {
        refuse('too many builds at once');
        return;
      }
      run(socket, request, head.subarray(newline + 1));
    };

    socket.on('data', onHead);
    socket.on('end', () => {
      if (!started) refuse('connection ended before a request');
    });
    socket.on('error', () => {
      // A client that vanished; `close` below is what matters.
    });
  };

  const run = (socket: Socket, request: SandboxRequest, firstInput: Buffer): void => {
    running += 1;
    const name = `exocortex-sandbox-${randomUUID()}`;
    const startedAt = Date.now();
    let finished = false;
    let reason: string | null = null;

    const child: ChildProcessWithoutNullStreams = spawn(
      docker,
      dockerRunArguments({ name, ...request }),
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DOCKER_CONFIG: DOCKER_CONFIG_DIR },
      },
    );

    const stop = (why: string): void => {
      if (finished || reason !== null) return;
      reason = why;
      // Killing the CLI leaves the container running; the daemon has to be told.
      spawn(docker, ['kill', name], {
        stdio: 'ignore',
        env: { ...process.env, DOCKER_CONFIG: DOCKER_CONFIG_DIR },
      }).on('error', () => {});
      child.kill('SIGKILL');
    };

    active.add(stop);

    const seconds = options.maxSecondsOverride ?? SANDBOX_PROFILES[request.profile].maxSeconds;
    const timer = setTimeout(() => {
      stop('time limit');
    }, seconds * 1_000);

    const forward = (type: typeof FRAME_STDOUT | typeof FRAME_STDERR) => (chunk: Buffer) => {
      if (socket.destroyed) return;
      if (!socket.write(encodeFrame(type, chunk))) {
        child.stdout.pause();
        child.stderr.pause();
        socket.once('drain', () => {
          child.stdout.resume();
          child.stderr.resume();
        });
      }
    };
    child.stdout.on('data', forward(FRAME_STDOUT));
    child.stderr.on('data', forward(FRAME_STDERR));

    child.stdin.on('error', () => {
      // The container exited before reading all of its input; its exit code
      // and stderr say why.
    });
    const input = new FrameDecoder();
    const onInput = (chunk: Buffer): void => {
      let frames: { type: number; payload: Buffer }[];
      try {
        frames = input.push(chunk);
      } catch {
        stop('malformed input');
        return;
      }
      for (const frame of frames) {
        if (frame.type === FRAME_STDIN) {
          if (!child.stdin.write(frame.payload)) {
            socket.pause();
            child.stdin.once('drain', () => socket.resume());
          }
        } else if (frame.type === FRAME_STDIN_END) {
          child.stdin.end();
        } else {
          stop('malformed input');
          return;
        }
      }
    };
    socket.on('data', onInput);
    if (firstInput.length > 0) onInput(firstInput);
    // The end of stdin is a frame, so any end of the connection before the
    // exit is a client that gave up -- a cancel, a timeout, a dead worker.
    socket.on('end', () => {
      stop('client disconnected');
    });
    socket.on('close', () => {
      stop('client disconnected');
    });

    let spawnError: string | null = null;
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error.code === 'ENOENT' ? 'docker unavailable' : error.message;
    });

    child.on('close', (code) => {
      finished = true;
      running -= 1;
      active.delete(stop);
      clearTimeout(timer);
      log({
        event: 'sandbox.run',
        profile: request.profile,
        image: request.image,
        exitCode: code,
        stopped: reason,
        durationMs: Date.now() - startedAt,
      });
      if (socket.destroyed) return;
      if (reason !== null) {
        socket.write(encodeFrame(FRAME_STDERR, Buffer.from(`sandbox broker: ${reason}\n`, 'utf8')));
      }
      if (spawnError !== null) {
        socket.write(encodeFrame(FRAME_STDERR, Buffer.from(`${spawnError}\n`, 'utf8')));
      }
      const exit: SandboxExit =
        spawnError === null ? { exitCode: code } : { exitCode: null, refused: spawnError };
      socket.end(encodeFrame(FRAME_EXIT, Buffer.from(JSON.stringify(exit), 'utf8')));
    });
  };

  return {
    server: createServer(serve),
    stopAll: () => {
      for (const stop of active) stop('broker shutting down');
    },
  };
}
