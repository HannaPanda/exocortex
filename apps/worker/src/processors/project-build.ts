import { gunzipSync } from 'node:zlib';

import {
  PROJECT_MAX_LOG_CHARS,
  type ProjectDiagnostic,
  type QUEUE_NAMES,
  type Settings,
  uploadAttachmentResponseSchema,
} from '@exocortex/contracts';
import {
  loadProjectBuildInput,
  type Prisma,
  type PrismaClient,
  type ProjectBuildInput,
} from '@exocortex/database';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { parseLatexLog } from './project/diagnostics';
import {
  type ProjectRunFile,
  type ProjectRunResult,
  runProjectBuild,
} from './project/latexmk-runner';

export interface ProjectBuildDependencies {
  prisma: PrismaClient;
  storage: ObjectStorage;
  /**
   * An API client acting as the given user, or `null` when the deployment has
   * no service-token secret. The PDF is uploaded through it rather than written
   * straight into storage, so it passes the same permission check, magic-byte
   * sniff and quota an uploaded file does (ADR-014) -- and so the text
   * extraction runs over it, which is how an agent inspects the result.
   */
  apiClientFor: ((userId: string) => ExocortexApiClient) | null;
  settings: (workspaceId?: string) => Promise<Settings>;
  bus: RedisEventBus;
}

/** How often the worker renews its heartbeat and re-reads the cancel flag. */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** The largest single asset that is worth carrying into a build. */
const MAX_ASSET_BYTES = 50_000_000;

/**
 * The largest SyncTeX map worth keeping, uncompressed.
 *
 * A map is roughly proportional to the document, and a thesis produces a few
 * megabytes. Past this it stops being something anybody reads and starts being
 * something the text extraction has to chew through on every build.
 */
const MAX_SOURCE_MAP_BYTES = 20_000_000;

/**
 * Builds one project into one PDF (issue #43, ADR-027).
 *
 * Shaped after the render processor, because the two answer the same questions:
 * only a `PENDING` build is picked up, so a redelivered job is a no-op rather
 * than a second container; a crash leaves a `RUNNING` row whose heartbeat stops
 * and `reap-project-builds` closes it; and every failure is a terminal status
 * with the log attached, never a throw, because a document that does not
 * compile is the ordinary way this ends.
 *
 * What is different is the output: a project build produces a PDF, a SyncTeX
 * map and a parsed list of diagnostics, and the list is the part the agent loop
 * turns on. A build that failed and said only "it failed" would be a loop that
 * cannot close.
 */
export function createProjectBuildProcessor(dependencies: ProjectBuildDependencies) {
  const { prisma, bus } = dependencies;

  return async ({
    payload,
    logger,
  }: JobContext<typeof QUEUE_NAMES.projectBuild>): Promise<void> => {
    const build = await prisma.projectBuild.findUnique({
      where: { id: payload.buildId },
      select: BUILD_SELECT,
    });

    if (build === null) {
      logger.info('Project build vanished before it started', { buildId: payload.buildId });
      return;
    }
    if (build.status !== 'PENDING') {
      logger.info('Project build is not pending; skipping', {
        buildId: build.id,
        status: build.status,
      });
      return;
    }
    if (build.cancelledAt !== null) {
      await finish(prisma, bus, build.id, {
        status: 'CANCELLED',
        workspaceId: build.workspaceId,
        projectId: build.projectId,
        correlationId: payload.correlationId,
      });
      return;
    }

    await prisma.projectBuild.update({
      where: { id: build.id },
      data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date() },
    });
    await publish(bus, {
      workspaceId: build.workspaceId,
      correlationId: payload.correlationId,
      buildId: build.id,
      projectId: build.projectId,
      status: 'RUNNING',
    });

    await run({ dependencies, build, correlationId: payload.correlationId, logger });
  };
}

