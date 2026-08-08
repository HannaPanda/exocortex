import {
  createAiProvider,
  createImageGenerator,
  createOptionalDoclingPdfExtractor,
  createPdfDocumentInfoReader,
  createPdfTextExtractor,
  createVisionPreprocessor,
  type ImageGenerator,
  type PdfTextExtractor,
  type VisionPreprocessor,
} from '@exocortex/ai';
import { issueServiceToken } from '@exocortex/auth';
import { loadWorkerEnv } from '@exocortex/config';
import {
  AI_QUEUE_LOCK_DURATION_MS,
  AI_QUEUE_STALLED_INTERVAL_MS,
  QUEUE_NAMES,
  resolveSettings,
  type Settings,
} from '@exocortex/contracts';
import { createPrismaClient, PostgresSearchAdapter } from '@exocortex/database';
import { createCorrelationId, createLogger } from '@exocortex/logger';
import { createFetchApiClient } from '@exocortex/mcp-tools';
import { createTypedWorker, QueueRegistry, RedisEventBus } from '@exocortex/queue';
import { S3ObjectStorage } from '@exocortex/storage';

import { createAiRunProcessor, type ResolvedModelRow } from './processors/ai-run';
import { createAttachmentTextProcessor } from './processors/attachment-text';
import { createCalendarSyncProcessor } from './processors/calendar-sync';
import { createDocumentCoverProcessor } from './processors/document-cover';
import { createIndexDocumentProcessor } from './processors/index-document';
import { createMaintenanceProcessor } from './processors/maintenance';
import { createMaterializeDocumentProcessor } from './processors/materialize-document';
import { createToolRunner } from './tool-runner';

/**
 * Worker process.
 *
 * Expensive work never happens inside an API request handler. Every processor is
 * idempotent, reports progress and lets failures bubble up so BullMQ applies the
 * configured retry policy.
 */
