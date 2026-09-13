import {
  type QUEUE_NAMES,
  RENDER_MAX_LOG_CHARS,
  renderErrorMessage,
  type Settings,
  uploadAttachmentResponseSchema,
} from '@exocortex/contracts';
import { loadRenderSource, type Prisma, type PrismaClient } from '@exocortex/database';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { type LatexRunResult, runLatexPdf } from './render/latex-runner';
import {
  bindAssetName,
  buildMetadataYaml,
  collectAttachmentImages,
  dropAsset,
  flattenWikiLinks,
} from './render/prepare';

export interface RenderDependencies {
  prisma: PrismaClient;
  storage: ObjectStorage;
  /**
   * An API client acting as the given user, or `null` when the deployment has
   * no service-token secret. The finished PDF is uploaded through it rather
   * than written straight into storage, so it passes the same permission check,
   * magic-byte sniff and quota an uploaded file does (ADR-014).
   */
  apiClientFor: ((userId: string) => ExocortexApiClient) | null;
  settings: (workspaceId?: string) => Promise<Settings>;
  bus: RedisEventBus;
}

/** How often the worker renews its heartbeat and re-reads the cancel flag. */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** The largest image that is worth putting into a PDF. */
const MAX_ASSET_BYTES = 20_000_000;

/** Images one document may carry into a build. */
const MAX_ASSETS = 50;

/**
 * Builds one page into one file (issue #44, ADR-026).
 *
 * The processor owns none of the decisions: which template, which variables and
 * which source were decided by the API when it accepted the request and are
 * written on the job row. What happens here is the part that must not happen in
 * a request -- Pandoc and TeX Live in a container, for as long as they take.
 *
 * Idempotent in the way an expensive job has to be: only a `PENDING` job is
 * picked up, so a retried delivery of the same job finds it `RUNNING` or
 * finished and does nothing. A crash mid-build leaves a `RUNNING` row whose
 * heartbeat stops, and `reap-stale-render-jobs` closes it -- resuming is not
 * possible and pretending otherwise would produce two containers for one PDF.
 *
 * Every failure is a terminal status with the build log attached, never a throw:
 * a template that does not compile is the normal way this ends, and a retry
 * would compile it again to the same effect.
 */
export function createRenderProcessor(dependencies: RenderDependencies) {
  const { prisma, bus } = dependencies;

  return async ({ payload, logger }: JobContext<typeof QUEUE_NAMES.render>): Promise<void> => {
    const job = await prisma.renderJob.findUnique({
      where: { id: payload.jobId },
      select: JOB_SELECT,
    });

    if (job === null) {
      logger.info('Render job vanished before it started', { renderJobId: payload.jobId });
      return;
    }
    // Only a PENDING job is picked up, which is what makes a redelivered job a
    // no-op instead of a second container.
    if (job.status !== 'PENDING') {
      logger.info('Render job is not pending; skipping', {
        renderJobId: job.id,
        status: job.status,
      });
      return;
    }
    if (job.cancelledAt !== null) {
      await finish(prisma, bus, job.id, {
        status: 'CANCELLED',
        workspaceId: job.workspaceId,
        documentId: job.documentId,
        correlationId: payload.correlationId,
      });
      return;
    }

    await prisma.renderJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date() },
    });
    await publish(bus, {
      workspaceId: job.workspaceId,
      correlationId: payload.correlationId,
      jobId: job.id,
      documentId: job.documentId,
      status: 'RUNNING',
    });

    await build({ dependencies, job, correlationId: payload.correlationId, logger });
  };
}

const JOB_SELECT = {
  id: true,
  status: true,
  workspaceId: true,
  documentId: true,
  documentTitle: true,
  templateId: true,
  source: true,
  variables: true,
  cancelledAt: true,
  createdById: true,
  createdBy: { select: { name: true } },
} satisfies Prisma.RenderJobSelect;

type RenderJobRow = Prisma.RenderJobGetPayload<{ select: typeof JOB_SELECT }>;

/**
 * Everything between "this job is mine" and a terminal status.
 *
 * Its own function so the handler above stays a list of guards. What happens
 * here happens in one order and no other: read the settings, read what is to be
 * built, resolve the pictures, start the container, and write down what came of
 * it -- with the log attached either way, because the log is the only thing that
 * explains a failed build.
 */
