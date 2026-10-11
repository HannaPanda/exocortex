import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { PassThrough, type Readable, type Writable } from 'node:stream';

import {
  encodeFrame,
  encodeFrames,
  FRAME_EXIT,
  FRAME_STDERR,
  FRAME_STDIN,
  FRAME_STDIN_END,
  FRAME_STDOUT,
  FrameDecoder,
  type SandboxExit,
  type SandboxRequest,
} from './protocol';

/** Where the broker listens on a deployment (`exocortex-sandbox.socket`). */
export const DEFAULT_SANDBOX_SOCKET = '/run/exocortex-sandbox/broker.sock';

/**
 * One build running behind the broker, shaped like the child process it
 * replaces: `stdin`, `stdout`, `stderr`, `kill()`, and `close` with the exit
 * code. `error` carries an `ENOENT`-coded error when the broker could not be
 * reached or could not reach Docker, which is what a missing `docker` binary
 * used to say.
 */
export interface SandboxProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** Ends the build. The broker kills the container when the connection drops. */
  kill(): void;
  on(event: 'close', listener: (exitCode: number | null) => void): this;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
}

function unavailable(message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = 'ENOENT';
  return error;
}

export function spawnSandboxed(socketPath: string, request: SandboxRequest): SandboxProcess {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const socket = connect({ path: socketPath });
  const decoder = new FrameDecoder();
  let exit: SandboxExit | null = null;
  let closed = false;

  const close = (exitCode: number | null): void => {
    if (closed) return;
    closed = true;
    stdout.end();
    stderr.end();
    emitter.emit('close', exitCode);
  };

  socket.write(`${JSON.stringify(request)}\n`);
  stdin.on('data', (chunk: Buffer) => {
    let flushed = true;
    for (const frame of encodeFrames(FRAME_STDIN, chunk)) flushed = socket.write(frame);
    if (!flushed) {
      stdin.pause();
      socket.once('drain', () => stdin.resume());
    }
  });
  stdin.on('end', () => {
    if (!socket.destroyed) socket.write(encodeFrame(FRAME_STDIN_END, Buffer.alloc(0)));
  });

  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type === FRAME_STDOUT) stdout.write(frame.payload);
      else if (frame.type === FRAME_STDERR) stderr.write(frame.payload);
      else if (frame.type === FRAME_EXIT) {
        exit = JSON.parse(frame.payload.toString('utf8')) as SandboxExit;
      }
    }
  });

  socket.on('error', (error: NodeJS.ErrnoException) => {
    if (closed || exit !== null) return;
    // A missing socket or a refused connection means there is no broker, the
    // same outcome as a host without Docker: the renderer is unavailable.
    if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EACCES') {
      emitter.emit(
        'error',
        unavailable(`sandbox broker unreachable at ${socketPath}: ${error.code}`),
      );
    } else {
      emitter.emit('error', error);
    }
    close(null);
  });

  socket.on('close', () => {
    if (exit?.refused !== undefined && exit.refused === 'docker unavailable') {
      emitter.emit('error', unavailable(exit.refused));
    }
    close(exit?.exitCode ?? null);
  });

  return Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      socket.destroy();
    },
  }) as SandboxProcess;
}
