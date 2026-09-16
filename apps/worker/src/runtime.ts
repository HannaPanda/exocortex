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
import { issueServiceToken, parseCredentialKey } from '@exocortex/auth';
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

import { type AiKeyResolver, createAiKeyResolver, type ResolvedAiKey } from './ai-key';
import { createCommandNotifier } from './calendar/notifier';
import { type ResolvedModelRow } from './processors/ai-run';
import {
  createToolRunner,
  type ToolRunnerFactory,
  type ToolRunnerFactoryInput,
} from './tool-runner';

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
  /**
   * The deployment's provider, built once at boot.
   *
   * Right for everything the deployment pays for itself: memory capture,
   * consolidation, compaction. An AI run asks `providerFor` instead, because
   * the workspace may be paying with its own key (ADR-023).
   */
  provider: AiProvider;
  /**
   * The provider one run should use, plus who is paying for it (issue #52).
   *
   * Built per run rather than once at boot: `createAiProvider` allocates an
   * object around a fetch client, which is cheap enough to do per run and the
   * only way a workspace's own key can reach the call at all.
   */
  providerFor: (workspaceId: string) => Promise<{ provider: AiProvider; key: ResolvedAiKey }>;
  storage: ObjectStorage;
  search: HybridSearchAdapter;
  /**
   * The configuration in force, optionally inside one workspace (ADR-023).
   *
   * A processor that has a `workspaceId` must pass it: without it the answer
   * is the deployment's, and a workspace that set its own system prompt would
   * silently be run with somebody else's. Jobs that genuinely span the
   * installation (snapshot pruning, index maintenance) call it with nothing.
   */
  readSettings: (workspaceId?: string) => Promise<Settings>;
  toolRunnerFactory: ToolRunnerFactory | null;
  apiClientFor:
    ((userId: string, headers?: Readonly<Record<string, string>>) => ExocortexApiClient) | null;
  resolveCalendarCredentials: (account: {
    provider: string;
    username: string;
    credentialRef: string;
    baseUrl: string | null;
  }) => { baseUrl: string; username: string; password: string } | null;
  reminderNotifier: ReturnType<typeof createCommandNotifier> | null;
  imageGeneratorFor: (modelSlug: string | null) => ImageGenerator | null;
  /**
   * A vision companion for one model slug, optionally paid for with a
   * workspace's own key. Without a key it is the deployment's, cached per
   * slug; with one it is built fresh, because a cache keyed by a secret is not
   * a cache worth having.
   */
  visionPreprocessorFor: (modelSlug: string | null, apiKey?: string) => VisionPreprocessor | null;
  pdfDocumentInfo: PdfDocumentInfoReader;
  pdfExtractorChain: (settings: Settings) => readonly PdfTextExtractor[];
  modelRegistry: (slug: string) => Promise<ResolvedModelRow | null>;
  publishProgress: (event: JobProgressEvent) => Promise<void>;
  /**
   * The deployment's `CREDENTIAL_ENCRYPTION_KEY`, parsed once at boot, or null
   * when it has none or it is unusable.
   *
   * Only the automation processor takes it from here; the AI key resolver
   * parses its own, because it was written before there was a second reader.
   * A malformed key must never stop the worker from booting (R2), so a parse
   * failure is logged and becomes `null`.
   */
  credentialKey: Buffer | null;
}

