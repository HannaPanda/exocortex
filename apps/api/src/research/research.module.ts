import { Module } from '@nestjs/common';

import {
  createOptionalSearxngWebSearcher,
  createOptionalSteelWebFetcher,
  type WebFetcher,
  type WebSearcher,
} from '@exocortex/ai';
import { type ApiEnv } from '@exocortex/config';
import { type Logger } from '@exocortex/logger';

import { API_ENV, LOGGER } from '../common/logger.provider';

import { ResearchController } from './research.controller';
import { ResearchService } from './research.service';
import { WEB_FETCHER, WEB_SEARCHER } from './research-tokens';

@Module({
  controllers: [ResearchController],
  providers: [
    ResearchService,
    {
      provide: WEB_SEARCHER,
      inject: [API_ENV, LOGGER],
      // Null when SEARXNG_BASE_URL is unset. The alternative -- building a
      // client against an empty string and failing on the first call -- turns a
      // deployment decision into a runtime error somebody has to read a stack
      // trace to understand.
      useFactory: (env: ApiEnv, logger: Logger): WebSearcher | null =>
        createOptionalSearxngWebSearcher({ baseUrl: env.SEARXNG_BASE_URL, logger }),
    },
    {
      provide: WEB_FETCHER,
      inject: [API_ENV, LOGGER],
      useFactory: (env: ApiEnv, logger: Logger): WebFetcher | null =>
        createOptionalSteelWebFetcher({
          baseUrl: env.STEEL_BASE_URL,
          apiKey: env.STEEL_API_KEY,
          logger,
        }),
    },
  ],
  exports: [ResearchService],
})
export class ResearchModule {}
