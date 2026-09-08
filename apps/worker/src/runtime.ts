import {
  type AiProvider,
  createAiProvider,
  createEmbeddingClient,
  createEmbeddingProvider,
  createImageGenerator,
  createOptionalDoclingPdfExtractor,
  createPdfDocumentInfoReader,
  createPdfTextExtractor,
  createVisionPreprocessor,
  type ImageGenerator,
  type PdfDocumentInfoReader,
  type PdfTextExtractor,
  type VisionPreprocessor,
} from '@exocortex/ai';
import { issueServiceToken } from '@exocortex/auth';
import { type WorkerEnv } from '@exocortex/config';
import {
  type QUEUE_NAMES,
  resolveSettings,
  semanticSearchOptions,
  type Settings,
} from '@exocortex/contracts';
import {
  createPrismaClient,
  HybridSearchAdapter,
  PostgresSearchAdapter,
  type PrismaClient,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { createFetchApiClient, type ExocortexApiClient } from '@exocortex/mcp-tools';
import { QueueRegistry, RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage, S3ObjectStorage } from '@exocortex/storage';

import { createCommandNotifier } from './calendar/notifier';
import { type ResolvedModelRow } from './processors/ai-run';
import { type ToolRunner } from './tool-runner';
import { createToolRunner } from './tool-runner';

/**
 * Everything the worker's processors are handed, built once at boot.
 *
 * Separate from `main.ts` because wiring is not starting: this file answers
 * "what does this deployment have available" (a Docling container or not, a
 * service token or not, a reminder command or not), and `main.ts` answers
 * "which queues does it listen on". Every optional piece resolves to `null`
 * rather than throwing, so a missing line in `.env` never stops the boot.
 */
export interface WorkerRuntime {
  prisma: PrismaClient;
  queues: QueueRegistry;
  bus: RedisEventBus;
  provider: AiProvider;
  storage: ObjectStorage;
  search: HybridSearchAdapter;
  readSettings: () => Promise<Settings>;
  toolRunnerFactory:
    | ((input: {
        userId: string;
        includeMutating: boolean;
        toolCallTimeoutMs: number;
      }) => ToolRunner)
    | null;
  apiClientFor: ((userId: string) => ExocortexApiClient) | null;
  resolveCalendarCredentials: (account: {
    provider: string;
    username: string;
    credentialRef: string;
    baseUrl: string | null;
  }) => { baseUrl: string; username: string; password: string } | null;
  reminderNotifier: ReturnType<typeof createCommandNotifier> | null;
  imageGeneratorFor: (modelSlug: string | null) => ImageGenerator | null;
  visionPreprocessorFor: (modelSlug: string | null) => VisionPreprocessor | null;
  pdfDocumentInfo: PdfDocumentInfoReader;
  pdfExtractorChain: (settings: Settings) => readonly PdfTextExtractor[];
  modelRegistry: (slug: string) => Promise<ResolvedModelRow | null>;
  publishProgress: (event: JobProgressEvent) => Promise<void>;
}

/** The shape `publishProgress` accepts; see its doc comment below. */
export interface JobProgressEvent {
  queue: Exclude<
    (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES],
    | typeof QUEUE_NAMES.attachmentText
    | typeof QUEUE_NAMES.documentCover
    | typeof QUEUE_NAMES.calendarSync
    | typeof QUEUE_NAMES.memoryCapture
    | typeof QUEUE_NAMES.memoryConsolidate
  >;
  workspaceId: string;
  correlationId: string;
  jobId: string;
  progress: number;
  label: string;
  documentId: string | null;
}

export function createWorkerRuntime(env: WorkerEnv, logger: Logger): WorkerRuntime {
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const queues = new QueueRegistry({ redisUrl: env.REDIS_URL, logger });
  const bus = new RedisEventBus({ redisUrl: env.REDIS_URL, logger });
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

  /**
   * The search projection, both halves of it (issue #34, AP4).
   *
   * Built after `readSettings` because the semantic half is a runtime setting,
   * not a boot-time one: turning it on in the administration area has to reach
   * the next indexing job without a restart.
   */
  const search = new HybridSearchAdapter({
    prisma,
    keyword: new PostgresSearchAdapter(prisma),
    embeddings: createEmbeddingClient(
      createEmbeddingProvider({
        providerId: env.AI_PROVIDER,
        logger,
        appUrl: env.APP_URL,
        apiKey: env.OPENROUTER_API_KEY ?? '',
        baseUrl: env.OPENROUTER_BASE_URL,
      }),
    ),
    options: async () => semanticSearchOptions(await readSettings()),
    logger,
  });

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

  // Reminder delivery: both halves have to be configured, because a command
  // without a target and a target without a command are each half a setup. Unset
  // leaves reminders off however the settings are switched, the same shape as the
  // service-token seam above -- a missing line in `.env` never stops the boot.
  const reminderNotifier =
    env.CALENDAR_REMINDER_COMMAND === undefined || env.CALENDAR_REMINDER_TARGET === undefined
      ? null
      : createCommandNotifier({
          command: env.CALENDAR_REMINDER_COMMAND,
          target: env.CALENDAR_REMINDER_TARGET,
          logger,
        });

  const { imageGeneratorFor, visionPreprocessorFor, pdfDocumentInfo, pdfExtractorChain } =
    createMediaFactories(env, logger);

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
      inputMicroUsdPerMTok: row.inputMicroUsdPerMTok,
      outputMicroUsdPerMTok: row.outputMicroUsdPerMTok,
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
  const publishProgress = async (event: {
    queue: Exclude<
      (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES],
      | typeof QUEUE_NAMES.attachmentText
      | typeof QUEUE_NAMES.documentCover
      // The calendar sync has no workspace in its payload and no browser
      // waiting on it, so it reports nothing over the progress channel.
      | typeof QUEUE_NAMES.calendarSync
      // Nor does memory capture: by the time it runs, the session that
      // triggered it has ended and its editor is gone.
      | typeof QUEUE_NAMES.memoryCapture
      // Nor does consolidation, which runs in the middle of the night.
      | typeof QUEUE_NAMES.memoryConsolidate
    >;
    workspaceId: string;
    correlationId: string;
    jobId: string;
    progress: number;
    label: string;
    documentId: string | null;
  }): Promise<void> => {
    const { queue, workspaceId, correlationId, jobId, progress, label, documentId } = event;
    await bus.publish({
      type: 'job.progress',
      workspaceId,
      correlationId,
      emittedAt: new Date().toISOString(),
      payload: { jobId, queue, progress, label, documentId },
    });
  };
  return {
    prisma,
    queues,
    bus,
    provider,
    storage,
    search,
    readSettings,
    toolRunnerFactory,
    apiClientFor,
    resolveCalendarCredentials,
    reminderNotifier,
    imageGeneratorFor,
    visionPreprocessorFor,
    pdfDocumentInfo,
    pdfExtractorChain,
    modelRegistry,
    publishProgress,
  };
}

/**
 * The pieces that turn a file or a prompt into something a model produced:
 * image generation, the vision companions, and the PDF text chain.
 *
 * All four are cached or built once and all four have a "not configured" answer
 * rather than an exception, because a deployment is allowed to run without a
 * Docling container or an image model.
 */
function createMediaFactories(
  env: WorkerEnv,
  logger: Logger,
): {
  imageGeneratorFor: (modelSlug: string | null) => ImageGenerator | null;
  visionPreprocessorFor: (modelSlug: string | null) => VisionPreprocessor | null;
  pdfDocumentInfo: PdfDocumentInfoReader;
  pdfExtractorChain: (settings: Settings) => readonly PdfTextExtractor[];
} {
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

  return { imageGeneratorFor, visionPreprocessorFor, pdfDocumentInfo, pdfExtractorChain };
}
