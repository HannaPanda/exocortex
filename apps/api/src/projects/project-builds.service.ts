import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canBuildProject,
  canReadDocument,
  canReadWorkspace,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  PROJECT_MAX_DIAGNOSTICS,
  PROJECT_MAX_LOG_CHARS,
  type ProjectBuild,
  type ProjectBuildArtifactsResponse,
  type ProjectBuildDiagnosticsResponse,
  type ProjectBuildListResponse,
  type ProjectBuildLogResponse,
  QUEUE_NAMES,
  type StartProjectBuildRequest,
  type StartProjectBuildResponse,
} from '@exocortex/contracts';
import { loadProjectBuildInput, type PrismaClient, projectInputHash } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { AttachmentsService } from '../attachments/attachments.service';
import { AppError } from '../common/app-error';
import { currentCorrelationId } from '../common/correlation';
import { LOGGER } from '../common/logger.provider';
import { PRISMA, QUEUES } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

import {
  mapProjectBuild,
  parseProjectDiagnostics,
  PROJECT_BUILD_SELECT,
  type ProjectBuildRow,
} from './project-mapper';

/** Builds one listing hands back. A build log is read, not exported. */
const MAX_LISTED_BUILDS = 50;

/**
 * Project builds: starting them, watching them, stopping them (issue #43,
 * ADR-027).
 *
 * Shaped after `RenderJobsService` on purpose, because the questions are the
 * same and were already answered once. The input hash is computed here, when
 * the request is accepted, from the files the projection currently holds: that
 * is what makes the cache safe and what makes `stale` a comparison rather than
 * a flag somebody has to remember to clear.
 *
 * Nothing here compiles anything. It writes a row and enqueues a job; TeX Live
 * runs in a container the worker starts (CLAUDE.md rule 6).
 */
