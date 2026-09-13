import { PROJECT_MAX_DIAGNOSTICS, type ProjectDiagnostic } from '@exocortex/contracts';

/**
 * A TeX log turned into a list an agent can act on (issue #43, ADR-027).
 *
 * This is the part of the feature that decides whether the build-fix-build loop
 * works at all. A log is forty thousand lines of font warnings with three real
 * errors in it, and an agent handed the log has to find them by reading prose;
 * handed a list of `{file, line, message}` it can open the file and fix the
 * line. The log is still kept and still readable -- this is the index into it,
 * not a replacement for it.
 *
 * Only patterns that carry a location or a real complaint are matched. Nothing
 * is inferred: an error with no file in the log gets `file: null`, because
 * inventing one would send a repair to the wrong place, and a wrong location is
 * worse for a machine than none.
 */

/**
 * `-file-line-error` output: `./chapters/intro.tex:42: Undefined control sequence.`
 *
 * The flag is passed by the runner precisely so this line exists. Without it
 * LaTeX prints `! Undefined control sequence.` and the file two screens later.
 */
const FILE_LINE_ERROR = /^(.+?):(\d+): (.+)$/;

/** `! LaTeX Error: File 'foo.sty' not found.` and every other bare `!` line. */
const BARE_ERROR = /^! (.+)$/;

/** `LaTeX Warning: Reference 'fig:1' on page 3 undefined on input line 42.` */
const LATEX_WARNING = /^(?:LaTeX|Package|Class)\s*(?:\w+\s+)?Warning: (.+)$/;

/** `Overfull \hbox (12.3pt too wide) in paragraph at lines 41--43` */
const OVERFULL = /^(Overfull|Underfull) \\[hv]box \((.+?)\)(?: in paragraph)? at lines (\d+)/;

/** The trailing `on input line 42.` a warning often carries. */
const INPUT_LINE = /on input line (\d+)/;

/**
 * Lines nothing is gained by reporting.
 *
 * Font substitution notes are the bulk of a real log and are never actionable:
 * a document that renders correctly emits dozens of them, so surfacing them
 * would bury the three warnings that matter.
 */
const IGNORED = [
  /^LaTeX Font Warning:/,
  /^Package hyperref Warning: Token not allowed/,
  /^Package microtype Warning:/,
];

/** Strips the leading `./` TeX prints and rejects paths outside the project. */
function normalizePath(raw: string, known: ReadonlySet<string>): string | null {
  let path = raw.trim();
  while (path.startsWith('./')) path = path.slice(2);
  if (known.has(path)) return path;
  // TeX also names files from the distribution (`/usr/local/texlive/...`) and
  // the ones latexmk wrote into the output directory. Neither is a place
  // anybody can go and fix something, so they are reported without a file.
  return null;
}

/**
 * Parses one build log.
 *
 * `knownPaths` is what the project actually holds. It is what separates a
 * location somebody can act on from a path inside TeX Live, and it is why this
 * function takes the project rather than only the text.
 */
export function parseLatexLog(log: string, knownPaths: Iterable<string>): ProjectDiagnostic[] {
  const known = new Set(knownPaths);
  const diagnostics: ProjectDiagnostic[] = [];
  const seen = new Set<string>();

  const push = (diagnostic: ProjectDiagnostic): void => {
    if (diagnostics.length >= PROJECT_MAX_DIAGNOSTICS) return;
    // A multi-pass run repeats every warning once per pass. Reporting the same
    // file, line and message four times would make the panel useless.
    const key = `${diagnostic.severity}\u0000${diagnostic.file ?? ''}\u0000${String(diagnostic.line ?? 0)}\u0000${diagnostic.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  for (const raw of log.split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (IGNORED.some((pattern) => pattern.test(line))) continue;

    const fileLine = FILE_LINE_ERROR.exec(line);
    if (fileLine !== null) {
      const path = normalizePath(fileLine[1] as string, known);
      const number = Number.parseInt(fileLine[2] as string, 10);
      const message = (fileLine[3] as string).trim();
      // `-file-line-error` uses the same shape for warnings as for errors, so
      // the message decides which it is.
      const warning = /^(LaTeX|Package|Class)\b.*Warning/i.test(message);
      push({
        severity: warning ? 'WARNING' : 'ERROR',
        file: path,
        line: Number.isFinite(number) ? number : null,
        message,
      });
      continue;
    }

    const overfull = OVERFULL.exec(line);
    if (overfull !== null) {
      const number = Number.parseInt(overfull[3] as string, 10);
      push({
        severity: 'WARNING',
        file: null,
        line: Number.isFinite(number) ? number : null,
        message: `${overfull[1] as string} box (${overfull[2] as string})`,
      });
      continue;
    }

    const warning = LATEX_WARNING.exec(line);
    if (warning !== null) {
      const message = (warning[1] as string).trim();
      const at = INPUT_LINE.exec(message);
      push({
        severity: 'WARNING',
        file: null,
        line: at === null ? null : Number.parseInt(at[1] as string, 10),
        message,
      });
      continue;
    }

    const bare = BARE_ERROR.exec(line);
    if (bare !== null) {
      push({ severity: 'ERROR', file: null, line: null, message: (bare[1] as string).trim() });
    }
  }

  return diagnostics;
}
