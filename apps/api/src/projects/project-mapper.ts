import {
  type Project,
  type ProjectBuild,
  projectBuildErrorMessage,
  type ProjectDiagnostic,
  projectDiagnosticSchema,
} from '@exocortex/contracts';
import { type Prisma } from '@exocortex/database';

/**
 * Database rows into contract shapes (issue #43, ADR-027).
 *
 * One file, so the two selects and the two mappings cannot drift: a field added
 * to the select and forgotten in the mapping is a field the browser silently
 * never sees.
 */

export const PROJECT_SELECT = {
  documentId: true,
  type: true,
  rootFile: true,
  engine: true,
  bibliography: true,
  materializedAt: true,
  createdAt: true,
  updatedAt: true,
  document: {
    select: {
      workspaceId: true,
      title: true,
      // `yjsUpdatedAt` is what makes "the file list is a moment behind" a
      // comparison rather than a guess.
      content: { select: { yjsUpdatedAt: true } },
    },
  },
  // The kinds rather than a `_count`: the response reports files and assets
  // separately, Prisma counts one relation per select, and a project holds at
  // most a few hundred rows.
  files: { select: { kind: true } },
} satisfies Prisma.ProjectSelect;

type ProjectRow = Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>;

export function mapProject(row: ProjectRow): Project {
  const assets = row.files.filter((file) => file.kind === 'ASSET').length;
  return {
    id: row.documentId,
    workspaceId: row.document.workspaceId,
    title: row.document.title,
    type: row.type,
    rootFile: row.rootFile,
    engine: row.engine,
    bibliography: row.bibliography,
    fileCount: row.files.length,
    assetCount: assets,
    materialized: row.materializedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Where the bytes of an asset are fetched from.
 *
 * Null for a text file, and null for an asset whose attachment was deleted: a
 * download path that 404s is worse than none, because the file tree can draw a
 * hole for the second and cannot for the first.
 */
export function projectFileDownloadPath(
  attachmentId: string | null,
  deletedAt: Date | null,
): string | null {
  if (attachmentId === null || deletedAt !== null) return null;
  return `/api/attachments/${attachmentId}/download`;
}

export const PROJECT_BUILD_SELECT = {
  id: true,
  workspaceId: true,
  projectId: true,
  projectTitle: true,
  rootFile: true,
  engine: true,
  bibliography: true,
  status: true,
  inputHash: true,
  errorCode: true,
  diagnostics: true,
  attachmentId: true,
  sourceMapAttachmentId: true,
  pageCount: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  createdById: true,
  createdBy: { select: { name: true } },
  attachment: { select: { byteSize: true, deletedAt: true } },
} satisfies Prisma.ProjectBuildSelect;

export type ProjectBuildRow = Prisma.ProjectBuildGetPayload<{
  select: typeof PROJECT_BUILD_SELECT;
}>;

/**
 * The parsed diagnostics of a build, or an empty list.
 *
 * Validated on read rather than trusted: the column is Json, the worker wrote
 * it, and a shape that changed between two deployments would otherwise reach
 * the browser as a crash instead of an empty error panel.
 */
export function parseProjectDiagnostics(value: Prisma.JsonValue): ProjectDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const parsed: ProjectDiagnostic[] = [];
  for (const entry of value) {
    const result = projectDiagnosticSchema.safeParse(entry);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

export function mapProjectBuild(row: ProjectBuildRow, options: { stale: boolean }): ProjectBuild {
  const diagnostics = parseProjectDiagnostics(row.diagnostics);
  const hasArtifact = row.attachmentId !== null && row.attachment?.deletedAt == null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectTitle: row.projectTitle,
    rootFile: row.rootFile,
    engine: row.engine,
    bibliography: row.bibliography,
    status: row.status,
    inputHash: row.inputHash,
    stale: options.stale,
    errorCode: row.errorCode,
    error: projectBuildErrorMessage(row.errorCode),
    errorCount: diagnostics.filter((entry) => entry.severity === 'ERROR').length,
    warningCount: diagnostics.filter((entry) => entry.severity === 'WARNING').length,
    attachmentId: hasArtifact ? row.attachmentId : null,
    attachmentByteSize: hasArtifact ? (row.attachment?.byteSize ?? null) : null,
    downloadPath: hasArtifact ? `/api/attachments/${row.attachmentId ?? ''}/download` : null,
    sourceMapAttachmentId: row.sourceMapAttachmentId,
    pageCount: row.pageCount,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    createdById: row.createdById,
    createdByName: row.createdBy?.name ?? null,
  };
}