@Injectable()
export class ProjectBuildsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
    private readonly attachments: AttachmentsService,
  ) {}

  async start(input: {
    projectId: string;
    userId: string;
    request: StartProjectBuildRequest;
  }): Promise<StartProjectBuildResponse> {
    const context = await this.access.requireDocumentContext(input.projectId, input.userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
    assertPolicy(canBuildProject(context.role));
    if (context.document.type !== 'PROJECT') throw AppError.notFound('Project');

    const settings = await this.settings.getForWorkspace(context.workspaceId);
    if (!settings['projects.enabled']) {
      throw AppError.forbidden('Project builds are disabled for this workspace');
    }

    const project = await loadProjectBuildInput(this.prisma, input.projectId);
    if (project === null) throw AppError.notFound('Project');
    if (!project.materialized) {
      throw AppError.conflict(
        'Das Projekt ist noch nicht aufbereitet. Einen Moment warten und erneut bauen.',
      );
    }
    if (project.texts.length === 0) {
      throw AppError.validation('Das Projekt enthält noch keine Textdateien');
    }

    const rootFile = input.request.rootFile ?? project.rootFile;
    const engine = input.request.engine ?? project.engine;
    const bibliography = input.request.bibliography ?? project.bibliography;

    if (!project.texts.some((file) => file.path === rootFile)) {
      throw AppError.validation(`Die Hauptdatei "${rootFile}" gibt es im Projekt nicht`);
    }

    const inputHash = projectInputHash({
      engine,
      bibliography,
      rootFile,
      texts: project.texts,
      assets: project.assets,
    });

    if (!input.request.force) {
      const reusable = await this.findReusable(context.workspaceId, inputHash);
      if (reusable !== null) {
        return { build: mapProjectBuild(reusable, { stale: false }), reused: true };
      }
    }

    const build = await this.prisma.projectBuild.create({
      data: {
        workspaceId: context.workspaceId,
        projectId: input.projectId,
        projectTitle: project.title,
        rootFile,
        engine,
        bibliography,
        status: 'PENDING',
        inputHash,
        createdById: input.userId,
      },
      select: PROJECT_BUILD_SELECT,
    });

    await this.queues.enqueue(QUEUE_NAMES.projectBuild, {
      correlationId: currentCorrelationId(),
      buildId: build.id,
      workspaceId: context.workspaceId,
      userId: input.userId,
    });

    this.logger.info('Project build queued', {
      buildId: build.id,
      projectId: input.projectId,
      engine,
      rootFile,
    });

    return { build: mapProjectBuild(build, { stale: false }), reused: false };
  }

  async read(buildId: string, userId: string): Promise<ProjectBuild> {
    const row = await this.requireBuild(buildId, userId);
    return mapProjectBuild(row, { stale: await this.isStale(row) });
  }

  async list(input: {
    workspaceId: string;
    userId: string;
    projectId?: string;
  }): Promise<ProjectBuildListResponse> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canReadWorkspace(role));

    const rows = await this.prisma.projectBuild.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      },
      select: PROJECT_BUILD_SELECT,
      orderBy: { createdAt: 'desc' },
      take: MAX_LISTED_BUILDS,
    });

    // Staleness is asked of the newest successful build per project and of no
    // other: it costs a read of that project's whole file list, and forty old
    // builds do not become more useful by all being reported out of date.
    const stale = new Set<string>();
    const checked = new Set<string>();
    for (const row of rows) {
      if (row.status !== 'COMPLETED' || row.projectId === null) continue;
      if (checked.has(row.projectId)) continue;
      checked.add(row.projectId);
      if (await this.isStale(row)) stale.add(row.id);
    }

    return { builds: rows.map((row) => mapProjectBuild(row, { stale: stale.has(row.id) })) };
  }

  async readLog(buildId: string, userId: string): Promise<ProjectBuildLogResponse> {
    const row = await this.requireBuild(buildId, userId);
    const full = await this.prisma.projectBuild.findUniqueOrThrow({
      where: { id: buildId },
      select: { log: true },
    });
    const log = full.log ?? '';
    return {
      buildId: row.id,
      status: row.status,
      log,
      truncated: log.length >= PROJECT_MAX_LOG_CHARS,
    };
  }

  async readDiagnostics(buildId: string, userId: string): Promise<ProjectBuildDiagnosticsResponse> {
    const row = await this.requireBuild(buildId, userId);
    const diagnostics = parseProjectDiagnostics(row.diagnostics);
    return {
      buildId: row.id,
      status: row.status,
      diagnostics,
      truncated: diagnostics.length >= PROJECT_MAX_DIAGNOSTICS,
    };
  }

  /**
   * What the build produced, and how to read it back.
   *
   * The PDF's `textStatus` is the part that matters to an agent: the artifact is
   * an ordinary attachment, so the text extraction runs over it and
   * `exo_attachment_read_text` reads what the build actually printed. That is
   * how a machine inspects a visual result without rendering pixels.
   */
  async artifacts(buildId: string, userId: string): Promise<ProjectBuildArtifactsResponse> {
    const row = await this.requireBuild(buildId, userId);
    const ids = [row.attachmentId, row.sourceMapAttachmentId].filter(
      (id): id is string => id !== null,
    );
    const attachments =
      ids.length === 0
        ? []
        : await this.prisma.attachment.findMany({
            where: { id: { in: ids }, deletedAt: null },
            select: { id: true, filename: true, byteSize: true, textStatus: true },
          });
    const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));

    const pdf = row.attachmentId === null ? undefined : byId.get(row.attachmentId);
    const map =
      row.sourceMapAttachmentId === null ? undefined : byId.get(row.sourceMapAttachmentId);

    return {
      buildId: row.id,
      status: row.status,
      stale: await this.isStale(row),
      pdf:
        pdf === undefined
          ? null
          : {
              attachmentId: pdf.id,
              filename: pdf.filename,
              byteSize: pdf.byteSize,
              downloadPath: `/api/attachments/${pdf.id}/download`,
              pageCount: row.pageCount,
              textStatus: pdf.textStatus,
            },
      sourceMap:
        map === undefined
          ? null
          : {
              attachmentId: map.id,
              filename: map.filename,
              byteSize: map.byteSize,
              downloadPath: `/api/attachments/${map.id}/download`,
            },
    };
  }

  /**
   * Asks for a build to stop.
   *
   * Writes `cancelledAt` and leaves the rest to the worker, which checks it
   * between its steps and kills the container. A `PENDING` build is closed here
   * and now: no worker is holding it, and waiting for one would leave a queued
   * build claiming it is still coming.
   */
  async cancel(buildId: string, userId: string): Promise<ProjectBuild> {
    const row = await this.requireBuild(buildId, userId);
    const role = await this.access.findRole(row.workspaceId, userId);
    assertPolicy(canBuildProject(role));

    if (row.status !== 'PENDING' && row.status !== 'RUNNING') {
      throw AppError.conflict('Dieser Bau ist bereits abgeschlossen');
    }

    const now = new Date();
    const updated = await this.prisma.projectBuild.update({
      where: { id: buildId },
      data:
        row.status === 'PENDING'
          ? { status: 'CANCELLED', cancelledAt: now, finishedAt: now }
          : { cancelledAt: now },
      select: PROJECT_BUILD_SELECT,
    });
    return mapProjectBuild(updated, { stale: false });
  }

  /**
   * Removes one build, the PDF it produced and its source map.
   *
   * The same decision `RenderJobsService.remove` makes, for the same reason: a
   * row whose file is gone is a truthful record, and it is still not what
   * somebody means when they point at a line in the list. Both attachments go,
   * because a SyncTeX map without the PDF it maps into is nothing on its own.
   *
   * Not irreversible: the sources are untouched, so the same build can be asked
   * for again. What it costs is the log of a failure, and that comes back by
   * failing again.
   */
  async remove(buildId: string, userId: string): Promise<void> {
    const row = await this.requireBuild(buildId, userId);
    const role = await this.access.findRole(row.workspaceId, userId);
    assertPolicy(canBuildProject(role));

    if (row.status === 'PENDING' || row.status === 'RUNNING') {
      throw AppError.conflict('Dieser Bau läuft noch; brich ihn erst ab');
    }

    for (const attachmentId of [row.attachmentId, row.sourceMapAttachmentId]) {
      if (attachmentId === null) continue;
      await this.attachments.delete({
        attachmentId,
        userId,
        correlationId: currentCorrelationId(),
      });
    }

    await this.prisma.projectBuild.delete({ where: { id: buildId } });
  }

  private async requireBuild(buildId: string, userId: string): Promise<ProjectBuildRow> {
    const row = await this.prisma.projectBuild.findUnique({
      where: { id: buildId },
      select: PROJECT_BUILD_SELECT,
    });
    if (row === null) throw AppError.notFound('Project build');
    await this.access.requireRole(row.workspaceId, userId);
    return row;
  }

  /**
   * The newest successful build of these exact inputs whose PDF still exists.
   *
   * The file has to still be there: a completed build whose attachment somebody
   * deleted would otherwise be handed back for ever as a cache hit with nothing
   * behind it.
   */
  private async findReusable(
    workspaceId: string,
    inputHash: string,
  ): Promise<ProjectBuildRow | null> {
    const rows = await this.prisma.projectBuild.findMany({
      where: {
        workspaceId,
        inputHash,
        status: 'COMPLETED',
        attachmentId: { not: null },
        attachment: { deletedAt: null },
      },
      select: PROJECT_BUILD_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    return rows[0] ?? null;
  }

  /**
   * Whether the project has changed since this build.
   *
   * A comparison of hashes, computed now against what was recorded then. A
   * stored flag would have to be invalidated by everything that can change a
   * project, which is every keystroke.
   */
  private async isStale(row: ProjectBuildRow): Promise<boolean> {
    if (row.status !== 'COMPLETED' || row.projectId === null) return false;
    const project = await loadProjectBuildInput(this.prisma, row.projectId);
    if (project === null) return true;
    const current = projectInputHash({
      engine: row.engine,
      bibliography: row.bibliography,
      rootFile: row.rootFile,
      texts: project.texts,
      assets: project.assets,
    });
    return current !== row.inputHash;
  }
}
