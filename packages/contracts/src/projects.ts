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

/**
 * How many uncompressed bytes an archive may carry, in either direction.
 *
 * The import's guard against a zip bomb and the export's ceiling at once, and
 * deliberately the same number: an archive this deployment refuses to read is
 * one it must not write either, or a project could be exported and then not
 * imported back. Checked against the sizes in the central directory *before*
 * anything is inflated, because a limit enforced on the output of the inflate
 * is a limit enforced after the memory is already gone.
 */
export const PROJECT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** How much of a build log is kept on the row. */
export const PROJECT_MAX_LOG_CHARS = 200_000;

/** How many parsed diagnostics are kept. A run with more has one real cause. */
export const PROJECT_MAX_DIAGNOSTICS = 500;

/**
 * How many rectangles one forward lookup answers with.
 *
 * A source line that runs across three pages is a real thing, and so is a macro
 * whose every use carries the line it was defined on. The cap is what keeps the
 * second case from answering with the whole document.
 */
export const PROJECT_MAX_SOURCE_AREAS = 64;

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
// oxlint-disable-next-line no-control-regex -- refusing them is the point
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

/**
 * What is wrong with a path, in English, for an API error message. The
 * sentence a person reads is `projects.newFile.pathProblems` in the message
 * catalogue, keyed by the same problem.
 */
export function projectPathProblemMessage(problem: ProjectPathProblem): string {
  switch (problem) {
    case 'empty':
      return 'The path is empty.';
    case 'too_long':
      return `The path is longer than ${String(PROJECT_MAX_PATH_CHARS)} characters.`;
    case 'absolute':
      return 'The path must not start with a slash.';
    case 'traversal':
      return 'The path must not lead out of the project.';
    case 'trailing_slash':
      return 'The path must not end with a slash.';
    case 'empty_segment':
      return 'The path contains an empty segment.';
    case 'invalid_character':
      return 'The path contains a character that is not allowed.';
    case 'reserved_name':
      return 'This name is reserved for the build.';
  }
}

