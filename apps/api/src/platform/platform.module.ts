import { Global, Inject, Injectable,Module, type OnApplicationShutdown } from '@nestjs/common';

import { type AiProvider,createAiProvider } from '@exocortex/ai';
import { WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';
import { type ObjectStorage, S3ObjectStorage } from '@exocortex/storage';

import { API_ENV, apiEnvProvider, LOGGER, loggerProvider } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';

import {
  AI_DEFAULT_MODEL,
  AI_PROVIDER,
  OBJECT_STORAGE,
  PRISMA,
  QUEUES,
} from './platform-tokens';
import { SettingsService } from './settings.service';

export { AI_DEFAULT_MODEL, AI_PROVIDER, OBJECT_STORAGE, PRISMA, QUEUES };

/**
 * Owns every long-lived infrastructure connection and closes them again on
 * shutdown, so `SIGTERM` never leaves a dangling database or Redis connection.
 */
@Injectable()
export class PlatformLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info('Closing platform resources', { signal: signal ?? 'unknown' });
    await this.queues.close().catch((error: unknown) => {
      this.logger.error('Failed to close queues', error);
    });
    await this.prisma.$disconnect().catch((error: unknown) => {
      this.logger.error('Failed to disconnect Prisma', error);
    });
  }
}

@Global()
@Module({
  providers: [
    apiEnvProvider,
    loggerProvider,
    {
      provide: PRISMA,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): PrismaClient =>
        createPrismaClient({ databaseUrl: env.DATABASE_URL }),
    },
    {
      provide: QUEUES,
      inject: [API_ENV, LOGGER],
      useFactory: (env: ApiEnv, logger: Logger): QueueRegistry =>
        new QueueRegistry({ redisUrl: env.REDIS_URL, logger }),
    },
    {
      provide: OBJECT_STORAGE,
      inject: [API_ENV, LOGGER],
      useFactory: (env: ApiEnv, logger: Logger): ObjectStorage =>
        new S3ObjectStorage({
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          bucket: env.S3_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          logger,
        }),
    },
    {
      provide: AI_PROVIDER,
      inject: [API_ENV, LOGGER],
      useFactory: (env: ApiEnv, logger: Logger): AiProvider =>
        createAiProvider({
          providerId: env.AI_PROVIDER,
          logger,
          appUrl: env.APP_URL,
          openRouter: {
            apiKey: env.OPENROUTER_API_KEY ?? '',
            baseUrl: env.OPENROUTER_BASE_URL,
            defaultModel: env.OPENROUTER_DEFAULT_MODEL,
          },
        }),
    },
    {
      provide: AI_DEFAULT_MODEL,
      inject: [API_ENV],
      // Bootstrap value only: this is what a fresh process falls back to before
      // it ever reads the database. Runtime resolution goes through
      // `SettingsService.getKey('ai.defaultModelSlug')` (D4) -- callers that
      // need the effective model must ask the settings service, not this token.
      useFactory: (env: ApiEnv): string => env.OPENROUTER_DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4.5',
    },
    {
      provide: WorkspaceAccessService,
      inject: [PRISMA],
      useFactory: (prisma: PrismaClient): WorkspaceAccessService =>
        new WorkspaceAccessService(prisma),
    },
    OutboxService,
    SettingsService,
    PlatformLifecycle,
  ],
  exports: [
    API_ENV,
    LOGGER,
    PRISMA,
    QUEUES,
    OBJECT_STORAGE,
    AI_PROVIDER,
    AI_DEFAULT_MODEL,
    WorkspaceAccessService,
    SettingsService,
  ],
})
export class PlatformModule {}
