import { isImageReference, isSandboxProfile, type SandboxProfile } from './policy';

/**
 * The wire between the worker and the broker, over a Unix socket.
 *
 * Client to broker: one line of JSON (the request), then frames carrying what
 * the container reads on stdin, closed by an end-of-input frame. The end of
 * stdin is a frame rather than a half-close on purpose: a half-close looks
 * exactly like a client that went away, and a client that went away has to
 * stop its container. So any end of the connection before the exit frame is a
 * cancel.
 *
 * Broker to client: frames as well. stdout and stderr travel as their own
 * types so the two streams stay apart; the last frame is the exit, after which
 * the broker ends the connection.
 *
 * A frame is one type byte, a four-byte big-endian length and the payload.
 */

export interface SandboxRequest {
  profile: SandboxProfile;
  image: string;
  /** Run as `sh -c <script>` inside the container. */
  script: string;
}

export interface SandboxExit {
  /** The container's exit code, or `null` when it never produced one. */
  exitCode: number | null;
  /**
   * Set when the broker refused or could not start anything: a malformed
   * request, too many builds at once, a missing `docker`. The reason is also
   * on the stderr stream, so it lands in the build log.
   */
  refused?: string;
}

export const FRAME_STDOUT = 1;
export const FRAME_STDERR = 2;
export const FRAME_EXIT = 3;
export const FRAME_STDIN = 4;
export const FRAME_STDIN_END = 5;

export type FrameType =
  | typeof FRAME_STDOUT
  | typeof FRAME_STDERR
  | typeof FRAME_EXIT
  | typeof FRAME_STDIN
  | typeof FRAME_STDIN_END;

/** The request line may not exceed this. The scripts are a few hundred bytes. */
export const MAX_REQUEST_LINE_BYTES = 64 * 1024;

export function encodeFrame(type: FrameType, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * The largest frame either side sends. A writer splits anything longer; a
 * reader refuses it, so a forged length cannot make the broker buffer without
 * end.
 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Encodes a payload of any size as as many frames as it takes. */
export function encodeFrames(type: FrameType, payload: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += MAX_FRAME_BYTES) {
    frames.push(encodeFrame(type, payload.subarray(offset, offset + MAX_FRAME_BYTES)));
  }
  return frames;
}

/** Splits a byte stream back into frames, however the chunks were cut. */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): { type: number; payload: Buffer }[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: { type: number; payload: Buffer }[] = [];
    while (this.pending.length >= 5) {
      const length = this.pending.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) throw new Error('frame too large');
      if (this.pending.length < 5 + length) break;
      frames.push({
        type: this.pending.readUInt8(0),
        payload: this.pending.subarray(5, 5 + length),
      });
      this.pending = this.pending.subarray(5 + length);
    }
    return frames;
  }
}

/** Reads the request line, refusing anything that is not exactly a request. */
export function parseRequest(line: string): SandboxRequest | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { error: 'request is not JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'request is not an object' };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (keys.join(',') !== 'image,profile,script') {
    return { error: 'request has unexpected fields' };
  }
  if (!isSandboxProfile(record.profile)) return { error: 'unknown profile' };
  if (!isImageReference(record.image)) return { error: 'invalid image reference' };
  if (typeof record.script !== 'string' || record.script.length === 0) {
    return { error: 'script missing' };
  }
  return { profile: record.profile, image: record.image, script: record.script };
}
