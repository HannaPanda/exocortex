import { spawn } from 'node:child_process';

import { createTar, type TarEntry } from '../tar';

/**
 * The one place a LaTeX build happens (issue #44, ADR-026).
 *
 * Pandoc, TeX Live and the fonts live in a container image; nothing is
 * installed on the host and nothing about the pipeline is reimplemented here.
 * The contract with the container is deliberately tiny:
 *
 *     stdin  -> a tar archive with input.md, metadata.yaml, an optional
 *               template.tex and an assets/ directory
 *     stdout -> the finished PDF, raw
 *     stderr -> everything a human or an agent needs to read when it failed
 *
 * That shape is what keeps the runner free of bind mounts. A mounted directory
 * would have to exist at the same path for this process and for the Docker
 * daemon, which under systemd's `PrivateTmp` it does not, and the failure would
 * be an empty directory rather than an error.
 *
 * The container gets no network (`--network none`): a build reads what it was
 * handed and nothing else, so a template cannot become a way to fetch a URL
 * from inside this deployment.
 */

export interface LatexRunRequest {
  /** Container image, e.g. `pandoc/extra:latest`. */
  image: string;
  /** The document, as Markdown. */
  markdown: string;
  /** YAML handed to Pandoc as `--metadata-file`. */
  metadataYaml: string;
  /** The Pandoc template, or null for the image's built-in Eisvogel. */
  template: string | null;
  /** Files referenced from the Markdown as `assets/<name>`. */
  assets: readonly { name: string; bytes: Uint8Array }[];
  /** Adds a table of contents. Used for a subtree, where chapters exist. */
  tableOfContents: boolean;
  timeoutMs: number;
  /** Kills the container when the job is cancelled. */
  signal?: AbortSignal;
  /** Refuses an output larger than this rather than buffering it. */
  maxArtifactBytes: number;
}

export interface LatexRunResult {
  /** The PDF, or null when the build produced none. */
  pdf: Buffer | null;
  /** stderr of the whole pipeline, capped. */
  log: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the output grew past `maxArtifactBytes`. */
  tooLarge: boolean;
  /** Set when Docker itself could not be reached or the image is missing. */
  unavailable: boolean;
}

/** See the `env` note in `runLatexPdf`. Deliberately a path with nothing in it. */
const DOCKER_CONFIG_DIR = '/nonexistent/exocortex-docker';

/** Log kept from one build. A TeX log is long and the interesting part is the end. */
const MAX_LOG_BYTES = 200_000;

/**
 * The script that runs inside the container.
 *
 * `1>&2` on the Pandoc call is load-bearing: stdout is reserved for the PDF, so
 * anything Pandoc says about its work has to be moved out of the way before the
 * file is written to it.
 */
function containerScript(options: { template: string | null; tableOfContents: boolean }): string {
  const template = options.template === null ? 'eisvogel' : 'template.tex';
  const toc = options.tableOfContents ? ' --toc --toc-depth=3' : '';
  return [
    'set -e',
    'mkdir -p /tmp/build && cd /tmp/build',
    'tar xf -',
    `pandoc input.md --from=gfm+tex_math_dollars --metadata-file=metadata.yaml --template=${template} --pdf-engine=xelatex --resource-path=.:assets${toc} --output=output.pdf 1>&2`,
    'cat output.pdf',
  ].join('\n');
}

export function buildRunArguments(request: LatexRunRequest): string[] {
  return [
    'run',
    '--rm',
    '--interactive',
    // No network, no extra privileges, a bounded amount of memory and processes:
    // a LaTeX document is a program, and this one runs somebody's template.
    '--network=none',
    '--security-opt=no-new-privileges',
    '--memory=2g',
    '--pids-limit=512',
    '--entrypoint=sh',
    request.image,
    '-c',
    containerScript({
      template: request.template,
      tableOfContents: request.tableOfContents,
    }),
  ];
}

export function buildInputArchive(request: LatexRunRequest): Buffer {
  const entries: TarEntry[] = [
    { name: 'input.md', content: Buffer.from(request.markdown, 'utf8') },
    { name: 'metadata.yaml', content: Buffer.from(request.metadataYaml, 'utf8') },
  ];
  if (request.template !== null) {
    entries.push({ name: 'template.tex', content: Buffer.from(request.template, 'utf8') });
  }
  for (const asset of request.assets) {
    entries.push({ name: `assets/${asset.name}`, content: asset.bytes });
  }
  return createTar(entries);
}

/**
 * Runs one build and waits for it.
 *
 * Every way this can end badly is a returned value rather than a thrown error:
 * a template that does not compile, a build that never finishes, an image that
 * is not on this machine and a cancel from a person are all ordinary outcomes
 * of asking for a PDF, and every one of them has to reach the job row with its
 * log attached. The processor decides what that means; this function only
 * reports what happened.
 */
export async function runLatexPdf(request: LatexRunRequest): Promise<LatexRunResult> {
  const child = spawn('docker', buildRunArguments(request), {
    stdio: ['pipe', 'pipe', 'pipe'],
    // The unit runs with `ProtectHome`, so the CLI's default config path is
    // unreadable and it says so on stderr -- in the build log, above whatever
    // LaTeX actually complained about. Pointing it at a path that simply does
    // not exist is silent, and there is no registry to log in to anyway.
    env: { ...process.env, DOCKER_CONFIG: DOCKER_CONFIG_DIR },
  });

  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let tooLarge = false;
  let timedOut = false;
  let cancelled = false;
  let unavailable = false;

  const kill = (): void => {
    child.kill('SIGKILL');
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, request.timeoutMs);

  const onAbort = (): void => {
    cancelled = true;
    kill();
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > request.maxArtifactBytes) {
      tooLarge = true;
      kill();
      return;
    }
    stdout.push(chunk);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= MAX_LOG_BYTES) return;
    stderrBytes += chunk.length;
    stderr.push(chunk);
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', (error: NodeJS.ErrnoException) => {
      // `docker` itself is missing from the host. Everything else -- a missing
      // image, a daemon that refuses -- comes back as a non-zero exit code with
      // an explanation on stderr.
      if (error.code === 'ENOENT') unavailable = true;
      stderr.push(Buffer.from(`\n${error.message}\n`, 'utf8'));
      resolve(null);
    });
    child.on('close', (code) => {
      resolve(code);
    });

    const archive = buildInputArchive(request);
    child.stdin.on('error', () => {
      // The container died before it read its input; the exit code and stderr
      // below say why, and an EPIPE here would say nothing useful.
    });
    child.stdin.end(archive);
  });

  clearTimeout(timer);
  request.signal?.removeEventListener('abort', onAbort);

  const log = Buffer.concat(stderr).toString('utf8').slice(-MAX_LOG_BYTES);
  const pdf = tooLarge || exitCode !== 0 ? null : Buffer.concat(stdout);

  return {
    pdf: pdf !== null && pdf.length > 0 ? pdf : null,
    log,
    exitCode,
    timedOut,
    cancelled,
    tooLarge,
    unavailable: unavailable || /Unable to find image|no such image/i.test(log),
  };
}