export const projectPathSchema = z.string().refine((value) => checkProjectPath(value) === null, {
  message: 'Invalid project path',
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
// Archives
// ---------------------------------------------------------------------------

/**
 * Why one entry of an imported archive did not become a file (issue #54).
 *
 * Reported per path rather than counted, and that is the point of the list: an
 * import that swallows half an archive in silence is worse than one that
 * refuses, because the failure only surfaces at the build, in a file nobody
 * remembers was supposed to be there.
 */
export type ProjectImportSkipReason =
  | 'invalid_path'
  | 'ignored'
  | 'exists'
  | 'too_large'
  | 'not_utf8'
  | 'too_many_files'
  | 'encrypted'
  | 'unsupported_method'
  | 'corrupt'
  | 'upload_failed';

/** German for why one entry was left out. */
export function projectImportSkipMessage(reason: ProjectImportSkipReason): string {
  switch (reason) {
    case 'invalid_path':
      return 'Der Pfad ist im Projekt nicht erlaubt.';
    case 'ignored':
      return 'Eine Hilfsdatei des Betriebssystems, die im Projekt nichts zu suchen hat.';
    case 'exists':
      return 'An dieser Stelle liegt schon eine Datei; mit overwrite wird sie ersetzt.';
    case 'too_large':
      return 'Die Datei ist größer, als dieses Projekt erlaubt.';
    case 'not_utf8':
      return 'Die Datei sieht wie Text aus, ist aber nicht UTF-8 kodiert.';
    case 'too_many_files':
      return 'Das Projekt hat die erlaubte Anzahl Dateien erreicht.';
    case 'encrypted':
      return 'Der Eintrag im Archiv ist verschlüsselt.';
    case 'unsupported_method':
      return 'Der Eintrag ist mit einem Verfahren gepackt, das hier nicht gelesen wird.';
    case 'corrupt':
      return 'Der Eintrag im Archiv ließ sich nicht entpacken.';
    case 'upload_failed':
      return 'Die Datei konnte nicht als Anhang gespeichert werden.';
  }
}

export const projectImportSkipSchema = z.object({
  /** The path as the archive spelled it, before any rewriting. */
  name: z.string(),
  reason: z.enum([
    'invalid_path',
    'ignored',
    'exists',
    'too_large',
    'not_utf8',
    'too_many_files',
    'encrypted',
    'unsupported_method',
    'corrupt',
    'upload_failed',
  ]),
});
export type ProjectImportSkip = z.infer<typeof projectImportSkipSchema>;

/**
 * Reading a `.zip` into a project.
 *
 * The bytes arrive as an ordinary attachment, exactly as `addProjectAsset` has
 * them arrive: the upload route owns the magic-byte sniff, the size limit and
 * the permission check, and a second upload path here would be a second place
 * all three could be got wrong. It also means an agent names a file it already
 * put in the workspace instead of pushing megabytes through a tool call.
 */
export const importProjectRequestSchema = z.object({
  attachmentId: idSchema,
  /**
   * Replace files that are already in the project.
   *
   * Off by default, because the common mistake is importing into the wrong
   * project, and a default that overwrites turns that mistake into lost work.
   * What was skipped for this reason is in the response, so the caller can ask
   * again with the flag set rather than guess.
   */
  overwrite: z.boolean().default(false),
  /**
   * Drop a single shared top-level folder.
   *
   * Nearly every archive of a thesis carries one, and importing it keeps every
   * path one level deeper than the `\input` lines inside the sources expect.
   * Only applied when *every* entry is under the same folder, so it can never
   * silently merge two trees.
   */
  stripCommonRoot: z.boolean().default(true),
});
export type ImportProjectRequest = z.infer<typeof importProjectRequestSchema>;

export const importProjectResponseSchema = z.object({
  projectId: idSchema,
  /** The project-relative paths that now exist, sorted. */
  imported: z.array(z.string()),
  skipped: z.array(projectImportSkipSchema),
  /** The folder that was dropped from every path, when one was. */
  strippedRoot: z.string().nullable(),
  /**
   * The project's root file after the import.
   *
   * Set when the import chose one: an archive whose main file is not called
   * `main.tex` would otherwise land in a project pointing at a file that is not
   * there, and the first build would fail on a cause nobody can see.
   */
  rootFile: z.string(),
  rootFileChanged: z.boolean(),
  appliedLive: z.boolean(),
});
export type ImportProjectResponse = z.infer<typeof importProjectResponseSchema>;

/**
 * What an export produced.
 *
 * An ordinary `Attachment`, for the same reason a rendered PDF is one
 * (ADR-026): it is downloadable, deletable and listable with everything else,
 * and all three clients reach it the same way instead of the browser getting a
 * stream and an agent getting nothing.
 */
export const exportProjectResponseSchema = z.object({
  projectId: idSchema,
  attachmentId: idSchema,
  filename: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** How many paths went in. Build artifacts are not among them. */
  fileCount: z.number().int().nonnegative(),
  downloadPath: z.string(),
  /**
   * True when the archive was written from a projection that is behind the
   * last edit. The export is still the whole project, just possibly a second
   * old; saying so beats pretending the two can never differ.
   */
  stale: z.boolean(),
});
export type ExportProjectResponse = z.infer<typeof exportProjectResponseSchema>;

/**
 * Which file an imported project should be built from.
 *
 * The one place in this file that reads a source rather than a path, and it is
 * still keyed by `ProjectType` rather than assuming: an archive is the only
 * moment the system has files but no one to ask, and guessing wrong costs a
 * build, while not guessing costs a build *and* a puzzle.
 */
export function detectProjectRootFile(
  type: ProjectType,
  files: readonly { path: string; content: string }[],
): string | null {
  if (type !== 'LATEX') return null;
  const candidates = files.filter(
    (file) => file.path.toLowerCase().endsWith('.tex') && file.content.includes('\\documentclass'),
  );
  if (candidates.length === 0) return null;
  // Shallowest first, then shortest, then alphabetical: a thesis keeps its main
  // file at the top and its chapters below, and `main.tex` beats `main-alt.tex`.
  const depth = (path: string): number => path.split('/').length;
  candidates.sort(
    (a, b) =>
      depth(a.path) - depth(b.path) ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return candidates[0]?.path ?? null;
}

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
  /** `errorCode` as a sentence in the requester's language (ADR-062). Null while nothing failed. */
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

/**
 * One rectangle on one page, in PDF points measured from its top left corner.
 *
 * PDF points rather than pixels or scaled points, because that is the one
 * system every caller already holds: pdf.js hands out a viewport in exactly
 * these units, and "what is at 100,200 on page 3" means the same thing to a
 * person, a browser and an agent. Inside the SyncTeX map they are scaled points
 * measured from a point one inch above and to the left of the paper, which is
 * TeX's origin and nobody else's.
 */
export const projectSourceAreaSchema = z.object({
  page: z.number().int().positive(),
  left: z.number(),
  top: z.number(),
  /** Zero when the map knew a baseline but no extent. */
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type ProjectSourceArea = z.infer<typeof projectSourceAreaSchema>;

/**
 * Which source line produced a place in the PDF (issue #53, ADR-027).
 *
 * `file` is null when the line came from outside the project -- a class file, a
 * package, TeX Live's own sources. That is not an error and the answer is still
 * worth having: `inputPath` names it, and knowing that a stretch of the page
 * came from `article.cls` is what stops somebody looking for it in their own
 * files.
 */
export const projectSourceLookupResponseSchema = z.object({
  buildId: idSchema,
  /** Project-relative path, when the map named one that maps back to the tree. */
  file: z.string().nullable(),
  /** The path exactly as TeX wrote it. Absolute, and inside the build container. */
  inputPath: z.string(),
  line: z.number().int().positive(),
  /** What was found at that point, so a caller can show what it answered about. */
  area: projectSourceAreaSchema.nullable(),
});
export type ProjectSourceLookupResponse = z.infer<typeof projectSourceLookupResponseSchema>;

/**
 * Where a source line ended up in the PDF (issue #53, ADR-027).
 *
 * `line` is what was found rather than what was asked for. A line that prints
 * nothing -- a comment, a `\usepackage`, a blank -- has no place of its own, so
 * the search falls forward to the next line that does, and a caller that draws
 * the answer should say which line it is drawing.
 */
export const projectPositionLookupResponseSchema = z.object({
  buildId: idSchema,
  file: z.string(),
  requestedLine: z.number().int().positive(),
  /** The line that actually produced the areas. Equal to the request, or after it. */
  line: z.number().int().positive(),
  areas: z.array(projectSourceAreaSchema),
});
export type ProjectPositionLookupResponse = z.infer<typeof projectPositionLookupResponseSchema>;

export const deleteProjectBuildResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteProjectBuildResponse = z.infer<typeof deleteProjectBuildResponseSchema>;

/**
 * The failure codes the build worker writes into `project_build.errorCode`,
 * and `unknown` for anything it may write later. Each has a sentence under
 * `projects.buildErrors` in the message catalogue, for the same reason as
 * `renderErrorKeys` (issue #98, ADR-062).
 */
export const projectBuildErrorKeys = [
  'builder_unavailable',
  'build_failed',
  'build_timeout',
  'artifact_too_large',
  'empty_artifact',
  'root_file_missing',
  'project_empty',
  'project_missing',
  'project_not_materialized',
  'worker_lost',
  'unknown',
] as const;
export type ProjectBuildErrorKey = (typeof projectBuildErrorKeys)[number];

const PROJECT_BUILD_ERROR_KEYS: ReadonlySet<string> = new Set(projectBuildErrorKeys);

/** The catalogue key for a stored error code, or null when nothing failed. */
export function projectBuildErrorKey(code: string | null): ProjectBuildErrorKey | null {
  if (code === null) return null;
  return PROJECT_BUILD_ERROR_KEYS.has(code) ? (code as ProjectBuildErrorKey) : 'unknown';
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
