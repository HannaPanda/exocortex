import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * Project workspaces (issue #43, ADR-027).
 *
 * A project is a `Document` with `type: PROJECT` whose Yjs state holds a file
 * tree rather than prose, plus a sidecar row with what a page does not have: a
 * root file, an engine, a bibliography mode. LaTeX is the first `ProjectType`,
 * not the shape of the domain -- nothing here except `LATEX` itself and the
 * three engine names knows what a `.tex` file is.
 *
 * The file tree is canonical in Yjs; `ProjectFile` rows are the projection the
 * materialization job rebuilds from it (ADR-007). Binary files are ordinary
 * attachments and only their path is in the tree.
 */

export const projectTypeSchema = z.enum(['LATEX']);
export type ProjectType = z.infer<typeof projectTypeSchema>;

/** Which TeX binary `latexmk` drives. */
export const projectEngineSchema = z.enum(['PDFLATEX', 'XELATEX', 'LUALATEX']);
export type ProjectEngine = z.infer<typeof projectEngineSchema>;

/**
 * How the bibliography is produced.
 *
 * `AUTO` lets `latexmk` decide from what the document loads, which is right
 * nearly always. The other three exist because when it is wrong, the failure is
 * a silently missing bibliography rather than an error.
 */
export const projectBibliographySchema = z.enum(['AUTO', 'BIBTEX', 'BIBER', 'NONE']);
export type ProjectBibliography = z.infer<typeof projectBibliographySchema>;

/**
 * What kind of thing sits at a path.
 *
 * The difference is where the bytes live: a `TEXT` file's source is in the
 * project's Yjs state and several people can type in it at once, an `ASSET`'s
 * bytes are an attachment in object storage and the tree holds only a
 * reference. There is no third kind and a directory is not one: a directory is
 * the prefix of the paths under it.
 */
export const projectFileKindSchema = z.enum(['TEXT', 'ASSET']);
export type ProjectFileKind = z.infer<typeof projectFileKindSchema>;

export const projectBuildStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type ProjectBuildStatus = z.infer<typeof projectBuildStatusSchema>;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Longest path in a project, counted in characters. */
export const PROJECT_MAX_PATH_CHARS = 400;

/** Longest single text file. A chapter, not a database dump. */
export const PROJECT_MAX_TEXT_CHARS = 2_000_000;

/** How many paths one project may hold, assets included. */
export const PROJECT_MAX_FILES = 500;

/** How much of a build log is kept on the row. */
export const PROJECT_MAX_LOG_CHARS = 200_000;

/** How many parsed diagnostics are kept. A run with more has one real cause. */
export const PROJECT_MAX_DIAGNOSTICS = 500;

/**
 * How long the build queue's lock is held, and how often a stall is looked for.
 *
 * Above the longest build `projects.timeoutSeconds` allows: BullMQ renews the
 * lock while a handler runs, but a lock shorter than the work turns a slow
 * build into a stalled one and hands it to a second worker while the first
 * still has a container open. Same reasoning as the render queue.
 */
export const PROJECT_BUILD_QUEUE_LOCK_DURATION_MS = 1_800_000;
export const PROJECT_BUILD_QUEUE_STALLED_INTERVAL_MS = 60_000;

/**
 * Extensions a build treats as text and therefore as collaboratively editable.
 *
 * Not a security boundary -- the API decides `kind` from what the caller asks
 * for and from the magic bytes of an upload. It is the default the UI and the
 * agent tools apply when somebody adds a file without saying which kind it is,
 * and the list a `.tex` project actually needs.
 */
export const PROJECT_TEXT_EXTENSIONS = [
  'tex',
  'sty',
  'cls',
  'bib',
  'bst',
  'bbx',
  'cbx',
  'lbx',
  'ltx',
  'def',
  'cfg',
  'clo',
  'txt',
  'md',
  'csv',
  'json',
  'yaml',
  'yml',
  'toml',
  'lua',
  'tikz',
  'pgf',
  'ins',
  'dtx',
  'gitignore',
  'latexmkrc',
] as const;

/**
 * Whether a path looks like a text file.
 *
 * Extension-driven, with two exceptions that carry none: `latexmkrc` and
 * `.latexmkrc` are how `latexmk` is configured, and a project that cannot edit
 * its own build configuration would need a setting for every knob instead.
 */
export function isProjectTextPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'latexmkrc' || name === '.latexmkrc') return true;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = name.slice(dot + 1);
  return (PROJECT_TEXT_EXTENSIONS as readonly string[]).includes(extension);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Why a path was refused, in a form the caller can act on.
 *
 * A returned reason rather than a thrown error: the same check runs in the
 * browser while somebody types a filename, in the API before a write and in
 * the tool layer before a tool call, and only the API turns it into a 4xx.
 */
