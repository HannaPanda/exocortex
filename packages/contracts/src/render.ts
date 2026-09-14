import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * Rendering: an existing page published as a PDF (issue #44, ADR-026).
 *
 * The layer is deliberately generic. A template names a renderer, a job names a
 * template and a source, and the artifact is an ordinary attachment. Nothing
 * here mentions LaTeX except the one renderer that currently exists, because
 * the second one (Typst, DOCX, EPUB) must not require the domain to be rebuilt.
 *
 * What this is *not*: a second canonical state. A PDF is derived from the
 * materialized Markdown of a page, the template and the resolved variables, and
 * may be thrown away and rebuilt at any time (ADR-007).
 */

/**
 * How a job turns a document into a file.
 *
 * `LATEX_PDF` is Pandoc into a LaTeX template into xelatex, all three inside
 * one container. eXocortex never translates Markdown to LaTeX itself.
 */
export const rendererSchema = z.enum(['LATEX_PDF']);
export type Renderer = z.infer<typeof rendererSchema>;

/**
 * What goes into one render.
 *
 * `DOCUMENT` is the page alone. `SUBTREE` is the page and its descendants in
 * tree order, each child a level deeper than its parent, which is how a project
 * with sub-pages becomes one PDF with chapters.
 *
 * A database query as a source is deliberately absent rather than declared and
 * refused: the shape below carries a `source` column so adding it later is a
 * new value, not a new model, but a value that every caller has to be told not
 * to use is worse than a value that is not there yet.
 */
export const renderSourceSchema = z.enum(['DOCUMENT', 'SUBTREE']);
export type RenderSource = z.infer<typeof renderSourceSchema>;

export const renderJobStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type RenderJobStatus = z.infer<typeof renderJobStatusSchema>;

/** Where the value of a template variable comes from when nobody types it. */
export const renderVariableOriginSchema = z.enum([
  /** Somebody fills it in before the build. */
  'MANUAL',
  /** The page title. */
  'TITLE',
  /** The page's path from the workspace root, joined with " / ". */
  'PATH',
  /** The display name of whoever started the render. */
  'AUTHOR',
  /** Today, as `YYYY-MM-DD`. */
  'TODAY',
  /** A database property of the page, named by `property`. */
  'PROPERTY',
]);
export type RenderVariableOrigin = z.infer<typeof renderVariableOriginSchema>;

/**
 * One variable a template declares.
 *
 * The name is what the Pandoc template says (`$customer$`), so it is restricted
 * to what Pandoc accepts as an identifier. Everything else on this record
 * exists so a form can be drawn and an agent can be told what to pass without
 * reading the template source.
 */
export const renderVariableSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'Kleinbuchstaben, Ziffern und Bindestriche, beginnend mit einem Buchstaben',
    ),
  label: z.string().min(1).max(120),
  origin: renderVariableOriginSchema.default('MANUAL'),
  /** The database property `origin: 'PROPERTY'` reads. Null otherwise. */
  property: z.string().min(1).max(120).nullable().default(null),
  required: z.boolean().default(false),
  defaultValue: z.string().max(2_000).nullable().default(null),
});
export type RenderVariable = z.infer<typeof renderVariableSchema>;

/** The most variables one template may declare. A form, not a database. */
export const RENDER_MAX_VARIABLES = 30;

/** The longest a template source may be. Generous: a real LaTeX preamble is long. */
export const RENDER_MAX_TEMPLATE_CHARS = 200_000;

/** How much of the build log is kept on a job. */
export const RENDER_MAX_LOG_CHARS = 40_000;

/**
 * How long the render queue's lock is held, and how often a stall is looked for.
 *
 * Well above the longest build `render.timeoutSeconds` allows (fifteen minutes):
 * BullMQ renews the lock while a handler runs, but a lock shorter than the work
 * turns a slow build into a "stalled" one and hands it to a second worker while
 * the first is still holding a container open.
 */
export const RENDER_QUEUE_LOCK_DURATION_MS = 1_200_000;
export const RENDER_QUEUE_STALLED_INTERVAL_MS = 60_000;