async function build(context: {
  dependencies: RenderDependencies;
  job: RenderJobRow;
  correlationId: string;
  logger: { info: (message: string, meta?: Record<string, unknown>) => void };
}): Promise<void> {
  const { dependencies, job, correlationId, logger } = context;
  const { prisma, bus } = dependencies;
  const startedAt = Date.now();

  const fail = async (errorCode: string, log: string | null): Promise<void> => {
    await finish(prisma, bus, job.id, {
      status: 'FAILED',
      errorCode,
      log,
      durationMs: Date.now() - startedAt,
      workspaceId: job.workspaceId,
      documentId: job.documentId,
      correlationId,
    });
  };

  const inputs = await collectInputs(dependencies, job);
  if ('errorCode' in inputs) {
    await fail(inputs.errorCode, inputs.log ?? null);
    return;
  }
  const { documentId, settings, template, assembled, prepared } = inputs;

  const controller = new AbortController();
  const heartbeat = startHeartbeat(prisma, job.id, controller);

  try {
    const result = await runLatexPdf({
      image: settings['render.image'],
      markdown: `${prepared.markdown}\n`,
      metadataYaml: buildMetadataYaml({
        title: job.documentTitle ?? assembled.title,
        date: new Date().toISOString().slice(0, 10),
        author: job.createdBy?.name ?? '',
        variables: variableRecord(job.variables),
      }),
      template: template?.source ?? null,
      assets: prepared.assets,
      tableOfContents: job.source === 'SUBTREE',
      timeoutMs: settings['render.timeoutSeconds'] * 1_000,
      maxArtifactBytes: settings['render.maxArtifactBytes'],
      signal: controller.signal,
    });

    const log = [prepared.notes, result.log].filter((part) => part.length > 0).join('\n');
    const outcome = classify(result);

    if (outcome !== 'ok') {
      await finish(prisma, bus, job.id, {
        status: outcome === 'cancelled' ? 'CANCELLED' : 'FAILED',
        errorCode: outcome === 'cancelled' ? undefined : outcome,
        log,
        durationMs: Date.now() - startedAt,
        workspaceId: job.workspaceId,
        documentId: job.documentId,
        correlationId,
      });
      return;
    }

    // The finished PDF is uploaded as the person who asked for it, through the
    // ordinary attachment route (ADR-014): same permission check, same magic
    // bytes, same quota, and the same text extraction afterwards -- which is
    // what lets an agent read back what the build produced.
    const client =
      dependencies.apiClientFor === null || job.createdById === null
        ? null
        : dependencies.apiClientFor(job.createdById);
    if (client === null || result.pdf === null) {
      await fail('renderer_unavailable', log);
      return;
    }

    const uploaded = await client.upload({
      path: `/api/workspaces/${job.workspaceId}/attachments`,
      filename: filenameFor(job.documentTitle ?? assembled.title),
      contentType: 'application/pdf',
      bytes: result.pdf,
      fields: { documentId },
      responseSchema: uploadAttachmentResponseSchema,
    });

    await finish(prisma, bus, job.id, {
      status: 'COMPLETED',
      log,
      attachmentId: uploaded.attachment.id,
      durationMs: Date.now() - startedAt,
      workspaceId: job.workspaceId,
      documentId: job.documentId,
      correlationId,
    });

    logger.info('Render job completed', {
      renderJobId: job.id,
      attachmentId: uploaded.attachment.id,
      byteSize: result.pdf.length,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

interface BuildInputs {
  /** Narrowed here so the build path never has to re-check it. */
  documentId: string;
  settings: Settings;
  template: { source: string | null } | null;
  assembled: NonNullable<Awaited<ReturnType<typeof loadRenderSource>>>;
  prepared: PreparedDocument;
}

/**
 * Reads everything the container needs, or names the reason there is nothing to
 * build. Separate from `build` so the happy path there is one straight line.
 */
async function collectInputs(
  dependencies: RenderDependencies,
  job: RenderJobRow,
): Promise<BuildInputs | { errorCode: string; log?: string }> {
  const { prisma } = dependencies;
  const settings = await dependencies.settings(job.workspaceId);
  if (!settings['render.enabled']) {
    return {
      errorCode: 'renderer_unavailable',
      log: 'Die PDF-Ausgabe ist für diesen Arbeitsbereich aus.',
    };
  }
  if (job.documentId === null) return { errorCode: 'source_missing' };

  const template =
    job.templateId === null
      ? null
      : await prisma.renderTemplate.findUnique({
          where: { id: job.templateId },
          select: { source: true },
        });
  if (job.templateId !== null && template === null) return { errorCode: 'template_missing' };

  const assembled = await loadRenderSource(prisma, {
    documentId: job.documentId,
    source: job.source === 'SUBTREE' ? 'SUBTREE' : 'DOCUMENT',
  });
  if (assembled === null || assembled.text.trim().length === 0) {
    return { errorCode: 'source_missing' };
  }

  const prepared = await prepareDocument({
    prisma,
    storage: dependencies.storage,
    workspaceId: job.workspaceId,
    markdown: assembled.text,
  });

  return { documentId: job.documentId, settings, template, assembled, prepared };
}

/**
 * Renews the job's heartbeat and watches for a cancel while the build runs.
 *
 * A failed heartbeat is deliberately swallowed: the reaper closes a job whose
 * worker really is gone, and throwing away a finished build over one slow query
 * would be the worse trade.
 */
function startHeartbeat(
  prisma: PrismaClient,
  jobId: string,
  controller: AbortController,
): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      const current = await prisma.renderJob.update({
        where: { id: jobId },
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
 * Separate from the processor because the order matters and is easy to get
 * wrong: a cancelled build also looks killed, a timed-out one also produced no
 * file, and an unavailable image also exits non-zero. First reason wins.
 */
function classify(
  result: LatexRunResult,
):
  | 'ok'
  | 'cancelled'
  | 'renderer_unavailable'
  | 'render_timeout'
  | 'artifact_too_large'
  | 'empty_artifact'
  | 'render_failed' {
  if (result.cancelled) return 'cancelled';
  if (result.unavailable) return 'renderer_unavailable';
  if (result.timedOut) return 'render_timeout';
  if (result.tooLarge) return 'artifact_too_large';
  if (result.pdf === null) return result.exitCode === 0 ? 'empty_artifact' : 'render_failed';
  return 'ok';
}

/** A PDF name a person recognises in their downloads folder. */
function filenameFor(title: string): string {
  const base = title
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${base.length === 0 ? 'seite' : base}.pdf`;
}

function variableRecord(value: Prisma.JsonValue): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

interface PreparedDocument {
  markdown: string;
  assets: { name: string; bytes: Uint8Array }[];
  /** What was done to the document, prepended to the build log. */
  notes: string;
}

/**
 * Resolves the pictures a page refers to and flattens what Pandoc cannot read.
 *
 * An image is fetched from object storage directly rather than over HTTP: the
 * container has no network, so the bytes have to travel in the archive either
 * way, and a loopback request for a file this process can already read would
 * only add a way to fail. The workspace check is still made here, because a
 * page may not carry another workspace's file into a PDF.
 */
async function prepareDocument(input: {
  prisma: PrismaClient;
  storage: ObjectStorage;
  workspaceId: string;
  markdown: string;
}): Promise<PreparedDocument> {
  const collected = collectAttachmentImages(input.markdown);
  let markdown = collected.markdown;
  const assets: { name: string; bytes: Uint8Array }[] = [];
  const notes: string[] = [];

  for (const id of collected.attachmentIds.slice(0, MAX_ASSETS)) {
    const attachment = await input.prisma.attachment.findUnique({
      where: { id },
      select: {
        workspaceId: true,
        storageKey: true,
        mimeType: true,
        byteSize: true,
        deletedAt: true,
      },
    });

    if (
      attachment === null ||
      attachment.deletedAt !== null ||
      attachment.workspaceId !== input.workspaceId ||
      !attachment.mimeType.startsWith('image/') ||
      attachment.byteSize > MAX_ASSET_BYTES
    ) {
      markdown = dropAsset(markdown, id);
      notes.push(`[render] Bild ${id} konnte nicht eingebettet werden.`);
      continue;
    }

    try {
      const stream = await input.storage.getObject({ key: attachment.storageKey });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const filename = `${id}${extensionFor(attachment.mimeType)}`;
      assets.push({ name: filename, bytes: Buffer.concat(chunks) });
      markdown = bindAssetName(markdown, id, filename);
    } catch {
      markdown = dropAsset(markdown, id);
      notes.push(`[render] Bild ${id} ließ sich nicht laden.`);
    }
  }

  for (const id of collected.attachmentIds.slice(MAX_ASSETS)) {
    markdown = dropAsset(markdown, id);
    notes.push(`[render] Bild ${id} übersprungen: mehr als ${String(MAX_ASSETS)} Bilder.`);
  }

  return { markdown: flattenWikiLinks(markdown), assets, notes: notes.join('\n') };
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '.bin';
  }
}

async function finish(
  prisma: PrismaClient,
  bus: RedisEventBus,
  jobId: string,
  input: {
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
    errorCode?: string;
    log?: string | null;
    attachmentId?: string;
    durationMs?: number;
    workspaceId: string;
    documentId: string | null;
    correlationId: string;
  },
): Promise<void> {
  await prisma.renderJob.update({
    where: { id: jobId },
    data: {
      status: input.status,
      errorCode: input.errorCode ?? null,
      log:
        input.log === undefined || input.log === null
          ? undefined
          : input.log.slice(-RENDER_MAX_LOG_CHARS),
      attachmentId: input.attachmentId,
      finishedAt: new Date(),
      durationMs: input.durationMs,
      heartbeatAt: null,
    },
  });
  await publish(bus, {
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    jobId,
    documentId: input.documentId,
    status: input.status,
    error: renderErrorMessage(input.errorCode ?? null),
  });
}

async function publish(
  bus: RedisEventBus,
  input: {
    workspaceId: string;
    correlationId: string;
    jobId: string;
    documentId: string | null;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    error?: string | null;
  },
): Promise<void> {
  await bus.publish({
    type: 'render.job.updated',
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    emittedAt: new Date().toISOString(),
    payload: {
      jobId: input.jobId,
      documentId: input.documentId,
      status: input.status,
      error: input.error ?? null,
    },
  });
}
