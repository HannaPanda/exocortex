import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Broker, createBroker } from './broker';
import { spawnSandboxed } from './client';
import { dockerRunArguments, isImageReference } from './policy';
import { FRAME_EXIT, FrameDecoder, parseRequest, type SandboxExit } from './protocol';

/**
 * Issue #183: the broker decides every flag, and a request can say nothing
 * else. Docker itself is replaced by a shell script that reports what it was
 * asked to do, so this runs anywhere; `container-sandbox.integration.test.ts`
 * in the worker runs the same path against the real daemon.
 */

describe('the container policy', () => {
  it('puts the image after every flag and never mounts, publishes or privileges', () => {
    const args = dockerRunArguments({
      name: 'n',
      profile: 'render',
      image: 'pandoc/extra:latest',
      script: 'true',
    });
    const imageAt = args.indexOf('pandoc/extra:latest');
    expect(args.slice(imageAt)).toEqual(['pandoc/extra:latest', '-c', 'true']);
    const flags = args.slice(0, imageAt);
    expect(flags).toEqual(
      expect.arrayContaining([
        '--network=none',
        '--cap-drop=ALL',
        '--read-only',
        '--user=65534:65534',
        '--pull=never',
        '--security-opt=no-new-privileges',
      ]),
    );
    expect(flags.join(' ')).not.toMatch(
      /--privileged|--volume|-v |--mount|--publish|--cap-add|unconfined/,
    );
  });

  it('accepts image references and refuses anything that parses as a flag', () => {
    for (const ok of [
      'pandoc/extra:latest',
      'exocortex-render:latest',
      'registry.example.org:5000/team/tex:2026.1',
      `ghcr.io/a/b@sha256:${'a'.repeat(64)}`,
    ]) {
      expect(isImageReference(ok), ok).toBe(true);
    }
    for (const bad of ['--privileged', '-v', ' pandoc', 'pandoc extra', 'a\nb', '', 42]) {
      expect(isImageReference(bad), String(bad)).toBe(false);
    }
  });

  it('refuses a request with anything beyond profile, image and script', () => {
    expect(parseRequest('{"profile":"render","image":"x","script":"true"}')).toEqual({
      profile: 'render',
      image: 'x',
      script: 'true',
    });
    expect(
      parseRequest('{"profile":"render","image":"x","script":"true","mounts":["/:/host"]}'),
    ).toEqual({ error: 'request has unexpected fields' });
    expect(parseRequest('{"profile":"root","image":"x","script":"true"}')).toEqual({
      error: 'unknown profile',
    });
    expect(parseRequest('{"profile":"render","image":"--privileged","script":"true"}')).toEqual({
      error: 'invalid image reference',
    });
  });
});

describe('the broker', () => {
  let dir: string;
  let socketPath: string;
  let broker: Broker;
  const killLog = (): string => join(dir, 'killed');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'exocortex-sandbox-'));
    socketPath = join(dir, 'broker.sock');
    const fakeDocker = join(dir, 'docker');
    writeFileSync(
      fakeDocker,
      [
        '#!/bin/sh',
        `if [ "$1" = kill ]; then echo "$2" >> '${killLog()}'; exit 0; fi`,
        // Every argument on stderr, one per line, so the test can read them back.
        'printf "%s\\n" "$@" >&2',
        'case "$*" in *"sleep-forever"*) exec sleep 30 ;; esac',
        'cat',
        'exit 7',
      ].join('\n'),
    );
    chmodSync(fakeDocker, 0o755);
    broker = createBroker({ docker: fakeDocker, log: () => {} });
    await new Promise<void>((resolve) => broker.server.listen(socketPath, resolve));
  });

  afterAll(async () => {
    broker.stopAll();
    await new Promise<void>((resolve) => broker.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const collect = (
    script: string,
    input: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
    new Promise((resolve) => {
      const child = spawnSandboxed(socketPath, { profile: 'project', image: 'img:1', script });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('close', (exitCode) => {
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          exitCode,
        });
      });
      child.stdin.end(input);
    });

  it('runs the policy, streams stdin through and reports the exit code', async () => {
    const result = await collect('echo hi', 'tar bytes');
    expect(result.stdout).toBe('tar bytes');
    expect(result.exitCode).toBe(7);
    const args = result.stderr.split('\n');
    expect(args).toEqual(expect.arrayContaining(['--network=none', '--memory=3g', 'img:1']));
  });

  it('kills the container when the client goes away', async () => {
    const child = spawnSandboxed(socketPath, {
      profile: 'render',
      image: 'img:1',
      script: 'sleep-forever',
    });
    child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.kill();
    await closed;
    for (let attempt = 0; attempt < 50 && !existsSync(killLog()); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(readFileSync(killLog(), 'utf8')).toMatch(/^exocortex-sandbox-/);
  });

  it('answers a forged request with a refusal and starts nothing', async () => {
    const reply = await new Promise<SandboxExit>((resolve) => {
      const socket = connect(socketPath);
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.type === FRAME_EXIT) {
            resolve(JSON.parse(frame.payload.toString('utf8')) as SandboxExit);
          }
        }
      });
      socket.end(
        `${JSON.stringify({ profile: 'render', image: 'img:1', script: 'x', privileged: true })}\n`,
      );
    });
    expect(reply).toEqual({ exitCode: null, refused: 'request has unexpected fields' });
  });

  it('reports an unreachable broker the way a missing docker binary was reported', async () => {
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const child = spawnSandboxed(join(dir, 'nothing.sock'), {
        profile: 'render',
        image: 'img:1',
        script: 'true',
      });
      child.on('error', resolve);
      child.stdin.end();
    });
    expect(error.code).toBe('ENOENT');
  });
});