export const renderTemplateSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string(),
  description: z.string(),
  renderer: rendererSchema,
  /**
   * The Pandoc template. Null means the renderer's built-in one, which for
   * `LATEX_PDF` is Eisvogel: a clean technical-report look that most pages want
   * and that nobody has to write first.
   */
  source: z.string().nullable(),
  variables: z.array(renderVariableSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  createdById: idSchema.nullable(),
  createdByName: z.string().nullable(),
});
export type RenderTemplate = z.infer<typeof renderTemplateSchema>;

/**
 * A build, finished or not.
 *
 * `stale` is computed on read, never stored: it compares the hash the artifact
 * was built from with the hash the same inputs produce now. A stored flag would
 * have to be invalidated by everything that can change a page, which is
 * everything.
 */
export const renderJobSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  documentId: idSchema.nullable(),
  documentTitle: z.string().nullable(),
  templateId: idSchema.nullable(),
  templateName: z.string().nullable(),
  renderer: rendererSchema,
  source: renderSourceSchema,
  status: renderJobStatusSchema,
  /** The variable values the build actually used, after resolution. */
  variables: z.record(z.string(), z.string()),
  /** Deterministic fingerprint of source text, template, renderer and variables. */
  inputHash: z.string(),
  /** True when the page or the template has changed since this build. */
  stale: z.boolean(),
  /** Machine-readable failure reason, English. Null while nothing failed. */
  errorCode: z.string().nullable(),
  /** German, user-facing. Null while nothing failed. */
  error: z.string().nullable(),
  /** The last lines of the build log. The whole log is its own route. */
  logTail: z.string().nullable(),
  /** The finished PDF, as an ordinary attachment. */
  attachmentId: idSchema.nullable(),
  attachmentFilename: z.string().nullable(),
  attachmentByteSize: z.number().int().nonnegative().nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdById: idSchema.nullable(),
  createdByName: z.string().nullable(),
});
export type RenderJob = z.infer<typeof renderJobSchema>;

const templateBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1_000).default(''),
  renderer: rendererSchema.default('LATEX_PDF'),
  source: z.string().max(RENDER_MAX_TEMPLATE_CHARS).nullable().default(null),
  variables: z.array(renderVariableSchema).max(RENDER_MAX_VARIABLES).default([]),
});

export const createRenderTemplateRequestSchema = templateBodySchema;
export type CreateRenderTemplateRequest = z.infer<typeof createRenderTemplateRequestSchema>;

export const updateRenderTemplateRequestSchema = templateBodySchema.partial();
export type UpdateRenderTemplateRequest = z.infer<typeof updateRenderTemplateRequestSchema>;

export const renderTemplateResponseSchema = z.object({ template: renderTemplateSchema });
export type RenderTemplateResponse = z.infer<typeof renderTemplateResponseSchema>;

export const renderTemplateListResponseSchema = z.object({
  templates: z.array(renderTemplateSchema),
  /** Whether this workspace may render at all (`render.enabled`). */
  enabledForWorkspace: z.boolean(),
});
export type RenderTemplateListResponse = z.infer<typeof renderTemplateListResponseSchema>;

export const deleteRenderTemplateResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteRenderTemplateResponse = z.infer<typeof deleteRenderTemplateResponseSchema>;

export const deleteRenderJobResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteRenderJobResponse = z.infer<typeof deleteRenderJobResponseSchema>;

export const startRenderRequestSchema = z.object({
  templateId: idSchema,
  source: renderSourceSchema.default('DOCUMENT'),
  /** Values for `MANUAL` variables, and overrides for any other. */
  variables: z.record(z.string(), z.string().max(2_000)).default({}),
  /**
   * Build even though an identical build already succeeded.
   *
   * The cache is keyed by the input hash, so asking twice for the same page,
   * template and variables normally hands back the first answer. This is the
   * escape hatch for the case the hash cannot see: a changed container image.
   */
  force: z.boolean().default(false),
});
export type StartRenderRequest = z.infer<typeof startRenderRequestSchema>;

export const startRenderResponseSchema = z.object({
  job: renderJobSchema,
  /** True when this is an earlier build handed back instead of a new one. */
  reused: z.boolean(),
});
export type StartRenderResponse = z.infer<typeof startRenderResponseSchema>;

export const renderJobResponseSchema = z.object({ job: renderJobSchema });
export type RenderJobResponse = z.infer<typeof renderJobResponseSchema>;