async function bootstrap(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({
    name: 'worker',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });

  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const queues = new QueueRegistry({ redisUrl: env.REDIS_URL, logger });
  const bus = new RedisEventBus({ redisUrl: env.REDIS_URL, logger });
  const search = new PostgresSearchAdapter(prisma);
  const provider = createAiProvider({
    providerId: env.AI_PROVIDER,
    logger,
    appUrl: env.APP_URL,
    openRouter: {
      apiKey: env.OPENROUTER_API_KEY ?? '',
      baseUrl: env.OPENROUTER_BASE_URL,
      defaultModel: env.OPENROUTER_DEFAULT_MODEL,
    },
  });
  const storage = new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    logger,
  });

  // Settings: DB rows override env, env stays the bootstrap fallback (D4). The
  // worker reads the `setting` table directly through Prisma with the same
  // `resolveSettings()` helper the API's `SettingsService` uses, cached for the
  // same 15s so the tool loop does not re-query per turn.
  const SETTINGS_CACHE_TTL_MS = 15_000;
  let settingsCache: { settings: Settings; expiresAt: number } | null = null;
  const readSettings = async (): Promise<Settings> => {
    const now = Date.now();
    if (settingsCache !== null && settingsCache.expiresAt > now) {
      return settingsCache.settings;
    }
    const rows = await prisma.setting.findMany({ select: { key: true, value: true } });
    const { settings, invalidKeys } = resolveSettings({ rows, env: process.env });
    if (invalidKeys.length > 0) {
      logger.warn('Dropped invalid setting rows while resolving settings', { invalidKeys });
    }
    settingsCache = { settings, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    return settings;
  };

  // Tool loop authentication (D3): `SERVICE_TOKEN_SECRET` is optional, so an
  // unset secret disables tools without ever crashing boot (R2).
  const toolRunnerFactory =
    env.SERVICE_TOKEN_SECRET === undefined
      ? null
      : (input: { userId: string; includeMutating: boolean; toolCallTimeoutMs: number }) =>
          createToolRunner({
            apiUrl: env.API_URL,
            serviceTokenSecret: env.SERVICE_TOKEN_SECRET!,
            serviceTokenTtlSeconds: env.SERVICE_TOKEN_TTL_SECONDS,
            userId: input.userId,
            includeMutating: input.includeMutating,
            toolCallTimeoutMs: input.toolCallTimeoutMs,
            logger,
          });

  /**
   * An API client acting as one particular human, for a processor that has to
   * write through the REST API rather than the database (ADR-014).
   *
   * Same seam as the tool loop above: no secret means no client, and the
   * processor reports the feature as unavailable instead of failing per job. A
   * token is minted per call because a job is rare and short, unlike the tool
   * loop's many calls inside one run.
   */
  const apiClientFor =
    env.SERVICE_TOKEN_SECRET === undefined
      ? null
      : (userId: string) =>
          createFetchApiClient({
            baseUrl: env.API_URL,
            token: issueServiceToken({
              secret: env.SERVICE_TOKEN_SECRET!,
              userId,
              purpose: 'ai-tools',
              ttlSeconds: env.SERVICE_TOKEN_TTL_SECONDS,
            }).token,
          });

  /**
   * Which environment key a calendar account's credentials may be read from.
   *
   * The indirection is the point of `credentialRef`: rotating a password never
   * touches the row. But a dynamic env lookup driven by a database value is also
   * a way to read *any* variable, and whatever it reads is sent to a remote
   * server in an Authorization header -- so a hand-edited row pointing at
   * `DATABASE_URL` would exfiltrate it. The pattern is the boundary that stops
   * that, and it is checked here rather than at write time because this is the
   * only place that dereferences the name.
   */
  const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]*_(PASSWORD|TOKEN|SECRET)$/;

  const resolveCalendarCredentials = (account: {
    provider: string;
    username: string;
    credentialRef: string;
    baseUrl: string | null;
  }): { baseUrl: string; username: string; password: string } | null => {
    if (!CREDENTIAL_REF_PATTERN.test(account.credentialRef)) {
      logger.error('Calendar account credentialRef is not an allowed environment key', {
        credentialRef: account.credentialRef,
      });
      return null;
    }
    const password = process.env[account.credentialRef];
    const baseUrl = account.baseUrl ?? env.MAILBOX_CALDAV_URL ?? null;
    if (password === undefined || password.trim().length === 0 || baseUrl === null) return null;
    return { baseUrl, username: account.username, password };
  };

  // Image generation: the model comes from the settings, so an admin can point
  // it at a different one without a restart; the generators are cached per slug
  // exactly like the vision companions below.
  const imageGeneratorCache = new Map<string, ImageGenerator | null>();
  const imageGeneratorFor = (modelSlug: string | null): ImageGenerator | null => {
    const cacheKey = modelSlug ?? '';
    if (!imageGeneratorCache.has(cacheKey)) {
      imageGeneratorCache.set(
        cacheKey,
        createImageGenerator({
          providerId: env.AI_PROVIDER,
          logger,
          appUrl: env.APP_URL,
          apiKey: env.OPENROUTER_API_KEY ?? '',
          baseUrl: env.OPENROUTER_BASE_URL,
          model: modelSlug,
        }),
      );
    }
    return imageGeneratorCache.get(cacheKey) ?? null;
  };

  // Vision companions (ADR-012): a per-model factory, cached, so a run can pass
  // its own companion slug (conversation override, or the model row's admin
  // default) instead of only ever the one env-configured model.
  const visionPreprocessorCache = new Map<string, VisionPreprocessor | null>();
  const visionPreprocessorFor = (modelSlug: string | null): VisionPreprocessor | null => {
    const effectiveModel = modelSlug ?? env.OPENROUTER_VISION_MODEL;
    const cacheKey = effectiveModel ?? '';
    if (!visionPreprocessorCache.has(cacheKey)) {
      visionPreprocessorCache.set(
        cacheKey,
        createVisionPreprocessor({
          logger,
          appUrl: env.APP_URL,
          apiKey: env.OPENROUTER_API_KEY ?? '',
          baseUrl: env.OPENROUTER_BASE_URL,
          model: effectiveModel,
        }),
      );
    }
    return visionPreprocessorCache.get(cacheKey) ?? null;
  };

  // The PDF's own metadata dictionary, read locally from the file. Not an
  // engine and not part of the chain below: it produces no text, and it must
  // stay independent of which engine does, so that choosing the free local
  // engine does not cost the title, the author and the dates.
  const pdfDocumentInfo = createPdfDocumentInfoReader({ logger });

  // PDF text extraction (D6): built once at boot from the main driver model --
  // the OpenRouter file-parser plugin works with any model, so the deployment
  // does not need a dedicated env var for it. `ai.pdfExtractionModelSlug`
  // (DB-configurable) is not yet wired here: doing so would mean rebuilding the
  // extractor per job the way `visionPreprocessorFor` does, which is a
  // reasonable follow-up but out of scope for tonight (see docs/ai-architecture.md).
  const openRouterPdfExtractor = createPdfTextExtractor({
    apiKey: env.OPENROUTER_API_KEY ?? '',
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_DEFAULT_MODEL,
    appUrl: env.APP_URL,
    logger,
  });

  // Local Docling instance. Null unless DOCLING_BASE_URL is set, which is what
  // keeps the ~7.7 GB container optional for a deployment that does not need OCR.
  const doclingPdfExtractor = createOptionalDoclingPdfExtractor({
    baseUrl: env.DOCLING_BASE_URL,
    logger,
  });

  /**
   * Engines to try, in order, for one PDF.
   *
   * The setting names the primary; the other engine backs it up, in either
   * direction. The symmetry matters both ways: Docling first needs the hosted
   * engine for the day the container is down, and OpenRouter first needs
   * Docling for every scan.
   *
   * Both factories return null when their side is unconfigured, and an empty
   * chain is how the processor learns that PDF extraction is unavailable -- so
   * a deployment with neither says so plainly instead of failing per document.
   */
  const pdfExtractorChain = (settings: Settings): readonly PdfTextExtractor[] => {
    const [primary, fallback] =
      settings['ai.pdfExtractor'] === 'openrouter'
        ? [openRouterPdfExtractor, doclingPdfExtractor]
        : [doclingPdfExtractor, openRouterPdfExtractor];
    const chain: PdfTextExtractor[] = [];
    if (primary !== null) chain.push(primary);
    if (settings['ai.pdfExtractorFallbackEnabled'] && fallback !== null) chain.push(fallback);
    return chain;
  };

  const modelRegistry = async (slug: string): Promise<ResolvedModelRow | null> => {
    const row = await prisma.aiModel.findUnique({
      where: { slug },
      include: { visionCompanion: { select: { slug: true } } },
    });
    if (row === null) return null;
    return {
      id: row.id,
      slug: row.slug,
      provider: row.provider,
      contextWindowTokens: row.contextWindowTokens,
      maxOutputTokens: row.maxOutputTokens,
      supportsVision: row.supportsVision,
      supportsTools: row.supportsTools,
      reasoningLevels: row.reasoningLevels,
      visionCompanionSlug: row.visionCompanion?.slug ?? null,
    };
  };

  /**
   * Publishes a `job.progress` event so the UI can show live progress.
   *
   * `attachment-text` and `document-cover` are deliberately excluded:
   * `jobProgressPayloadSchema.queue` (frozen in `packages/contracts`) only ever
   * accepted the four original queues, and this helper is in fact only ever
   * called for materialization. Cover generation reports its own outcome
   * through `document.cover.generated` instead.
   */
  const publishProgress = async (
    queue: Exclude<
      (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES],
      | typeof QUEUE_NAMES.attachmentText
      | typeof QUEUE_NAMES.documentCover
      // The calendar sync has no workspace in its payload and no browser
      // waiting on it, so it reports nothing over the progress channel.
      | typeof QUEUE_NAMES.calendarSync
    >,
    workspaceId: string,
    correlationId: string,
    jobId: string,
    progress: number,
    label: string,
    documentId: string | null,
  ): Promise<void> => {
    await bus.publish({
      type: 'job.progress',
      workspaceId,
      correlationId,
      emittedAt: new Date().toISOString(),
      payload: { jobId, queue, progress, label, documentId },
    });
  };

  const materialization = createTypedWorker({
    name: QUEUE_NAMES.documentMaterialization,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 4,
    handler: createMaterializeDocumentProcessor({ prisma, queues, bus }),
    onProgress: async (payload, progress, label, job) => {
      await publishProgress(
        QUEUE_NAMES.documentMaterialization,
        payload.workspaceId,
        payload.correlationId,
        job.id ?? '',
        progress,
        label,
        payload.documentId,
      );
    },
    onCompleted: async (payload, job, durationMs) => {
      await bus.publish({
        type: 'job.completed',
        workspaceId: payload.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: {
          jobId: job.id ?? '',
          queue: QUEUE_NAMES.documentMaterialization,
          progress: 100,
          label: 'Seite verarbeitet',
          documentId: payload.documentId,
          durationMs,
        },
      });
    },
    onFailed: async (payload, job, error) => {
      if (payload === null) return;
      await bus.publish({
        type: 'job.failed',
        workspaceId: payload.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: {
          jobId: job?.id ?? '',
          queue: QUEUE_NAMES.documentMaterialization,
          progress: 0,
          label: 'Seite konnte nicht verarbeitet werden',
          documentId: payload.documentId,
          reason: error.message,
          attemptsMade: job?.attemptsMade ?? 0,
          willRetry: (job?.attemptsMade ?? 0) < (job?.opts.attempts ?? 1),
        },
      });
    },
  });

  const indexing = createTypedWorker({
    name: QUEUE_NAMES.searchIndexing,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 4,
    handler: createIndexDocumentProcessor({ prisma, search }),
  });

  const ai = createTypedWorker({
    name: QUEUE_NAMES.ai,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 2,
    // A run's own budget (`ai.maxRunMs`) can run into the minutes, so the
    // queue's lock has to comfortably outlast it; `stalledInterval` follows
    // the same reasoning (see `packages/contracts/src/ai-runtime.ts`).
    lockDuration: AI_QUEUE_LOCK_DURATION_MS,
    stalledInterval: AI_QUEUE_STALLED_INTERVAL_MS,
    handler: createAiRunProcessor({
      prisma,
      provider,
      bus,
      storage,
      settings: readSettings,
      toolRunnerFactory,
      visionPreprocessorFor,
      modelRegistry,
    }),
    onFailed: async (payload, job, error) => {
      if (payload === null) return;
      logger.error('AI job failed', error, { runId: payload.runId, jobId: job?.id });

      // `createAiRunProcessor` never throws on a provider or timeout failure --
      // it writes a terminal status itself -- so landing here at all means an
      // infrastructure error (crashed process, lost database connection) left
      // the row on PENDING or RUNNING. Second rescue path alongside the
      // maintenance reaper (`reap-stale-ai-runs`), and a faster one: this
      // fires the moment BullMQ gives up rather than on the reaper's
      // up-to-a-minute cycle. Guarded on attempts exhausted, since the `ai`
      // queue's `attempts: 1` still leaves this the only attempt anyway.
      const attemptsAllowed = job?.opts.attempts ?? 1;
      if (job !== undefined && job.attemptsMade < attemptsAllowed) return;
      const closed = await prisma.aiRun.updateMany({
        where: { id: payload.runId, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'FAILED', errorCode: 'ai_run_abandoned', finishedAt: new Date() },
      });
      if (closed.count === 1) {
        await bus.publish({
          type: 'ai.run.failed',
          workspaceId: payload.workspaceId,
          correlationId: payload.correlationId,
          emittedAt: new Date().toISOString(),
          payload: {
            runId: payload.runId,
            status: 'failed',
            errorCode: 'ai_run_abandoned',
            reason: 'The job failed and BullMQ has no attempts left',
          },
        });
      }
    },
  });

  const maintenance = createTypedWorker({
    name: QUEUE_NAMES.maintenance,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createMaintenanceProcessor({ prisma, queues, storage, bus, settings: readSettings }),
  });

  // Concurrency 1: PDF extraction is an external call and must not crowd out
  // document materialization.
  const attachmentText = createTypedWorker({
    name: QUEUE_NAMES.attachmentText,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createAttachmentTextProcessor({
      prisma,
      storage,
      extractors: pdfExtractorChain,
      documentInfo: pdfDocumentInfo,
      settings: readSettings,
    }),
    onFailed: async (payload, job, error) => {
      if (payload === null) return;
      logger.error('Attachment text extraction job failed', error, {
        attachmentId: payload.attachmentId,
        jobId: job?.id,
      });

      // Once BullMQ is out of retries the row would otherwise stay PENDING for
      // good, and `GET /attachments/:id/text` only re-enqueues a FAILED or
      // NOT_APPLICABLE one -- so the attachment would report "extraction is
      // still running" forever with nothing left to run it.
      const attempts = job?.opts.attempts ?? 0;
      if (job !== undefined && job.attemptsMade >= attempts) {
        await prisma.attachment.updateMany({
          where: { id: payload.attachmentId, textStatus: 'PENDING' },
          data: {
            textStatus: 'FAILED',
            textExtractionError: `Extraction failed after ${job.attemptsMade} attempts: ${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 500),
          },
        });
      }
    },
  });

  // Concurrency 1: an image model is slow, expensive and rate limited, and a
  // page has exactly one cover -- there is nothing to gain from drawing two at
  // once, and a burst would only hit the provider's limit.
  const documentCover = createTypedWorker({
    name: QUEUE_NAMES.documentCover,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createDocumentCoverProcessor({
      imageGeneratorFor,
      apiClientFor,
      bus,
      settings: readSettings,
    }),
  });

  // Concurrency 1: this talks to someone else's mail server. Two passes over the
  // same account would race on the sync token, and a parallel burst per calendar
  // is how a sync gets itself rate limited.
  const calendarSync = createTypedWorker({
    name: QUEUE_NAMES.calendarSync,
    redisUrl: env.REDIS_URL,
    logger,
    concurrency: 1,
    handler: createCalendarSyncProcessor({
      prisma,
      apiClientFor,
      credentialsFor: resolveCalendarCredentials,
    }),
  });

  await queues.scheduleMaintenance(createCorrelationId());
  await queues.scheduleCalendarSync(createCorrelationId());

  logger.info('Worker started', {
    environment: env.NODE_ENV,
    queues: Object.values(QUEUE_NAMES),
    aiProvider: provider.id,
    tools: toolRunnerFactory !== null,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down worker', { signal });
    try {
      // `close()` waits for in-flight jobs, so no job is lost on deploy.
      await Promise.all([
        materialization.worker.close(),
        indexing.worker.close(),
        ai.worker.close(),
        maintenance.worker.close(),
        attachmentText.worker.close(),
        documentCover.worker.close(),
        calendarSync.worker.close(),
      ]);
      await Promise.all([
        materialization.connection.quit(),
        indexing.connection.quit(),
        ai.connection.quit(),
        maintenance.connection.quit(),
        attachmentText.connection.quit(),
        documentCover.connection.quit(),
        calendarSync.connection.quit(),
      ]);
      await bus.close();
      await queues.close();
      await prisma.$disconnect();
      logger.info('Worker stopped cleanly');
      process.exit(0);
    } catch (error) {
      logger.fatal('Graceful shutdown failed', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });
}

void bootstrap().catch((error: unknown) => {
  console.error('Failed to start the worker:', error);
  process.exit(1);
});