const BUILD_SELECT = {
  id: true,
  status: true,
  workspaceId: true,
  projectId: true,
  projectTitle: true,
  rootFile: true,
  engine: true,
  bibliography: true,
  cancelledAt: true,
  createdById: true,
} satisfies Prisma.ProjectBuildSelect;

type BuildRow = Prisma.ProjectBuildGetPayload<{ select: typeof BUILD_SELECT }>;

/** Everything between "this build is mine" and a terminal status. */
async function run(context: {
  dependencies: ProjectBuildDependencies;
  build: BuildRow;
  correlationId: string;
  logger: { info: (message: string, meta?: Record<string, unknown>) => void };
}): Promise<void> {
  const { dependencies, build, correlationId, logger } = context;
  const { prisma, bus } = dependencies;
  const startedAt = Date.now();

  const fail = async (errorCode: string, log: string | null): Promise<void> => {
    await finish(prisma, bus, build.id, {
      status: 'FAILED',
      errorCode,
      log,
      durationMs: Date.now() - startedAt,
      workspaceId: build.workspaceId,
      projectId: build.projectId,
      correlationId,
    });
  };

  const settings = await dependencies.settings(build.workspaceId);
  if (!settings['projects.enabled']) {
    await fail(
      'builder_unavailable',
      '[project] LaTeX builds are switched off for this workspace.',
    );
    return;
  }
  if (build.projectId === null) {
    await fail('project_missing', null);
    return;
  }

  const project = await loadProjectBuildInput(prisma, build.projectId);
  if (project === null) {
    await fail('project_missing', null);
    return;
  }
  if (!project.materialized) {
    await fail('project_not_materialized', null);
    return;
  }
  if (!project.texts.some((file) => file.path === build.rootFile)) {
    await fail('root_file_missing', null);
    return;
  }

  const collected = await collectFiles(dependencies, project);
  const controller = new AbortController();
  const heartbeat = startHeartbeat(prisma, build.id, controller);

  try {
    const result = await runProjectBuild({
      image: settings['projects.image'],
      files: collected.files,
      rootFile: build.rootFile,
      engine: build.engine,
      bibliography: build.bibliography,
      timeoutMs: settings['projects.timeoutSeconds'] * 1_000,
      maxArtifactBytes: settings['projects.maxArtifactBytes'],
      signal: controller.signal,
    });

    const log = [collected.notes, result.log].filter((part) => part.length > 0).join('\n');
    const diagnostics = parseLatexLog(
      log,
      project.texts.map((file) => file.path),
    );
    const outcome = classify(result);

    if (outcome !== 'ok') {
      await finish(prisma, bus, build.id, {
        status: outcome === 'cancelled' ? 'CANCELLED' : 'FAILED',
        errorCode: outcome === 'cancelled' ? undefined : outcome,
        log,
        diagnostics,
        durationMs: Date.now() - startedAt,
        workspaceId: build.workspaceId,
        projectId: build.projectId,
        correlationId,
      });
      return;
    }

    const client =
      dependencies.apiClientFor === null || build.createdById === null
        ? null
        : dependencies.apiClientFor(build.createdById);
    if (client === null || result.pdf === null) {
      await fail('builder_unavailable', log);
      return;
    }

    const base = filenameFor(build.projectTitle ?? project.title);
    const uploaded = await client.upload({
      path: `/api/workspaces/${build.workspaceId}/attachments`,
      filename: `${base}.pdf`,
      contentType: 'application/pdf',
      bytes: result.pdf,
      fields: { documentId: build.projectId },
      responseSchema: uploadAttachmentResponseSchema,
    });

    const sourceMapId = await storeSourceMap({
      client,
      sourceMap: result.sourceMap,
      workspaceId: build.workspaceId,
      projectId: build.projectId,
      filename: `${base}.synctex`,
      logger,
      buildId: build.id,
    });

    await finish(prisma, bus, build.id, {
      status: 'COMPLETED',
      log,
      diagnostics,
      attachmentId: uploaded.attachment.id,
      sourceMapAttachmentId: sourceMapId,
      pageCount: readPageCount(log),
      durationMs: Date.now() - startedAt,
      workspaceId: build.workspaceId,
      projectId: build.projectId,
      correlationId,
    });

    logger.info('Project build completed', {
      buildId: build.id,
      attachmentId: uploaded.attachment.id,
      byteSize: result.pdf.length,
      warnings: diagnostics.filter((entry) => entry.severity === 'WARNING').length,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * The bytes that go into the archive.
 *
 * An asset is read from object storage directly rather than over HTTP: the
 * container has no network, so the bytes travel in the archive either way, and
 * a loopback request for a file this process can already read would only add a
 * way to fail. One that cannot be read is left out with a note in the log
 * instead of failing the build, because a missing figure is something LaTeX
 * reports better than we can.
 */
async function collectFiles(
  dependencies: ProjectBuildDependencies,
  project: ProjectBuildInput,
): Promise<{ files: ProjectRunFile[]; notes: string }> {
  const encoder = new TextEncoder();
  const files: ProjectRunFile[] = project.texts.map((file) => ({
    path: file.path,
    content: encoder.encode(file.content),
  }));
  const notes: string[] = [];

  for (const asset of project.assets) {
    if (asset.byteSize > MAX_ASSET_BYTES) {
      notes.push(`[project] ${asset.path} is too large for the build and was left out.`);
      continue;
    }
    try {
      const stream = await dependencies.storage.getObject({ key: asset.storageKey });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      files.push({ path: asset.path, content: Buffer.concat(chunks) });
    } catch {
      notes.push(`[project] ${asset.path} could not be read and is missing from the build.`);
    }
  }

  return { files, notes: notes.join('\n') };
}

/**
 * Renews the heartbeat and watches for a cancel while the build runs.
 *
 * A failed heartbeat is swallowed on purpose: the reaper closes a build whose
 * worker really is gone, and throwing away a finished PDF over one slow query
 * would be the worse trade.
 */
function startHeartbeat(
  prisma: PrismaClient,
  buildId: string,
  controller: AbortController,
): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      const current = await prisma.projectBuild.update({
        where: { id: buildId },
        data: { heartbeatAt: new Date() },
        select: { cancelledAt: true },
      });
      if (current.cancelledAt !== null) controller.abort();
    })().catch(() => {
      // See the doc comment: a missed heartbeat is not a reason to stop.
    });
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * What the container's exit means, in one word.
 *
 * The order matters and is easy to get wrong: a cancelled build also looks
 * killed, a timed-out one also produced no file, and a missing image also exits
 * non-zero. First reason wins.
 */
function classify(
  result: ProjectRunResult,
):
  | 'ok'
  | 'cancelled'
  | 'builder_unavailable'
  | 'build_timeout'
  | 'artifact_too_large'
  | 'empty_artifact'
  | 'build_failed' {
  if (result.cancelled) return 'cancelled';
  if (result.unavailable) return 'builder_unavailable';
  if (result.timedOut) return 'build_timeout';
  if (result.tooLarge) return 'artifact_too_large';
  if (result.pdf === null) return result.exitCode === 0 ? 'empty_artifact' : 'build_failed';
  return 'ok';
}

/**
 * How many pages the PDF has, according to the engine that wrote it.
 *
 * Read out of the log rather than out of the file. Counting `/Type /Page` in
 * the bytes is the obvious thing and it is wrong: every current TeX engine
 * writes its page objects into a compressed object stream, so the pattern does
 * not appear at all and the count comes back as zero for every document. The
 * engine states the number in one line, and that line is already in the log the
 * build keeps.
 *
 * Null when the log does not say, which the API reports as unknown rather than
 * as zero.
 */
export function readPageCount(log: string): number | null {
  // `Output written on .exocortex-out/main.pdf (12 pages, 340991 bytes).`
  const matches = [...log.matchAll(/Output written on .*?\((\d+) pages?,/g)];
  const last = matches.at(-1);
  if (last === undefined) return null;
  const count = Number.parseInt(last[1] as string, 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}

/**
 * Stores the SyncTeX map beside the PDF, uncompressed.
 *
 * Uncompressed on purpose. The map is what resolves a position in the PDF back
 * to a file and a line, and a `.gz` is a blob nobody can look inside: stored as
 * text it is an ordinary attachment whose *content* an agent can read with
 * `exo_attachment_read_text`, which is the only reason exposing it is worth
 * anything. It also sidesteps the attachment allowlist, which does not accept
 * `application/gzip` -- and should not start to, to carry one derived file.
 *
 * A failure here is logged and does not fail the build: the PDF is the thing
 * that was asked for. It is *logged*, though. The first version swallowed the
 * error, and the upload was rejected for its content type on every single build
 * while the log said nothing at all.
 */
async function storeSourceMap(input: {
  client: ExocortexApiClient;
  sourceMap: Buffer | null;
  workspaceId: string;
  projectId: string;
  filename: string;
  logger: { info: (message: string, meta?: Record<string, unknown>) => void };
  buildId: string;
}): Promise<string | null> {
  if (input.sourceMap === null) return null;

  let text: Buffer;
  try {
    text = gunzipSync(input.sourceMap);
  } catch (error) {
    input.logger.info('SyncTeX map could not be read', {
      buildId: input.buildId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (text.byteLength > MAX_SOURCE_MAP_BYTES) {
    input.logger.info('SyncTeX map is too large to store', {
      buildId: input.buildId,
      byteSize: text.byteLength,
    });
    return null;
  }

  try {
    const stored = await input.client.upload({
      path: `/api/workspaces/${input.workspaceId}/attachments`,
      filename: input.filename,
      contentType: 'text/plain',
      bytes: text,
      fields: { documentId: input.projectId },
      responseSchema: uploadAttachmentResponseSchema,
    });
    return stored.attachment.id;
  } catch (error) {
    input.logger.info('SyncTeX map could not be stored', {
      buildId: input.buildId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** A file name a person recognises in their downloads folder. */
function filenameFor(title: string): string {
  const base = title
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return base.length === 0 ? 'projekt' : base;
}

async function finish(
  prisma: PrismaClient,
  bus: RedisEventBus,
  buildId: string,
  input: {
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
    errorCode?: string;
    log?: string | null;
    diagnostics?: readonly ProjectDiagnostic[];
    attachmentId?: string;
    sourceMapAttachmentId?: string | null;
    pageCount?: number | null;
    durationMs?: number;
    workspaceId: string;
    projectId: string | null;
    correlationId: string;
  },
): Promise<void> {
  await prisma.projectBuild.update({
    where: { id: buildId },
    data: {
      status: input.status,
      errorCode: input.errorCode ?? null,
      log:
        input.log === undefined || input.log === null
          ? undefined
          : input.log.slice(-PROJECT_MAX_LOG_CHARS),
      diagnostics:
        input.diagnostics === undefined
          ? undefined
          : (input.diagnostics as unknown as Prisma.InputJsonValue),
      attachmentId: input.attachmentId,
      sourceMapAttachmentId: input.sourceMapAttachmentId ?? undefined,
      pageCount: input.pageCount ?? undefined,
      finishedAt: new Date(),
      durationMs: input.durationMs,
      heartbeatAt: null,
    },
  });
  await publish(bus, {
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    buildId,
    projectId: input.projectId,
    status: input.status,
    errorCode: input.errorCode ?? null,
  });
}

async function publish(
  bus: RedisEventBus,
  input: {
    workspaceId: string;
    correlationId: string;
    buildId: string;
    projectId: string | null;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    errorCode?: string | null;
  },
): Promise<void> {
  await bus.publish({
    type: 'project.build.updated',
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    emittedAt: new Date().toISOString(),
    payload: {
      buildId: input.buildId,
      projectId: input.projectId,
      status: input.status,
      errorCode: input.errorCode ?? null,
    },
  });
}