export const renderJobListResponseSchema = z.object({ jobs: z.array(renderJobSchema) });
export type RenderJobListResponse = z.infer<typeof renderJobListResponseSchema>;

export const renderJobLogResponseSchema = z.object({
  jobId: idSchema,
  status: renderJobStatusSchema,
  log: z.string(),
  /** True when the log was cut to `RENDER_MAX_LOG_CHARS`. */
  truncated: z.boolean(),
});
export type RenderJobLogResponse = z.infer<typeof renderJobLogResponseSchema>;

/**
 * Where the finished file is and what can be done with it.
 *
 * `textStatus` is the part that matters to an agent: the artifact is an
 * attachment like any other, so the PDF text extraction runs over it and
 * `exo_attachment_read_text` can read back what the build actually produced.
 * That is how a machine inspects a visual result without rendering pixels.
 */
export const renderArtifactResponseSchema = z.object({
  jobId: idSchema,
  attachmentId: idSchema,
  filename: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** Relative API path the bytes can be fetched from. */
  downloadPath: z.string(),
  stale: z.boolean(),
  textStatus: z.enum(['NOT_APPLICABLE', 'PENDING', 'READY', 'FAILED']),
});
export type RenderArtifactResponse = z.infer<typeof renderArtifactResponseSchema>;

/**
 * German for what went wrong, from the English code the worker wrote.
 *
 * The mapping is here and not in the worker because the worker writes for a
 * log and this writes for a person: "renderer_unavailable" is the same fact as
 * "Auf diesem Rechner ist die PDF-Ausgabe nicht eingerichtet", and only one of
 * them belongs in a dialog.
 */
export function renderErrorMessage(code: string | null): string | null {
  switch (code) {
    case null:
      return null;
    case 'renderer_unavailable':
      return 'Die PDF-Ausgabe ist auf diesem Rechner nicht eingerichtet. Ein Administrator muss das Container-Abbild bereitstellen.';
    case 'render_failed':
      return 'Der Bau ist fehlgeschlagen. Das Protokoll sagt, an welcher Stelle.';
    case 'render_timeout':
      return 'Der Bau hat zu lange gedauert und wurde abgebrochen. Meist wartet die Vorlage auf eine Eingabe.';
    case 'artifact_too_large':
      return 'Das erzeugte PDF ist größer als erlaubt.';
    case 'empty_artifact':
      return 'Der Bau lief durch, hat aber keine Datei abgeliefert.';
    case 'source_missing':
      return 'Die Seite hat noch keinen aufbereiteten Inhalt. Einmal öffnen und kurz warten.';
    case 'template_missing':
      return 'Die Vorlage gibt es nicht mehr.';
    case 'worker_lost':
      return 'Der Bau wurde abgebrochen, weil der Hintergrunddienst ihn verloren hat.';
    default:
      return 'Der Bau ist fehlgeschlagen.';
  }
}

/**
 * Resolves one variable against everything known about the render.
 *
 * Lives in the contracts package because the API resolves variables when it
 * creates the job (so the hash covers them and the job record says what it
 * used) while the browser previews the same values in the form. Two
 * implementations would drift, and the drift would only show in the PDF.
 */
export function resolveRenderVariable(
  variable: RenderVariable,
  context: {
    explicit: Readonly<Record<string, string>>;
    title: string;
    path: string;
    author: string;
    today: string;
    properties: Readonly<Record<string, string>>;
  },
): string {
  const explicit = context.explicit[variable.name];
  if (explicit !== undefined && explicit.length > 0) return explicit;

  switch (variable.origin) {
    case 'TITLE':
      return context.title;
    case 'PATH':
      return context.path;
    case 'AUTHOR':
      return context.author;
    case 'TODAY':
      return context.today;
    case 'PROPERTY':
      return context.properties[variable.property ?? ''] ?? variable.defaultValue ?? '';
    case 'MANUAL':
      return variable.defaultValue ?? '';
  }
}

/** The variables a caller still has to fill in before the build can start. */
export function missingRenderVariables(
  variables: readonly RenderVariable[],
  resolved: Readonly<Record<string, string>>,
): string[] {
  return variables
    .filter((variable) => variable.required && (resolved[variable.name] ?? '').length === 0)
    .map((variable) => variable.name);
}
