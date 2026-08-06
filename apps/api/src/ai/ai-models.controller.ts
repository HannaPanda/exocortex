import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type AiModelListResponse, aiModelListResponseSchema } from '@exocortex/contracts';

import { openApiResponseSchema } from '../common/zod';

import { AiModelResolverService } from './ai-model-resolver.service';

/**
 * The user-facing model picker. Session or token auth (no admin required, the
 * registry is global and read-only from here); only `enabled: true` rows are
 * returned, so a disabled model still resolves for old conversations but
 * leaves the picker.
 */
@ApiTags('ai')
@Controller('api/ai/models')
export class PublicAiModelsController {
  constructor(private readonly resolver: AiModelResolverService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(aiModelListResponseSchema) })
  async list(): Promise<AiModelListResponse> {
    return this.resolver.listEnabled();
  }
}
