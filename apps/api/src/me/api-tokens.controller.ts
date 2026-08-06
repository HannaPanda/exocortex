import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type ApiTokenListResponse,
  apiTokenListResponseSchema,
  type CreateApiTokenRequest,
  createApiTokenRequestSchema,
  type CreateApiTokenResponse,
  createApiTokenResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { ApiTokensService } from './api-tokens.service';

const revokeResponseSchema = z.object({ revoked: z.literal(true) });
type RevokeResponse = z.infer<typeof revokeResponseSchema>;

/** Every user's own API tokens. Session or token auth; no admin role required. */
@ApiTags('me')
@Controller('api/me/api-tokens')
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(apiTokenListResponseSchema) })
  async list(@CurrentSession() session: VerifiedSession): Promise<ApiTokenListResponse> {
    return this.tokens.list(session.userId);
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createApiTokenRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(createApiTokenResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(createApiTokenRequestSchema)) body: CreateApiTokenRequest,
  ): Promise<CreateApiTokenResponse> {
    return this.tokens.create(session.userId, body);
  }

  @Delete(':tokenId')
  @ApiOkResponse({ schema: openApiResponseSchema(revokeResponseSchema) })
  async revoke(
    @CurrentSession() session: VerifiedSession,
    @Param('tokenId') tokenId: string,
  ): Promise<RevokeResponse> {
    return this.tokens.revoke(session.userId, tokenId);
  }
}
