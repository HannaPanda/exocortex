import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { sandboxArguments } from './container-sandbox';
import { runProjectBuild } from './project/latexmk-runner';
import { runLatexPdf } from './render/latex-runner';

/**
 * Issue #180 against the real image: the hardened container can write nowhere
 * but `/tmp`, and both build paths still produce a PDF inside it -- biber
 * included, which is the one that needs `exec` on the scratch mount.
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

  it('runs as nobody and cannot write outside /tmp', () => {
    const probe = [
      'id -u',
      'for p in /etc /usr /root /opt /; do touch "$p/x" 2>/dev/null && echo "wrote $p"; done',
      'touch /tmp/x && echo tmp-ok',
    ].join('\n');
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        ...sandboxArguments({ memory: '512m', scratch: '64m' }),
        '--entrypoint=sh',
        image,
        '-c',
        probe,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(result.stdout.split('\n').filter(Boolean)).toEqual(['65534', 'tmp-ok']);
  }, 60_000);

  it(
    'still renders Markdown to a PDF',
    async () => {
      const result = await runLatexPdf({
        image,
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