/** The shape `publishProgress` accepts; see its doc comment below. */
export interface JobProgressEvent {
  queue: Exclude<
    (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES],
    | typeof QUEUE_NAMES.attachmentText
    | typeof QUEUE_NAMES.documentCover
    // Nor does a composition: it runs minutes after the edit that caused it,
    // and reports through `document.overview.updated` (issue #53).
    | typeof QUEUE_NAMES.documentOverview
    | typeof QUEUE_NAMES.calendarSync
    | typeof QUEUE_NAMES.memoryCapture
    | typeof QUEUE_NAMES.memoryConsolidate
    | typeof QUEUE_NAMES.entityRescan
    // An automation's progress is its run log, not a toast in a browser: it
    // runs for a rule somebody set up weeks ago, usually with nobody watching.
    | typeof QUEUE_NAMES.automation
    // A render reports through `render.job.updated`; a percentage would be a
    // guess, because nothing inside a LaTeX run says how far along it is.
    | typeof QUEUE_NAMES.render
    // A project build says the same through `project.build.updated`, and
    // latexmk says nothing about how far through its passes it is either.
    | typeof QUEUE_NAMES.projectBuild
  >;
  workspaceId: string;
  correlationId: string;
  jobId: string;
  progress: number;
  label: string;
  documentId: string | null;
}

/**
 * Settings for the worker: DB rows override env, env stays the bootstrap
 * fallback (D4), and a workspace's own rows override both (ADR-023).
 *
 * The same `resolveSettings()` the API's `SettingsService` uses, cached for the
 * same 15 seconds so the tool loop does not re-query per turn. A module-level
 * factory rather than a closure inside `createWorkerRuntime`, which is long
 * enough already: this is a self-contained piece of state with one entry point.
 */
