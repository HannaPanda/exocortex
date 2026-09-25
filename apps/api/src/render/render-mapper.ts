import {
  type Locale,
  renderErrorKey,
  type RenderJob,
  type RenderTemplate,
  type RenderVariable,
  renderVariableSchema,
} from '@exocortex/contracts';
import { type Prisma } from '@exocortex/database';
import { serverTranslator } from '@exocortex/i18n/catalog';

/**
 * Row shapes to DTOs (issue #44, ADR-026).
 *
 * The two decisions worth naming: a job hands out the *tail* of its build log
 * and never the whole thing (a LaTeX log is tens of kilobytes and the list view
 * would carry one per row), and `stale` is passed in rather than read, because
 * whether a build is out of date is a comparison against the page as it is now
 * and the mapper has no business doing database work.
 */

export const RENDER_TEMPLATE_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  description: true,
  renderer: true,
  source: true,
  variables: true,
  createdById: true,
  createdBy: { select: { name: true } },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RenderTemplateSelect;

type RenderTemplateRow = Prisma.RenderTemplateGetPayload<{
  select: typeof RENDER_TEMPLATE_SELECT;
}>;

/**
 * The declared variables of a stored template.
 *
 * Parsed defensively: the column is JSON, and a row written before a field
 * existed is exactly the kind that fails a strict parse. A variable that no
 * longer matches the contract is dropped rather than allowed to break the form
 * it appears in -- the template still renders, it just stops offering a field
 * nothing can fill.
 */
export function parseRenderVariables(value: Prisma.JsonValue): RenderVariable[] {
  if (!Array.isArray(value)) return [];
  const parsed: RenderVariable[] = [];
  for (const entry of value) {
    const result = renderVariableSchema.safeParse(entry);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

export function mapRenderTemplate(row: RenderTemplateRow): RenderTemplate {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    renderer: row.renderer,
    source: row.source,
    variables: parseRenderVariables(row.variables),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdById: row.createdById,
    createdByName: row.createdBy?.name ?? null,
  };
}

export const RENDER_JOB_SELECT = {
  id: true,
  workspaceId: true,
  documentId: true,
  documentTitle: true,
  templateId: true,
  templateName: true,
  renderer: true,
  source: true,
  status: true,
  variables: true,
  inputHash: true,
  errorCode: true,
  log: true,
  attachmentId: true,
  attachment: { select: { filename: true, byteSize: true, deletedAt: true } },
  createdById: true,
  createdBy: { select: { name: true } },
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
} satisfies Prisma.RenderJobSelect;

type RenderJobRow = Prisma.RenderJobGetPayload<{ select: typeof RENDER_JOB_SELECT }>;

/** Lines of the build log a job carries around with it. */
const LOG_TAIL_LINES = 40;

export function logTail(log: string | null): string | null {
  if (log === null) return null;
  const lines = log.split('\n');
  return lines.length <= LOG_TAIL_LINES ? log : lines.slice(-LOG_TAIL_LINES).join('\n');
}

/** The values a build used, as the DTO promises them: strings, every one. */
function variableRecord(value: Prisma.JsonValue): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/** The stored error code as a sentence in `locale`, or null when nothing failed. */
function renderErrorText(code: string | null, locale: Locale): string | null {
  const key = renderErrorKey(code);
  return key === null ? null : serverTranslator(locale, 'render')(`errors.${key}`);
}

/**
 * `locale` is the requester's (ADR-062): `error` is the one field here written
 * for a person, and the browser renders `errorCode` itself, so in practice it is
 * what an agent reads.
 */
export function mapRenderJob(
  row: RenderJobRow,
  options: { stale: boolean; locale: Locale },
): RenderJob {
  const hasArtifact = row.attachmentId !== null && row.attachment?.deletedAt == null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    templateId: row.templateId,
    templateName: row.templateName,
    renderer: row.renderer,
    source: row.source,
    status: row.status,
    variables: variableRecord(row.variables),
    inputHash: row.inputHash,
    stale: options.stale,
    errorCode: row.errorCode,
    error: renderErrorText(row.errorCode, options.locale),
    logTail: logTail(row.log),
    attachmentId: hasArtifact ? row.attachmentId : null,
    attachmentFilename: hasArtifact ? (row.attachment?.filename ?? null) : null,
    attachmentByteSize: hasArtifact ? (row.attachment?.byteSize ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    createdById: row.createdById,
    createdByName: row.createdBy?.name ?? null,
  };
}