export type ProjectPathProblem =
  | 'empty'
  | 'too_long'
  | 'absolute'
  | 'traversal'
  | 'trailing_slash'
  | 'empty_segment'
  | 'invalid_character'
  | 'reserved_name';

/**
 * Characters a path may not contain.
 *
 * Control characters and DEL because the archive is read by `tar` and the
 * script by `sh`; the backslash and the Windows-reserved punctuation because a
 * path that means one thing here and another on somebody's laptop is a path
 * that will be exported wrong exactly once.
 */
// eslint-disable-next-line no-control-regex -- refusing them is the point
const CONTROL_OR_RESERVED = /[\u0000-\u001f\u007f\\:*?"<>|]/;

/** Names the build directory owns. A project file may not shadow one. */
const RESERVED_PROJECT_NAMES = new Set(['.', '..', '.git', '.exocortex']);

/**
 * Checks one path, and says what is wrong with it rather than that something is.
 *
 * The rules are the ones a tar archive and a container working directory
 * require, not stylistic: no leading slash and no `..`, because a path is
 * resolved inside the build directory and must stay there; no backslash and no
 * control character, because the archive is read by `tar` and the script by
 * `sh`; no empty segment, because `a//b` and `a/b` would be two rows for one
 * file.
 */
export function checkProjectPath(path: string): ProjectPathProblem | null {
  if (path.length === 0) return 'empty';
  if (path.length > PROJECT_MAX_PATH_CHARS) return 'too_long';
  if (path.startsWith('/')) return 'absolute';
  if (path.endsWith('/')) return 'trailing_slash';
  if (CONTROL_OR_RESERVED.test(path)) return 'invalid_character';

  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return 'empty_segment';
    if (segment === '..' || segment === '.') return 'traversal';
    if (RESERVED_PROJECT_NAMES.has(segment.toLowerCase())) return 'reserved_name';
  }
  return null;
}

/** German for what is wrong with a path. */
export function projectPathProblemMessage(problem: ProjectPathProblem): string {
  switch (problem) {
    case 'empty':
      return 'Der Pfad ist leer.';
    case 'too_long':
      return `Der Pfad ist länger als ${String(PROJECT_MAX_PATH_CHARS)} Zeichen.`;
    case 'absolute':
      return 'Der Pfad darf nicht mit einem Schrägstrich beginnen.';
    case 'traversal':
      return 'Der Pfad darf nicht aus dem Projekt herausführen.';
    case 'trailing_slash':
      return 'Der Pfad darf nicht mit einem Schrägstrich enden.';
    case 'empty_segment':
      return 'Der Pfad enthält einen leeren Abschnitt.';
    case 'invalid_character':
      return 'Der Pfad enthält ein unzulässiges Zeichen.';
    case 'reserved_name':
      return 'Dieser Name ist für den Bau reserviert.';
  }
}

export const projectPathSchema = z.string().refine((value) => checkProjectPath(value) === null, {
  message: 'Ungültiger Pfad im Projekt',
});

/** The directory part of a path, or `''` for a file at the root. */
export function projectPathDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Rewrites a path when the directory it sits in is moved.
 *
 * Prefix substitution rather than string replacement: moving `chapters` must
 * move `chapters/intro.tex` and leave `chapters-old/intro.tex` alone, which a
 * `startsWith(from)` gets wrong and `startsWith(from + '/')` gets right.
 */
export function rewriteProjectPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return null;
}

// ---------------------------------------------------------------------------
// Reading a project
// ---------------------------------------------------------------------------

