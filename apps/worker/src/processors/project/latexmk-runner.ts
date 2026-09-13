import { spawn } from 'node:child_process';

import { type ProjectBibliography, type ProjectEngine } from '@exocortex/contracts';

import { createTar, readTar, type TarEntry } from '../tar';

/**
 * The one place a project is compiled (issue #43, ADR-027).
 *
 * The mechanics are ADR-026's, because ADR-026 already worked them out: TeX Live
 * lives in a container image, nothing is installed on the host, the input is a
 * tar archive on stdin and there are no bind mounts -- a mounted directory would
 * have to exist at the same path for this process and for the Docker daemon,
 * which under the unit's `PrivateTmp` it does not, and the failure would be an
 * empty directory rather than an error.
 *
 * One thing differs. A render produces one file and writes it raw to stdout; a
 * project build produces several -- the PDF, the TeX log, the SyncTeX map --
 * so this container answers with a tar archive instead:
 *
 *     stdin  -> the project's files at their own paths
 *     stdout -> a tar archive: _exocortex.pdf, _exocortex.synctex.gz, build.log
 *     stderr -> what a person reads when Docker itself would not start
 *
 * `--network none` matters as much here as there, and more: a LaTeX document is
 * a program, and this one is somebody's whole project. It reads what it was
 * handed and can reach nothing else on this host. `-shell-escape` is never
 * passed, so TeX Live's restricted mode stands.
 */

export interface ProjectRunFile {
  /** Project-relative path, exactly as it appears in the tree. */
  path: string;
  content: Uint8Array;
}

export interface ProjectRunRequest {
  /** Container image, e.g. `pandoc/extra:latest`. */
  image: string;
  files: readonly ProjectRunFile[];
  rootFile: string;
  engine: ProjectEngine;
  bibliography: ProjectBibliography;
  timeoutMs: number;
  /** Kills the container when the build is cancelled. */
  signal?: AbortSignal;
  /** Refuses an archive larger than this rather than buffering it. */
  maxArtifactBytes: number;
}

export interface ProjectRunResult {
  /** The finished PDF, or null when the build produced none. */
  pdf: Buffer | null;
  /** The SyncTeX map, gzipped, or null when the engine wrote none. */
  sourceMap: Buffer | null;
  /** The TeX log and the console output, in that order. Capped. */
  log: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  tooLarge: boolean;
  /** Docker itself could not be reached, or the image is not on this machine. */
  unavailable: boolean;
}

/** See the `env` note in `runProjectBuild`. A path with nothing in it. */
const DOCKER_CONFIG_DIR = '/nonexistent/exocortex-docker';

/** Log kept from one build. A TeX log is long and the end is the interesting part. */
const MAX_LOG_BYTES = 400_000;

/** Where the build happens inside the container. */
const WORK_DIR = '/tmp/exocortex-build';

/** `latexmk`'s flag for each engine. */
const ENGINE_FLAG: Record<ProjectEngine, string> = {
  PDFLATEX: '-pdf',
  XELATEX: '-pdfxe',
  LUALATEX: '-pdflua',
};

/**
 * `latexmk`'s flag for each bibliography mode.
 *
 * `AUTO` passes nothing, which is latexmk's own behaviour: it runs BibTeX when
 * it finds a `.aux` asking for one and biber when it finds a `.bcf`, and that
 * decision is right nearly always. `BIBTEX` and `BIBER` both force a run --
 * latexmk still picks the right program from the file it finds, so what the two
 * values actually say is "do run one", which is the case AUTO gets wrong when a
 * first build has no `.aux` yet. `NONE` switches it off entirely.
 */
const BIBLIOGRAPHY_FLAG: Record<ProjectBibliography, string | null> = {
  AUTO: null,
  BIBTEX: '-bibtex',
  BIBER: '-bibtex',
  NONE: '-bibtex-',
};

/**
 * Quotes one argument for `sh -c`.
 *
 * The root file is a project path, so it is whatever somebody typed. Single
 * quotes with the embedded-quote escape are the only form that is safe for
 * every byte a path may hold.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The script that runs inside the container.
 *
 * `latexmk` is allowed to fail: a document with an error is the ordinary case,
 * and the log is exactly what the caller needs when it happens. So its status
 * is captured, the outputs are collected either way, and the script's own exit
 * code reports the compile -- with the archive already on stdout.
 */