function createSettingsReader(
  prisma: PrismaClient,
  logger: Logger,
): (workspaceId?: string) => Promise<Settings> {
  const SETTINGS_CACHE_TTL_MS = 15_000;
  let settingsCache: {
    rows: { key: string; value: unknown }[];
    settings: Settings;
    expiresAt: number;
  } | null = null;
  const workspaceSettingsCache = new Map<string, { settings: Settings; expiresAt: number }>();

  const readDeploymentRows = async (): Promise<{
    rows: { key: string; value: unknown }[];
    settings: Settings;
  }> => {
    const now = Date.now();
    if (settingsCache !== null && settingsCache.expiresAt > now) return settingsCache;
    const rows = await prisma.setting.findMany({ select: { key: true, value: true } });
    const { settings, invalidKeys } = resolveSettings({ rows, env: process.env });
    if (invalidKeys.length > 0) {
      logger.warn('Dropped invalid setting rows while resolving settings', { invalidKeys });
    }
    settingsCache = { rows, settings, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    return settingsCache;
  };

  return async (workspaceId?: string): Promise<Settings> => {
    const base = await readDeploymentRows();
    if (workspaceId === undefined) return base.settings;

    const now = Date.now();
    const cached = workspaceSettingsCache.get(workspaceId);
    if (cached !== undefined && cached.expiresAt > now) return cached.settings;

    const workspaceRows = await prisma.workspaceSetting.findMany({
      where: { workspaceId },
      select: { key: true, value: true },
    });
    const { settings, invalidKeys } = resolveSettings({
      rows: base.rows,
      env: process.env,
      workspaceRows,
    });
    if (invalidKeys.length > 0) {
      logger.warn('Dropped invalid setting rows while resolving workspace settings', {
        workspaceId,
        invalidKeys,
      });
    }
    workspaceSettingsCache.set(workspaceId, { settings, expiresAt: now + SETTINGS_CACHE_TTL_MS });
    return settings;
  };
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

  const readSettings = createSettingsReader(prisma, logger);
  const aiKeyFor: AiKeyResolver = createAiKeyResolver({ prisma, env, logger });
  const providerFor = async (
    workspaceId: string,
  ): Promise<{ provider: AiProvider; key: ResolvedAiKey }> => {
    const key = await aiKeyFor(workspaceId);
    if (!key.usedOwnKey) return { provider, key };
    return {
      provider: createAiProvider({
        providerId: env.AI_PROVIDER,
        logger,
        appUrl: env.APP_URL,
        openRouter: {
          apiKey: key.apiKey,
          baseUrl: env.OPENROUTER_BASE_URL,
          defaultModel: env.OPENROUTER_DEFAULT_MODEL,
        },
      }),
      key,
    };
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
      : (input: ToolRunnerFactoryInput) =>
          createToolRunner({
            apiUrl: env.API_URL,
            serviceTokenSecret: env.SERVICE_TOKEN_SECRET!,
            serviceTokenTtlSeconds: env.SERVICE_TOKEN_TTL_SECONDS,
            userId: input.userId,
            includeMutating: input.includeMutating,
            mutationPolicy: input.mutationPolicy,
            toolCallTimeoutMs: input.toolCallTimeoutMs,
            agentSession: input.agentSession,
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
      : (userId: string, headers?: Readonly<Record<string, string>>) =>
          createFetchApiClient({
            baseUrl: env.API_URL,
            token: issueServiceToken({
              secret: env.SERVICE_TOKEN_SECRET!,
              userId,
              purpose: 'ai-tools',
              ttlSeconds: env.SERVICE_TOKEN_TTL_SECONDS,
            }).token,
            // The one caller that passes headers is the automation processor,
            // stamping the rule its write came from so the write cannot trigger
            // that rule again (issue #50, ADR-024). The API accepts that header
            // only on a service token, which is the only kind minted here.
            headers,
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
      // Nor does a composition: it runs minutes after the edit that caused it,
      // and reports through `document.overview.updated` (issue #53).
      | typeof QUEUE_NAMES.documentOverview
      // The calendar sync has no workspace in its payload and no browser
      // waiting on it, so it reports nothing over the progress channel.
      | typeof QUEUE_NAMES.calendarSync
      // Nor does memory capture: by the time it runs, the session that
      // triggered it has ended and its editor is gone.
      | typeof QUEUE_NAMES.memoryCapture
      // Nor does consolidation, which runs in the middle of the night.
      | typeof QUEUE_NAMES.memoryConsolidate
      // Nor does an entity rescan: nobody is waiting on it, and the page it
      // would report about is not the page anybody has open.
      | typeof QUEUE_NAMES.entityRescan
      // Nor does an automation: its progress is its run log, because it runs
      // for a rule somebody set up weeks ago, usually with nobody watching.
      | typeof QUEUE_NAMES.automation
      // Nor does a render: a build reports through `render.job.updated`, which
      // carries the status the dialog is actually waiting for, and a percentage
      // would be a guess -- nothing inside a LaTeX run says how far along it is.
      | typeof QUEUE_NAMES.render
      // Nor does a project build, for the same reason (issue #43, ADR-027):
      // `project.build.updated` carries the status, and latexmk says nothing
      // about how far through its passes it is.
      | typeof QUEUE_NAMES.projectBuild
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
  let credentialKey: Buffer | null = null;
  try {
    credentialKey = parseCredentialKey(env.CREDENTIAL_ENCRYPTION_KEY);
  } catch (error: unknown) {
    logger.error('Ignoring CREDENTIAL_ENCRYPTION_KEY: it is not usable', error);
  }

  return {
    prisma,
    queues,
    bus,
    provider,
    providerFor,
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
    credentialKey,
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
  visionPreprocessorFor: (modelSlug: string | null, apiKey?: string) => VisionPreprocessor | null;
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
  const visionPreprocessorFor = (
    modelSlug: string | null,
    apiKey?: string,
  ): VisionPreprocessor | null => {
    const effectiveModel = modelSlug ?? env.OPENROUTER_VISION_MODEL;
    const cacheKey = effectiveModel ?? '';
    // A run that pays with its own key gets its own preprocessor. Not cached:
    // the cache is keyed by model, and holding secrets in it would either leak
    // one workspace's key into another's call or need the key in the cache key.
    if (apiKey !== undefined && apiKey !== (env.OPENROUTER_API_KEY ?? '')) {
      return createVisionPreprocessor({
        logger,
        appUrl: env.APP_URL,
        apiKey,
        baseUrl: env.OPENROUTER_BASE_URL,
        model: effectiveModel,
      });
    }
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
