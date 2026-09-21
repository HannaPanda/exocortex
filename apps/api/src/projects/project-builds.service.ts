import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canBuildProject,
  canReadDocument,
  canReadWorkspace,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  attachmentDownloadPath,
  PROJECT_MAX_DIAGNOSTICS,
  PROJECT_MAX_LOG_CHARS,
  PROJECT_MAX_SOURCE_AREAS,
  type ProjectBuild,
  type ProjectBuildArtifactsResponse,
  type ProjectBuildDiagnosticsResponse,
  type ProjectBuildListResponse,
  type ProjectBuildLogResponse,
  type ProjectPositionLookupResponse,
  type ProjectSourceLookupResponse,
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
import {
  lookupAreas as findLineAreas,
  lookupSource as findSourceRecord,
  parseSyncTex,
  resolveInputPath,
  type SyncTexMap,
} from './synctex';

/** Builds one listing hands back. A build log is read, not exported. */
const MAX_LISTED_BUILDS = 50;

/**
 * The largest SyncTeX map this process is willing to parse into memory.
 *
 * The worker already refuses to store one above 20 MB, so this is the second
 * half of the same decision rather than a new one: a map that big is a
 * thousand-page document, and turning it into several hundred thousand objects
 * in the API process is not what the API process is for. The map stays
 * downloadable either way -- it is an ordinary attachment.
 */
const MAX_PARSED_SOURCE_MAP_BYTES = 20_000_000;

/**
 * How long one parsed map is kept, and how many at once.
 *
 * Clicking through a PDF asks the same question of the same build dozens of
 * times in a row, and parsing a few megabytes for each click would be the whole
 * cost of the feature. Two entries rather than a real cache: the working set is
 * "the build somebody is looking at", and holding more parsed maps than that on
 * a host that shares its memory with a dozen services buys nothing.
 */
const SOURCE_MAP_CACHE_SIZE = 2;
const SOURCE_MAP_CACHE_TTL_MS = 5 * 60 * 1000;

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
              downloadPath: attachmentDownloadPath(pdf.id),
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
              downloadPath: attachmentDownloadPath(map.id),
            },
    };
  }

  /**
   * Which source line produced a place in the finished PDF (issue #53).
   *
   * Reverse SyncTeX, and the half that a browser cannot do for itself: the
   * built PDF is a picture of the answer, and only the map beside it knows
   * where the answer came from. The same route serves the viewer's click and an
   * agent asking "where does page 17 come from", which is the point of ADR-025
   * -- the browser gets no lookup the catalogue does not also get.
   */
  async lookupSource(
    buildId: string,
    userId: string,
    query: { page: number; x: number; y: number },
  ): Promise<ProjectSourceLookupResponse> {
    const { row, map } = await this.readSourceMap(buildId, userId);
    const found = findSourceRecord(map, query);
    if (found === null) {
      throw AppError.notFound('Project build source position');
    }
    const inputPath = map.inputs.get(found.tag) ?? '';
    return {
      buildId: row.id,
      file: await this.projectPathFor(row.projectId, inputPath),
      inputPath,
      line: found.line,
      area: {
        page: found.page,
        left: found.left,
        top: found.top,
        width: found.width,
        height: found.height,
      },
    };
  }

  /**
   * Where a source line ended up in the finished PDF (issue #53).
   *
   * Forward SyncTeX. The answer names the line it actually found, which is
   * rarely the one asked for: most lines of a LaTeX file print nothing, and a
   * caller that showed the request back would claim a comment has a place on
   * the page.
   */
  async lookupPosition(
    buildId: string,
    userId: string,
    query: { file: string; line: number },
  ): Promise<ProjectPositionLookupResponse> {
    const { row, map } = await this.readSourceMap(buildId, userId);
    const paths = await this.projectPaths(row.projectId);
    // Several tags can name one file -- TeX opens `main.aux` twice and counts
    // twice -- so every tag that resolves to this path is asked, and the first
    // one that produced output wins.
    const tags = [...map.inputs.entries()]
      .filter(([, raw]) => resolveInputPath(raw, paths) === query.file)
      .map(([tag]) => tag);
    if (tags.length === 0) {
      throw AppError.notFound('Project build source file');
    }

    for (const tag of tags) {
      const found = findLineAreas(map, { tag, line: query.line }, PROJECT_MAX_SOURCE_AREAS);
      if (found === null) continue;
      return {
        buildId: row.id,
        file: query.file,
        requestedLine: query.line,
        line: found.line,
        areas: found.areas,
      };
    }
    throw AppError.notFound('Project build source position');
  }

  /**
   * The build's parsed map, with the permission check the rest of this class does.
   *
   * The bytes travel through `AttachmentsService` rather than storage directly,
   * so the map is read under the same rule as any other file of the workspace
   * and a revoked membership stops this route too.
   */
  private async readSourceMap(
    buildId: string,
    userId: string,
  ): Promise<{ row: ProjectBuildRow; map: SyncTexMap }> {
    const row = await this.requireBuild(buildId, userId);
    if (row.sourceMapAttachmentId === null) {
      throw AppError.notFound('Project build source map');
    }

    const cached = readCache(sourceMapCache, buildId);
    if (cached !== null) return { row, map: cached };

    const file = await this.attachments.download(row.sourceMapAttachmentId, userId);
    if (file.byteSize > MAX_PARSED_SOURCE_MAP_BYTES) {
      throw AppError.conflict(
        'Die SyncTeX-Karte dieses Baus ist zu groß, um sie hier auszuwerten. Sie lässt sich als Anhang herunterladen.',
      );
    }

    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(Buffer.from(chunk as Buffer));
    const map = parseSyncTex(Buffer.concat(chunks).toString('utf8'));
    writeCache(sourceMapCache, buildId, map);
    return { row, map };
  }

  /** The paths the project holds, which is what makes a container path readable. */
  private async projectPaths(projectId: string | null): Promise<string[]> {
    if (projectId === null) return [];
    const files = await this.prisma.projectFile.findMany({
      where: { projectId },
      select: { path: true },
    });
    return files.map((file) => file.path);
  }

  private async projectPathFor(
    projectId: string | null,
    inputPath: string,
  ): Promise<string | null> {
    if (inputPath.length === 0) return null;
    return resolveInputPath(inputPath, await this.projectPaths(projectId));
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

/**
 * A parsed map per build, for as long as somebody is looking at that build.
 *
 * Module scope rather than an instance field because the service is a singleton
 * either way, and because putting it here keeps the eviction rule in one place
 * next to the two functions that touch it.
 */
interface CacheEntry {
  map: SyncTexMap;
  writtenAt: number;
}

const sourceMapCache = new Map<string, CacheEntry>();

function readCache(cache: Map<string, CacheEntry>, key: string): SyncTexMap | null {
  const entry = cache.get(key);
  if (entry === undefined) return null;
  if (Date.now() - entry.writtenAt > SOURCE_MAP_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Re-inserting makes the iteration order least-recently-used first, which is
  // what the eviction below relies on.
  cache.delete(key);
  cache.set(key, entry);
  return entry.map;
}

function writeCache(cache: Map<string, CacheEntry>, key: string, map: SyncTexMap): void {
  cache.set(key, { map, writtenAt: Date.now() });
  while (cache.size > SOURCE_MAP_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
