import { Controller, Get, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type FeatureListResponse,
  featureListResponseSchema,
  type MarkFeaturesSeenResponse,
  markFeaturesSeenResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema } from '../common/zod';

import { FeaturesService } from './features.service';

/**
 * What this deployment can do, in a person's words (issue #80, ADR-040).
 *
 * Not under a workspace: the registry describes the software, not the content,
 * and it is the same list in every workspace. It does need a session, because
 * "new for you" is a fact about the reader.
 */
@ApiTags('features')
@Controller('api/features')
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(featureListResponseSchema) })
  async list(@CurrentSession() session: VerifiedSession): Promise<FeatureListResponse> {
    return this.features.list(session.userId);
  }

  @Post('seen')
  @ApiOkResponse({ schema: openApiResponseSchema(markFeaturesSeenResponseSchema) })
  async markSeen(@CurrentSession() session: VerifiedSession): Promise<MarkFeaturesSeenResponse> {
    return this.features.markSeen(session.userId);
  }
}
