import {
  type AiProvider,
  createAiProvider,
  createEmbeddingClient,
  createEmbeddingProvider,
  createProviderRoutingResolver,
  type DocumentTextExtractor,
  type ImageGenerator,
  type PdfDocumentInfoReader,
  type VisionPreprocessor,
} from '@exocortex/ai';
import { parseCredentialKey } from '@exocortex/auth';
import { type WorkerEnv } from '@exocortex/config';
import { type ProviderRouting, semanticSearchOptions, type Settings } from '@exocortex/contracts';
import {
  createPrismaClient,
  HybridSearchAdapter,
  PostgresSearchAdapter,
  type PrismaClient,
  type SearchAdapter,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { createMailerFromEnv, type Mailer } from '@exocortex/mail';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { QueueRegistry, RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage, S3ObjectStorage } from '@exocortex/storage';

import { type AiKeyResolver, createAiKeyResolver, type ResolvedAiKey } from './ai-key';
import { buildApiClientFactory, buildToolRunnerFactory } from './api-access';
import {
  type CalendarAccountCredentialsRef,
  type CalendarCredentials,
  createCalendarCredentialResolver,
} from './calendar/credentials';
import { createCommandNotifier } from './calendar/notifier';
import { createProgressPublisher, type JobProgressEvent } from './job-progress';
import { createMediaFactories } from './media-factories';
import { readModelRow } from './model-registry';
import { type ResolvedModelRow } from './processors/ai-run';
import { createPushSender, type PushSender } from './push/send';
import { vapidKeysFromEnv } from './push/vapid';
import { createSettingsReader } from './settings-reader';
import { type ToolRunnerFactory } from './tool-runner';

export { type JobProgressEvent } from './job-progress';

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
   * Full text alone, for the callers that need to hand both halves to
   * `runSavedQuery` -- a pinned saved query in a system prompt (issue #75).
   * The same object the hybrid adapter falls back to, built once here so the
   * two cannot be configured differently.
   */
  keywordSearch: SearchAdapter;
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
  resolveCalendarCredentials: (
    account: CalendarAccountCredentialsRef,
  ) => CalendarCredentials | null;
  reminderNotifier: ReturnType<typeof createCommandNotifier> | null;
  /**
   * How an encrypted notification reaches a device (issue #30, ADR-048).
   *
   * Null on a deployment with no VAPID key pair, which is the ordinary state
   * of a fresh installation: push is then simply off, and every other part of
   * the worker is unchanged.
   */
  pushSender: PushSender | null;
  /**
   * The worker's SMTP transport (issue #102).
   *
   * Not nullable, unlike `pushSender` beside it: a deployment without a relay
   * gets a mailer that logs what it would have sent, so the mail queue keeps
   * working and says so instead of every job failing on a missing dependency.
   */
  mailer: Mailer;
  imageGeneratorFor: (modelSlug: string | null) => ImageGenerator | null;
  /**
   * A vision companion for one model slug, optionally paid for with a
   * workspace's own key. Without a key it is the deployment's, cached per
   * slug; with one it is built fresh, because a cache keyed by a secret is not
   * a cache worth having.
   */
  visionPreprocessorFor: (modelSlug: string | null, apiKey?: string) => VisionPreprocessor | null;
  pdfDocumentInfo: PdfDocumentInfoReader;
  pdfExtractorChain: (settings: Settings) => readonly DocumentTextExtractor[];
  /**
   * The local office converter (issue #38). One instance rather than a
   * factory: it reads no settings and holds no credential, so there is
   * nothing for a per-job rebuild to pick up.
   */
  officeExtractor: DocumentTextExtractor;
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

/** The deployment's own OpenRouter settings with one API key swapped in. */
function providerWithKey(
  env: WorkerEnv,
  logger: Logger,
  apiKey: string,
  providerRoutingFor: (model: string) => Promise<ProviderRouting>,
): AiProvider {
  return createAiProvider({
    providerId: env.AI_PROVIDER,
    logger,
    appUrl: env.APP_URL,
    openRouter: {
      apiKey,
      baseUrl: env.OPENROUTER_BASE_URL,
      defaultModel: env.OPENROUTER_DEFAULT_MODEL,
    },
    providerRoutingFor,
  });
}

/**
 * Composition only: every piece is built by the module that owns it, and this
 * function decides nothing beyond which of them exist on this deployment
 * (issue #97 moved the factories out).
 */
export function createWorkerRuntime(env: WorkerEnv, logger: Logger): WorkerRuntime {
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const bus = new RedisEventBus({ redisUrl: env.REDIS_URL, logger });
  const readSettings = createSettingsReader(prisma, logger);
  // One resolver for every provider this process builds, whoever pays: which
  // providers may serve a model is the deployment's decision (ADR-063), and a
  // workspace's own key changes the bill, not the routing.
  const providerRoutingFor = createProviderRoutingResolver({
    readGlobal: async () => (await readSettings())['ai.providerRouting'],
    readOverride: async (slug) =>
      (await prisma.aiModel.findUnique({ where: { slug }, select: { providerRouting: true } }))
        ?.providerRouting ?? null,
  });
  const provider = providerWithKey(env, logger, env.OPENROUTER_API_KEY ?? '', providerRoutingFor);

  const aiKeyFor: AiKeyResolver = createAiKeyResolver({ prisma, env, logger });
  const providerFor = async (
    workspaceId: string,
  ): Promise<{ provider: AiProvider; key: ResolvedAiKey }> => {
    const key = await aiKeyFor(workspaceId);
    if (!key.usedOwnKey) return { provider, key };
    return { provider: providerWithKey(env, logger, key.apiKey, providerRoutingFor), key };
  };

  const { keywordSearch, search } = createSearch(env, logger, prisma, readSettings);

  // Reminder delivery: both halves have to be configured, because a command
  // without a target and a target without a command are each half a setup. Unset
  // leaves reminders off however the settings are switched, the same shape as the
  // service-token seam -- a missing line in `.env` never stops the boot.
  const reminderNotifier =
    env.CALENDAR_REMINDER_COMMAND === undefined || env.CALENDAR_REMINDER_TARGET === undefined
      ? null
      : createCommandNotifier({
          command: env.CALENDAR_REMINDER_COMMAND,
          target: env.CALENDAR_REMINDER_TARGET,
          logger,
        });

  /*
   * Push notifications (issue #30, ADR-048). The key pair is a credential and
   * lives in the environment, never in the `setting` table (ADR-023). Half a
   * pair is no pair, which `vapidKeysFromEnv` decides, and an absent one
   * leaves push off without stopping the boot.
   */
  const vapidKeys = vapidKeysFromEnv(env);

  return {
    prisma,
    queues: new QueueRegistry({ redisUrl: env.REDIS_URL, logger }),
    bus,
    provider,
    providerFor,
    storage: createStorage(env, logger),
    search,
    keywordSearch,
    readSettings,
    toolRunnerFactory: buildToolRunnerFactory(env, logger),
    apiClientFor: buildApiClientFactory(env),
    resolveCalendarCredentials: createCalendarCredentialResolver({
      environment: process.env,
      defaultBaseUrl: env.MAILBOX_CALDAV_URL,
      logger,
    }),
    reminderNotifier,
    pushSender: vapidKeys === null ? null : createPushSender({ keys: vapidKeys }),
    // One transport for the process, closed on shutdown by `main.ts`.
    mailer: createMailerFromEnv({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      from: env.SMTP_FROM,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      logger,
    }),
    ...createMediaFactories(env, logger),
    modelRegistry: (slug) => readModelRow(prisma, slug),
    publishProgress: createProgressPublisher(bus),
    credentialKey: readCredentialKey(env, logger),
  };
}

function createStorage(env: WorkerEnv, logger: Logger): ObjectStorage {
  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    logger,
  });
}

/**
 * The search projection, both halves of it (issue #34, AP4).
 *
 * Takes `readSettings` because the semantic half is a runtime setting, not a
 * boot-time one: turning it on in the administration area has to reach the
 * next indexing job without a restart.
 */
function createSearch(
  env: WorkerEnv,
  logger: Logger,
  prisma: PrismaClient,
  readSettings: (workspaceId?: string) => Promise<Settings>,
): { keywordSearch: SearchAdapter; search: HybridSearchAdapter } {
  const keywordSearch = new PostgresSearchAdapter(prisma);
  const search = new HybridSearchAdapter({
    prisma,
    keyword: keywordSearch,
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
  return { keywordSearch, search };
}

/** See `WorkerRuntime.credentialKey`: a malformed key is logged, never fatal. */
function readCredentialKey(env: WorkerEnv, logger: Logger): Buffer | null {
  try {
    return parseCredentialKey(env.CREDENTIAL_ENCRYPTION_KEY);
  } catch (error: unknown) {
    logger.error('Ignoring CREDENTIAL_ENCRYPTION_KEY: it is not usable', error);
    return null;
  }
}