export function containerScript(request: {
  rootFile: string;
  engine: ProjectEngine;
  bibliography: ProjectBibliography;
}): string {
  const bibliography = BIBLIOGRAPHY_FLAG[request.bibliography];
  const flags = [
    ENGINE_FLAG[request.engine],
    ...(bibliography === null ? [] : [bibliography]),
    '-interaction=nonstopmode',
    '-file-line-error',
    '-synctex=1',
    '-outdir=.exocortex-out',
  ].join(' ');

  return [
    `mkdir -p ${WORK_DIR} || exit 90`,
    `cd ${WORK_DIR} || exit 90`,
    'tar xf - || exit 91',
    'mkdir -p .exocortex-out || exit 90',
    'status=0',
    // The working directory is the project root, not the root file's folder, so
    // `\\input{chapters/intro}` resolves the way it does in the file tree.
    `latexmk ${flags} ${shellQuote(request.rootFile)} > .exocortex-out/console.txt 2>&1 || status=$?`,
    'cd .exocortex-out || exit 90',
    // The outputs are renamed to fixed names before they are packed, so the
    // archive never depends on a file name somebody chose: a root file with a
    // space in it would otherwise split into two arguments here.
    'for f in *.pdf; do [ -f "$f" ] && mv -- "$f" _exocortex.pdf && break; done',
    'for f in *.synctex.gz; do [ -f "$f" ] && mv -- "$f" _exocortex.synctex.gz && break; done',
    // The TeX log first, latexmk's own output after: the first says what LaTeX
    // objected to, the second whether latexmk got that far at all.
    '{ cat -- *.log 2>/dev/null; echo; echo "--- latexmk ---"; cat -- console.txt; } > _log',
    'mv -- _log build.log',
    // Only these three leave the container, so nothing else the build wrote
    // travels with them.
    'tar cf - $(ls _exocortex.pdf _exocortex.synctex.gz build.log 2>/dev/null)',
    'exit $status',
  ].join('\n');
}

export function buildRunArguments(request: ProjectRunRequest): string[] {
  return [
    'run',
    '--rm',
    '--interactive',
    // A LaTeX project is a program somebody in the workspace wrote. It gets no
    // network, no way to gain privileges, and bounded memory and processes.
    '--network=none',
    '--security-opt=no-new-privileges',
    '--memory=3g',
    '--pids-limit=512',
    '--entrypoint=sh',
    request.image,
    '-c',
    containerScript({
      rootFile: request.rootFile,
      engine: request.engine,
      bibliography: request.bibliography,
    }),
  ];
}

export function buildInputArchive(request: ProjectRunRequest): Buffer {
  const entries: TarEntry[] = request.files.map((file) => ({
    name: file.path,
    content: file.content,
  }));
  return createTar(entries);
}

/**
 * Runs one build and waits for it.
 *
 * Every way this ends badly is a returned value, never a thrown error: a
 * document that does not compile, a build that never finishes, an image that is
 * not on this machine and a cancel from a person are all ordinary outcomes of
 * asking for a PDF, and every one of them has to reach the build row with its
 * log attached. The processor decides what each one means; this only reports.
 */
export async function runProjectBuild(request: ProjectRunRequest): Promise<ProjectRunResult> {
  const child = spawn('docker', buildRunArguments(request), {
    stdio: ['pipe', 'pipe', 'pipe'],
    // The unit runs with `ProtectHome`, so the Docker CLI's default config path
    // is unreadable and it says so on stderr -- above whatever LaTeX actually
    // complained about. Pointing it at a path that does not exist is silent,
    // and there is no registry to log in to anyway.
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
      // `docker` is missing from the host. Everything else -- a missing image, a
      // daemon that refuses -- arrives as a non-zero exit code with stderr.
      if (error.code === 'ENOENT') unavailable = true;
      stderr.push(Buffer.from(`\n${error.message}\n`, 'utf8'));
      resolve(null);
    });
    child.on('close', (code) => {
      resolve(code);
    });

    child.stdin.on('error', () => {
      // The container died before reading its input; the exit code and stderr
      // say why, and an EPIPE here would say nothing useful.
    });
    child.stdin.end(buildInputArchive(request));
  });

  clearTimeout(timer);
  request.signal?.removeEventListener('abort', onAbort);

  const consoleLog = Buffer.concat(stderr).toString('utf8');
  const entries = tooLarge ? [] : readTar(Buffer.concat(stdout));
  const find = (test: (name: string) => boolean): Buffer | null => {
    const entry = entries.find((candidate) => test(candidate.name));
    return entry === undefined ? null : Buffer.from(entry.content);
  };

  const texLog = find((name) => name === 'build.log')?.toString('utf8') ?? '';
  const pdf = find((name) => name === '_exocortex.pdf');

  return {
    pdf: pdf !== null && pdf.length > 0 ? pdf : null,
    sourceMap: find((name) => name === '_exocortex.synctex.gz'),
    log: [texLog, consoleLog]
      .filter((part) => part.length > 0)
      .join('\n')
      .slice(-MAX_LOG_BYTES),
    exitCode,
    timedOut,
    cancelled,
    tooLarge,
    unavailable: unavailable || /Unable to find image|no such image/i.test(consoleLog),
  };
}
