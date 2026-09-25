import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canReadDocument,
  canReadWorkspace,
  canStartRender,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  attachmentDownloadPath,
  type Locale,
  missingRenderVariables,
  QUEUE_NAMES,
  RENDER_MAX_LOG_CHARS,
  type RenderArtifactResponse,
  type RenderJob,
  type RenderJobListResponse,
  type RenderJobLogResponse,
  resolveRenderVariable,
  type StartRenderRequest,
  type StartRenderResponse,
} from '@exocortex/contracts';
import {
  loadRenderSource,
  type Prisma,
  type PrismaClient,
  renderInputHash,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { AttachmentsService } from '../attachments/attachments.service';
import { AppError } from '../common/app-error';
import { currentCorrelationId } from '../common/correlation';
import { LOGGER } from '../common/logger.provider';
import { readerLocale, type ReaderLocaleHeaders } from '../common/reader-locale';
import { PRISMA, QUEUES } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

import { mapRenderJob, parseRenderVariables, RENDER_JOB_SELECT } from './render-mapper';
import { loadRenderProperties } from './render-properties';

/** Jobs one listing hands back. A build log is read, not exported. */
const MAX_LISTED_JOBS = 50;

/**
 * Builds: starting them, watching them, stopping them (issue #44, ADR-026).
 *
 * Three things are decided here and nowhere else.
 *
 * **The input hash.** It is computed when the request is accepted, from the
 * source text, the template and the resolved variables. It is what makes the
 * cache safe (identical inputs, identical file) and it is what makes a page
 * able to say its PDF is out of date without any invalidation machinery: `stale`
 * is a comparison, not a flag somebody has to remember to clear.
 *
 * **Variable resolution.** It happens here rather than in the worker, so the
 * values the build used are written on the job and visible afterwards. A
 * variable resolved in the worker would be a value nobody can see and nobody
 * can reproduce.
 *
 * **Nothing about LaTeX.** The API never touches Pandoc, a template engine or a
 * container. It writes a row and enqueues a job; the build happens where builds
 * happen (CLAUDE.md rule 6).
 */
@Injectable()
export class RenderJobsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
    private readonly attachments: AttachmentsService,
  ) {}

  async start(input: {
    documentId: string;
    userId: string;
    request: StartRenderRequest;
    /** The request's headers, for the language `error` is written in. */
    headers?: ReaderLocaleHeaders;
  }): Promise<StartRenderResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
    assertPolicy(canStartRender(context.role));

    const settings = await this.settings.getForWorkspace(context.workspaceId);
    if (!settings['render.enabled']) {
      throw AppError.forbidden('Rendering is disabled for this workspace');
    }

    const template = await this.prisma.renderTemplate.findUnique({
      where: { id: input.request.templateId },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        renderer: true,
        source: true,
        variables: true,
      },
    });
    if (template === null || template.workspaceId !== context.workspaceId) {
      throw AppError.notFound('Render template');
    }

    const assembled = await loadRenderSource(this.prisma, {
      documentId: input.documentId,
      source: input.request.source,
    });
    if (assembled === null || assembled.text.trim().length === 0) {
      throw AppError.validation('The page has no materialized content to build a PDF from yet');
    }

    const variables = await this.resolveVariables({
      documentId: input.documentId,
      userId: input.userId,
      declared: parseRenderVariables(template.variables),
      explicit: input.request.variables,
      title: assembled.title,
      path: assembled.path,
    });

    const inputHash = renderInputHash({
      renderer: template.renderer,
      source: input.request.source,
      text: assembled.text,
      template: template.source,
      variables,
    });

    if (!input.request.force) {
      const reusable = await this.findReusable(context.workspaceId, inputHash);
      if (reusable !== null) {
        return {
          job: mapRenderJob(reusable, {
            stale: false,
            locale: await this.locale(input.userId, input.headers),
          }),
          reused: true,
        };
      }
    }

    const job = await this.prisma.renderJob.create({
      data: {
        workspaceId: context.workspaceId,
        documentId: input.documentId,
        documentTitle: context.document.title,
        templateId: template.id,
        templateName: template.name,
        renderer: template.renderer,
        source: input.request.source,
        status: 'PENDING',
        variables: variables as unknown as Prisma.InputJsonValue,
        inputHash,
        createdById: input.userId,
      },
      select: RENDER_JOB_SELECT,
    });

    await this.queues.enqueue(QUEUE_NAMES.render, {
      correlationId: currentCorrelationId(),
      jobId: job.id,
      workspaceId: context.workspaceId,
      userId: input.userId,
    });

    this.logger.info('Render job queued', {
      renderJobId: job.id,
      documentId: input.documentId,
      templateId: template.id,
    });

    return {
      job: mapRenderJob(job, {
        stale: false,
        locale: await this.locale(input.userId, input.headers),
      }),
      reused: false,
    };
  }

  async read(jobId: string, userId: string, headers: ReaderLocaleHeaders = {}): Promise<RenderJob> {
    const row = await this.requireJob(jobId, userId);
    return mapRenderJob(row, {
      stale: await this.isStale(row),
      locale: await this.locale(userId, headers),
    });
  }

  async list(input: {
    workspaceId: string;
    userId: string;
    documentId?: string;
    headers?: ReaderLocaleHeaders;
  }): Promise<RenderJobListResponse> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canReadWorkspace(role));

    const rows = await this.prisma.renderJob.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      },
      select: RENDER_JOB_SELECT,
      orderBy: { createdAt: 'desc' },
      take: MAX_LISTED_JOBS,
    });

    // Staleness is asked of the newest successful build per page and of no
    // other: it costs a read of that page's Markdown, and a list of forty old
    // builds does not get more useful by saying that all of them are out of
    // date. Rows arrive newest first, so the first hit per page is the one.
    const staleJobIds = new Set<string>();
    const checked = new Set<string>();
    for (const row of rows) {
      if (row.status !== 'COMPLETED' || row.documentId === null) continue;
      if (checked.has(row.documentId)) continue;
      checked.add(row.documentId);
      if (await this.isStale(row)) staleJobIds.add(row.id);
    }

    const locale = await this.locale(input.userId, input.headers);
    return {
      jobs: rows.map((row) => mapRenderJob(row, { locale, stale: staleJobIds.has(row.id) })),
    };
  }

  async readLog(jobId: string, userId: string): Promise<RenderJobLogResponse> {
    const row = await this.requireJob(jobId, userId);
    const full = await this.prisma.renderJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { log: true },
    });
    const log = full.log ?? '';
    return {
      jobId: row.id,
      status: row.status,
      log,
      truncated: log.length >= RENDER_MAX_LOG_CHARS,
    };
  }

  /**
   * Asks for a build to stop.
   *
   * Writes `cancelledAt` and leaves the rest to the worker, which checks it
   * between its steps and kills the container. A `PENDING` job is closed here
   * and now, because there is no worker holding it yet and waiting for one to
   * notice would leave a queued build that says it is still coming.
   */
  async cancel(
    jobId: string,
    userId: string,
    headers: ReaderLocaleHeaders = {},
  ): Promise<RenderJob> {
    const row = await this.requireJob(jobId, userId);
    const role = await this.access.findRole(row.workspaceId, userId);
    assertPolicy(canStartRender(role));

    if (row.status !== 'PENDING' && row.status !== 'RUNNING') {
      throw AppError.conflict('This build has already finished');
    }

    const updated = await this.prisma.renderJob.update({
      where: { id: jobId },
      data:
        row.status === 'PENDING'
          ? { status: 'CANCELLED', cancelledAt: new Date(), finishedAt: new Date() }
          : { cancelledAt: new Date() },
      select: RENDER_JOB_SELECT,
    });
    return mapRenderJob(updated, { stale: false, locale: await this.locale(userId, headers) });
  }

  /**
   * Removes one build and the file it produced.
   *
   * Deliberately the whole row rather than only the artifact. A job whose file
   * is gone is a truthful record and that is why `attachmentId` is `SetNull`
   * rather than a cascade -- but it is not what somebody means when they point
   * at an entry in the list and say this one should go, and a list of tombstones
   * is worse than a short list. `retention` already deletes finished jobs
   * wholesale, so a job is not a thing this deployment promises to keep.
   *
   * The file goes through `AttachmentsService`, not through Prisma here: it
   * owns the stored objects, the audit entry and the uploader check, and a
   * second implementation would be the one that forgets the object in MinIO.
   *
   * Not irreversible in the sense the confirmation gate means: the inputs are
   * still there, so the same build can be asked for again. What it costs is the
   * log of a failure, and that comes back by failing again.
   */
  async remove(jobId: string, userId: string): Promise<void> {
    const row = await this.requireJob(jobId, userId);
    const role = await this.access.findRole(row.workspaceId, userId);
    assertPolicy(canStartRender(role));

    if (row.status === 'PENDING' || row.status === 'RUNNING') {
      throw AppError.conflict('This build is still running; cancel it first');
    }

    if (row.attachmentId !== null) {
      await this.attachments.delete({
        attachmentId: row.attachmentId,
        userId,
        correlationId: currentCorrelationId(),
      });
    }

    await this.prisma.renderJob.delete({ where: { id: jobId } });
  }

  async artifact(jobId: string, userId: string): Promise<RenderArtifactResponse> {
    const row = await this.requireJob(jobId, userId);
    if (row.attachmentId === null || row.attachment === null) {
      throw AppError.notFound('Render artifact');
    }

    const attachment = await this.prisma.attachment.findUnique({
      where: { id: row.attachmentId },
      select: { id: true, filename: true, byteSize: true, textStatus: true, deletedAt: true },
    });
    if (attachment === null || attachment.deletedAt !== null) {
      throw AppError.notFound('Render artifact');
    }

    return {
      jobId: row.id,
      attachmentId: attachment.id,
      filename: attachment.filename,
      byteSize: attachment.byteSize,
      downloadPath: attachmentDownloadPath(attachment.id),
      stale: await this.isStale(row),
      textStatus: attachment.textStatus,
    };
  }

  /** The requester's language, for the one field of a job written for a person (ADR-062). */
  private async locale(userId: string, headers: ReaderLocaleHeaders = {}): Promise<Locale> {
    return readerLocale(this.prisma, userId, headers);
  }

  private async requireJob(
    jobId: string,
    userId: string,
  ): Promise<Prisma.RenderJobGetPayload<{ select: typeof RENDER_JOB_SELECT }>> {
    const row = await this.prisma.renderJob.findUnique({
      where: { id: jobId },
      select: RENDER_JOB_SELECT,
    });
    if (row === null) throw AppError.notFound('Render job');
    await this.access.requireRole(row.workspaceId, userId);
    return row;
  }

  /**
   * The newest successful build of these exact inputs whose file still exists.
   *
   * Scoped to the workspace even though the hash covers the content: two
   * workspaces holding the same page would otherwise share an attachment, and
   * an attachment belongs to exactly one workspace.
   */
  private async findReusable(
    workspaceId: string,
    inputHash: string,
  ): Promise<Prisma.RenderJobGetPayload<{ select: typeof RENDER_JOB_SELECT }> | null> {
    const row = await this.prisma.renderJob.findFirst({
      where: {
        workspaceId,
        inputHash,
        status: 'COMPLETED',
        attachment: { is: { deletedAt: null } },
      },
      select: RENDER_JOB_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return row;
  }

  /**
   * Whether the page or the template has moved on since this build.
   *
   * Recomputes the hash from what is there now. A page that has been deleted is
   * not stale -- there is nothing to rebuild from, and saying "out of date"
   * about it would invite a button that cannot work.
   */
  private async isStale(row: {
    status: string;
    documentId: string | null;
    templateId: string | null;
    source: string;
    renderer: string;
    inputHash: string;
    variables: Prisma.JsonValue;
  }): Promise<boolean> {
    if (row.status !== 'COMPLETED' || row.documentId === null) return false;

    const template =
      row.templateId === null
        ? null
        : await this.prisma.renderTemplate.findUnique({
            where: { id: row.templateId },
            select: { source: true },
          });
    if (row.templateId !== null && template === null) return true;

    const assembled = await loadRenderSource(this.prisma, {
      documentId: row.documentId,
      source: row.source === 'SUBTREE' ? 'SUBTREE' : 'DOCUMENT',
    });
    if (assembled === null) return false;

    const variables: Record<string, string> = {};
    if (
      typeof row.variables === 'object' &&
      row.variables !== null &&
      !Array.isArray(row.variables)
    ) {
      for (const [key, value] of Object.entries(row.variables)) {
        if (typeof value === 'string') variables[key] = value;
      }
    }

    return (
      renderInputHash({
        renderer: row.renderer,
        source: row.source,
        text: assembled.text,
        template: template?.source ?? null,
        variables,
      }) !== row.inputHash
    );
  }

  /**
   * Turns declared variables plus what the caller passed into the values the
   * build uses. Refuses when a required one is still empty: a LaTeX template
   * with an unset `$customer$` does not fail, it silently prints nothing, and a
   * letter addressed to nobody is worse than an error message.
   */
  private async resolveVariables(input: {
    documentId: string;
    userId: string;
    declared: ReturnType<typeof parseRenderVariables>;
    explicit: Readonly<Record<string, string>>;
    title: string;
    path: string;
  }): Promise<Record<string, string>> {
    const [user, properties] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: input.userId }, select: { name: true } }),
      input.declared.some((variable) => variable.origin === 'PROPERTY')
        ? loadRenderProperties(this.prisma, input.documentId)
        : Promise.resolve({}),
    ]);

    const context = {
      explicit: input.explicit,
      title: input.title,
      path: input.path,
      author: user?.name ?? '',
      today: new Date().toISOString().slice(0, 10),
      properties,
    };

    const resolved: Record<string, string> = {};
    for (const variable of input.declared) {
      resolved[variable.name] = resolveRenderVariable(variable, context);
    }

    // The title always travels, declared or not: every Pandoc template uses
    // `$title$`, including the built-in one nobody wrote.
    resolved['title'] ??= input.title;

    const missing = missingRenderVariables(input.declared, resolved);
    if (missing.length > 0) {
      throw AppError.validation(`Diese Werte fehlen noch: ${missing.join(', ')}`, {
        missingVariables: missing,
      });
    }
    return resolved;
  }
}