export const projectFileSchema = z.object({
  path: projectPathSchema,
  kind: projectFileKindSchema,
  /** UTF-8 length for a text file, the attachment's size for an asset. */
  byteSize: z.number().int().nonnegative(),
  /** Set for an asset. Null for a text file, and for an asset whose file was deleted. */
  attachmentId: idSchema.nullable(),
  /** Relative API path the bytes can be fetched from. Assets only. */
  downloadPath: z.string().nullable(),
  mimeType: z.string().nullable(),
  updatedAt: isoDateTimeSchema,
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

export const projectSchema = z.object({
  /** The project *is* a document; its id is the document's id. */
  id: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  type: projectTypeSchema,
  rootFile: z.string(),
  engine: projectEngineSchema,
  bibliography: projectBibliographySchema,
  fileCount: z.number().int().nonnegative(),
  assetCount: z.number().int().nonnegative(),
  /**
   * False until the materialization job has read the Yjs state at least once.
   * A project created through the API is materialized synchronously; one
   * created by typing in the browser is not, and the difference is visible
   * for a second or two.
   */
  materialized: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Project = z.infer<typeof projectSchema>;

export const projectResponseSchema = z.object({ project: projectSchema });
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const projectListResponseSchema = z.object({
  projects: z.array(projectSchema),
  /** Whether this workspace may build at all (`projects.enabled`). */
  buildEnabled: z.boolean(),
});
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const projectFileListResponseSchema = z.object({
  projectId: idSchema,
  files: z.array(projectFileSchema),
  /** True while the projection is older than the last edit. */
  stale: z.boolean(),
});
export type ProjectFileListResponse = z.infer<typeof projectFileListResponseSchema>;

export const projectFileContentResponseSchema = z.object({
  projectId: idSchema,
  path: projectPathSchema,
  kind: projectFileKindSchema,
  /** Null for an asset: its bytes come from the download path, not from JSON. */
  content: z.string().nullable(),
  byteSize: z.number().int().nonnegative(),
  /** True when only part of the file was returned. */
  truncated: z.boolean(),
  downloadPath: z.string().nullable(),
  updatedAt: isoDateTimeSchema,
});
export type ProjectFileContentResponse = z.infer<typeof projectFileContentResponseSchema>;

// ---------------------------------------------------------------------------
// Changing a project
// ---------------------------------------------------------------------------

export const createProjectRequestSchema = z.object({
  title: z.string().min(1).max(200),
  /** Where the project sits in the workspace tree. Null puts it at the root. */
  parentId: idSchema.nullable().default(null),
  type: projectTypeSchema.default('LATEX'),
  engine: projectEngineSchema.default('PDFLATEX'),
  bibliography: projectBibliographySchema.default('AUTO'),
  rootFile: projectPathSchema.default('main.tex'),
  /**
   * Whether the root file is created with a compilable skeleton.
   *
   * On by default because an empty project cannot be built and the first thing
   * anybody does is paste a preamble. Off for an import, which brings its own.
   */
  scaffold: z.boolean().default(true),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
/**
 * The same request before the defaults are filled in.
 *
 * A caller that only wants a title should not have to name an engine, and the
 * inferred *output* type has every default as a required field. The browser
 * sends this shape; the API validates into the one above.
 */
export type CreateProjectInput = z.input<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  rootFile: projectPathSchema.optional(),
  engine: projectEngineSchema.optional(),
  bibliography: projectBibliographySchema.optional(),
});
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const deleteProjectResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteProjectResponse = z.infer<typeof deleteProjectResponseSchema>;

export const writeProjectFileRequestSchema = z.object({
  path: projectPathSchema,
  content: z.string().max(PROJECT_MAX_TEXT_CHARS),
  /**
   * Refuse when the file already exists.
   *
   * The difference between "create" and "write" is one flag rather than two
   * routes, because the two differ in exactly this and an agent that has to
   * pick between two endpoints picks wrong when the file's existence is what it
   * was unsure about.
   */
  createOnly: z.boolean().default(false),
});
export type WriteProjectFileRequest = z.infer<typeof writeProjectFileRequestSchema>;

/**
 * An exact-text replacement inside one file.
 *
 * Deliberately not a diff format. A unified diff has to be applied against the
 * text the caller last saw, and in a collaborative document that text may have
 * moved; an anchored replacement either matches what is there now or refuses,
 * which is the failure an agent can recover from.
 */
export const patchProjectFileRequestSchema = z.object({
  path: projectPathSchema,
  /** Must occur exactly once, unless `replaceAll` is set. */
  oldText: z.string().min(1).max(PROJECT_MAX_TEXT_CHARS),
  newText: z.string().max(PROJECT_MAX_TEXT_CHARS),
  replaceAll: z.boolean().default(false),
});
export type PatchProjectFileRequest = z.infer<typeof patchProjectFileRequestSchema>;

export const moveProjectFileRequestSchema = z.object({
  from: projectPathSchema,
  to: projectPathSchema,
  /**
   * Move every path under `from` as well.
   *
   * What makes a directory rename possible without directories being rows: the
   * caller names the prefix and every path under it follows.
   */
  recursive: z.boolean().default(false),
});
export type MoveProjectFileRequest = z.infer<typeof moveProjectFileRequestSchema>;

export const deleteProjectFileRequestSchema = z.object({
  path: projectPathSchema,
  /** Delete every path under `path` as well. Required to remove a directory. */
  recursive: z.boolean().default(false),
});
export type DeleteProjectFileRequest = z.infer<typeof deleteProjectFileRequestSchema>;

/**
 * What a write actually did.
 *
 * `paths` rather than one path because a recursive move or delete touches many,
 * and a caller that has to guess which ones cannot report what it changed.
 */
export const projectMutationResponseSchema = z.object({
  projectId: idSchema,
  paths: z.array(projectPathSchema),
  /**
   * Whether the change reached an open editing session rather than only the
   * stored state (ADR-016). False simply means nobody had the project open.
   */
  appliedLive: z.boolean(),
});
export type ProjectMutationResponse = z.infer<typeof projectMutationResponseSchema>;

/**
 * Adding a binary file to the tree.
 *
 * The bytes are uploaded as an ordinary attachment first, so the magic-byte
 * sniff, the quota and the permission check are the ones the attachment module
 * already owns; this only binds the id to a path.
 */
export const addProjectAssetRequestSchema = z.object({
  path: projectPathSchema,
  attachmentId: idSchema,
});
export type AddProjectAssetRequest = z.infer<typeof addProjectAssetRequestSchema>;

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

export const projectDiagnosticSeveritySchema = z.enum(['ERROR', 'WARNING', 'INFO']);
export type ProjectDiagnosticSeverity = z.infer<typeof projectDiagnosticSeveritySchema>;

/**
 * One line of a TeX log, parsed.
 *
 * The list is what an agent acts on and what the error panel draws; the raw log
 * is what both fall back to. `file` and `line` are nullable because plenty of
 * real TeX errors carry neither, and inventing a location for them would send
 * a repair to the wrong place.
 */
export const projectDiagnosticSchema = z.object({
  severity: projectDiagnosticSeveritySchema,
  /** Project-relative path, when the log named one that maps back to the tree. */
  file: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  message: z.string(),
});
export type ProjectDiagnostic = z.infer<typeof projectDiagnosticSchema>;

export const projectBuildSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  projectId: idSchema.nullable(),
  projectTitle: z.string().nullable(),
  rootFile: z.string(),
  engine: projectEngineSchema,
  bibliography: projectBibliographySchema,
  status: projectBuildStatusSchema,
  inputHash: z.string(),
  /** True when the project has changed since this build. Computed on read. */
  stale: z.boolean(),
  errorCode: z.string().nullable(),
  /** German, user-facing. Null while nothing failed. */
  error: z.string().nullable(),
  /** Counts, so a caller can decide whether to fetch the list at all. */
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  attachmentId: idSchema.nullable(),
  attachmentByteSize: z.number().int().nonnegative().nullable(),
  /** Relative API path the finished PDF can be fetched from. */
  downloadPath: z.string().nullable(),
  sourceMapAttachmentId: idSchema.nullable(),
  pageCount: z.number().int().nonnegative().nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdById: idSchema.nullable(),
  createdByName: z.string().nullable(),
});
export type ProjectBuild = z.infer<typeof projectBuildSchema>;

export const startProjectBuildRequestSchema = z.object({
  /** Overrides the project's root file for this build only. */
  rootFile: projectPathSchema.optional(),
  engine: projectEngineSchema.optional(),
  bibliography: projectBibliographySchema.optional(),
  /**
   * Build even though an identical build already succeeded.
   *
   * The cache is the input hash, so asking twice for an unchanged project hands
   * back the first answer. This is the escape hatch for what the hash cannot
   * see: a changed container image.
   */
  force: z.boolean().default(false),
});
export type StartProjectBuildRequest = z.infer<typeof startProjectBuildRequestSchema>;

export const startProjectBuildResponseSchema = z.object({
  build: projectBuildSchema,
  /** True when this is an earlier build handed back instead of a new one. */
  reused: z.boolean(),
});
export type StartProjectBuildResponse = z.infer<typeof startProjectBuildResponseSchema>;

export const projectBuildResponseSchema = z.object({ build: projectBuildSchema });
export type ProjectBuildResponse = z.infer<typeof projectBuildResponseSchema>;

export const projectBuildListResponseSchema = z.object({ builds: z.array(projectBuildSchema) });
export type ProjectBuildListResponse = z.infer<typeof projectBuildListResponseSchema>;

export const projectBuildLogResponseSchema = z.object({
  buildId: idSchema,
  status: projectBuildStatusSchema,
  log: z.string(),
  truncated: z.boolean(),
});
export type ProjectBuildLogResponse = z.infer<typeof projectBuildLogResponseSchema>;

export const projectBuildDiagnosticsResponseSchema = z.object({
  buildId: idSchema,
  status: projectBuildStatusSchema,
  diagnostics: z.array(projectDiagnosticSchema),
  /** True when more diagnostics were produced than are kept. */
  truncated: z.boolean(),
});
export type ProjectBuildDiagnosticsResponse = z.infer<typeof projectBuildDiagnosticsResponseSchema>;

/**
 * What a finished build produced.
 *
 * The PDF and the SyncTeX map are both attachments, which is what makes them
 * inspectable by a machine: the PDF text extraction runs over the artifact, so
 * `exo_attachment_read_text` reads back what the build actually printed rather
 * than what the source said it would.
 */
export const projectBuildArtifactsResponseSchema = z.object({
  buildId: idSchema,
  status: projectBuildStatusSchema,
  stale: z.boolean(),
  pdf: z
    .object({
      attachmentId: idSchema,
      filename: z.string(),
      byteSize: z.number().int().nonnegative(),
      downloadPath: z.string(),
      pageCount: z.number().int().nonnegative().nullable(),
      textStatus: z.enum(['NOT_APPLICABLE', 'PENDING', 'READY', 'FAILED']),
    })
    .nullable(),
  sourceMap: z
    .object({
      attachmentId: idSchema,
      filename: z.string(),
      byteSize: z.number().int().nonnegative(),
      downloadPath: z.string(),
    })
    .nullable(),
});
export type ProjectBuildArtifactsResponse = z.infer<typeof projectBuildArtifactsResponseSchema>;

export const deleteProjectBuildResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteProjectBuildResponse = z.infer<typeof deleteProjectBuildResponseSchema>;

/**
 * German for what went wrong, from the English code the worker wrote.
 *
 * Here rather than in the worker for the same reason as `renderErrorMessage`:
 * the worker writes for a log, this writes for a person.
 */
export function projectBuildErrorMessage(code: string | null): string | null {
  switch (code) {
    case null:
      return null;
    case 'builder_unavailable':
      return 'Der LaTeX-Bau ist auf diesem Rechner nicht eingerichtet. Ein Administrator muss das Container-Abbild bereitstellen.';
    case 'build_failed':
      return 'Der Bau ist fehlgeschlagen. Die Fehlerliste sagt, in welcher Datei und Zeile.';
    case 'build_timeout':
      return 'Der Bau hat zu lange gedauert und wurde abgebrochen. Meist wartet LaTeX auf eine Eingabe.';
    case 'artifact_too_large':
      return 'Das erzeugte PDF ist größer als erlaubt.';
    case 'empty_artifact':
      return 'Der Bau lief durch, hat aber kein PDF abgeliefert.';
    case 'root_file_missing':
      return 'Die Hauptdatei gibt es im Projekt nicht.';
    case 'project_empty':
      return 'Das Projekt enthält noch keine Dateien.';
    case 'project_missing':
      return 'Das Projekt gibt es nicht mehr.';
    case 'project_not_materialized':
      return 'Das Projekt ist noch nicht aufbereitet. Einen Moment warten und erneut bauen.';
    case 'worker_lost':
      return 'Der Bau wurde abgebrochen, weil der Hintergrunddienst ihn verloren hat.';
    default:
      return 'Der Bau ist fehlgeschlagen.';
  }
}

/**
 * The skeleton a new LaTeX project starts from.
 *
 * Small on purpose: enough that the first build succeeds and shows a title, not
 * a house style somebody has to delete. German, because the visible text of
 * this deployment is German and this text is visible in the PDF.
 */
export function latexScaffold(title: string): string {
  const escaped = title.replace(/([\\{}$&#^_~%])/g, '\\$1');
  return [
    '\\documentclass[11pt,a4paper]{scrartcl}',
    '\\usepackage[ngerman]{babel}',
    '\\usepackage{graphicx}',
    '',
    `\\title{${escaped}}`,
    '\\author{}',
    '\\date{\\today}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '',
    '\\end{document}',
    '',
  ].join('\n');
}
