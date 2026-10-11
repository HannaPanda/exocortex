import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Broker, createBroker, spawnSandboxed } from '@exocortex/sandbox';

import { runProjectBuild } from './project/latexmk-runner';
import { runLatexPdf } from './render/latex-runner';

/**
 * Issues #180 and #183 against the real image: the container the broker
 * starts can write nowhere but `/tmp`, and both build paths still produce a
 * PDF through the broker -- biber included, which is the one that needs
 * `exec` on the scratch mount. The broker runs in this process on a socket of
 * its own, the way `exocortex-sandbox.service` runs it on a deployment.
 *
 * Needs Docker and a LaTeX image already on this machine. A pull is 1.7 GB, so
 * a host without one skips rather than fetching it.
 */
const IMAGE = ['exocortex-render:latest', 'pandoc/extra:latest'].find(
  (image) => spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0,
);

const BUILD_TIMEOUT_MS = 180_000;

describe.skipIf(IMAGE === undefined)('the LaTeX sandbox (issue #180)', () => {
  const image = IMAGE ?? '';
  let dir = '';
  let socketPath = '';
  let broker: Broker | null = null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'exocortex-sandbox-it-'));
    socketPath = join(dir, 'broker.sock');
    const started = createBroker({ log: () => {} });
    broker = started;
    await new Promise<void>((resolve) => started.server.listen(socketPath, resolve));
  });

  afterAll(async () => {
    const started = broker;
    if (started !== null) {
      started.stopAll();
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs as nobody, offline, and cannot write outside /tmp', async () => {
    const probe = [
      'id -u',
      'for p in /etc /usr /root /opt /; do touch "$p/x" 2>/dev/null && echo "wrote $p"; done',
      'touch /tmp/x && echo tmp-ok',
      `[ "$(awk '/^CapEff/ {print $2}' /proc/self/status)" = 0000000000000000 ] && echo no-caps`,
      'ls /sys/class/net | grep -qv "^lo$" || echo no-net',
    ].join('\n');
    const stdout = await new Promise<string>((resolve) => {
      const child = spawnSandboxed(socketPath, { profile: 'render', image, script: probe });
      const out: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.on('close', () => resolve(Buffer.concat(out).toString('utf8')));
      child.stdin.end();
    });
    expect(stdout.split('\n').filter(Boolean)).toEqual(['65534', 'tmp-ok', 'no-caps', 'no-net']);
  }, 60_000);

  it(
    'still renders Markdown to a PDF',
    async () => {
      const result = await runLatexPdf({
        image,
        socketPath,
        markdown: '# Probe\n\nText mit $x^2$.\n',
        metadataYaml: 'title: Probe\n',
        template: null,
        assets: [],
        tableOfContents: false,
        timeoutMs: BUILD_TIMEOUT_MS,
        maxArtifactBytes: 50_000_000,
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.pdf?.subarray(0, 5).toString()).toBe('%PDF-');
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'still builds a project with biber',
    async () => {
      const tex = [
        '\\documentclass{article}',
        '\\usepackage[backend=biber]{biblatex}',
        '\\addbibresource{refs.bib}',
        '\\begin{document}',
        'Probe \\cite{knuth}.',
        '\\printbibliography',
        '\\end{document}',
      ].join('\n');
      const bib = '@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}}';
      const result = await runProjectBuild({
        image,
        socketPath,
        files: [
          { path: 'main.tex', content: Buffer.from(tex) },
          { path: 'refs.bib', content: Buffer.from(bib) },
        ],
        rootFile: 'main.tex',
        engine: 'LUALATEX',
        bibliography: 'BIBER',
        timeoutMs: BUILD_TIMEOUT_MS,
        maxArtifactBytes: 100_000_000,
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.pdf?.subarray(0, 5).toString()).toBe('%PDF-');
      expect(result.sourceMap).not.toBeNull();
    },
    BUILD_TIMEOUT_MS,
  );
});
