import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type ConfirmEntityCandidateRequest,
  confirmEntityCandidateRequestSchema,
  type ConfirmEntityCandidateResponse,
  confirmEntityCandidateResponseSchema,
  type CreateEntityRequest,
  createEntityRequestSchema,
  type DismissEntityCandidateResponse,
  dismissEntityCandidateResponseSchema,
  type EntityCandidateListQuery,
  entityCandidateListQuerySchema,
  type EntityCandidateListResponse,
  entityCandidateListResponseSchema,
  type EntityListQuery,
  entityListQuerySchema,
  type EntityListResponse,
  entityListResponseSchema,
  type EntityMutationResponse,
  entityMutationResponseSchema,
  type EntityProfile,
  entityProfileSchema,
  type LinkEntityPageRequest,
  linkEntityPageRequestSchema,
  type ProvisionEntityDatabaseRequest,
  provisionEntityDatabaseRequestSchema,
  type ProvisionEntityDatabaseResponse,
  provisionEntityDatabaseResponseSchema,
  type UpdateEntityRequest,
  updateEntityRequestSchema,
} from '@exocortex/contracts';

import { AdminOnly } from '../auth/admin.guard';
import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { EntitiesService } from './entities.service';
import { EntityCandidatesService } from './entity-candidates.service';
import { EntityProfileService } from './entity-profile.service';

/**
 * The entity layer (issue #47).
 *
 * Reads are GETs for the same reason the memory's are: `requiredScopeForRequest`
 * derives the needed scope from the method, and asking what is known about a
 * host must not require a token that could write.
 */
@ApiTags('entities')
@Controller('api/entities')
export class EntitiesController {
  constructor(
    private readonly entities: EntitiesService,
    private readonly profiles: EntityProfileService,
    private readonly candidates: EntityCandidatesService,
  ) {}

  @Get()
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(entityListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(entityListQuerySchema)) query: EntityListQuery,
  ): Promise<EntityListResponse> {
    return this.entities.list(session.userId, query);
  }

  /**
   * Creating the database and naming it in the settings is one act, and it is
   * an administrator's: `entities.databaseId` is a deployment-wide setting, and
   * everything past this call reads whatever it points at.
   */
  @Post('database')
  @AdminOnly()
  @ApiBody({ schema: openApiSchema(provisionEntityDatabaseRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(provisionEntityDatabaseResponseSchema) })
  async provision(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(provisionEntityDatabaseRequestSchema)) body: ProvisionEntityDatabaseRequest,
  ): Promise<ProvisionEntityDatabaseResponse> {
    return this.entities.provision({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  /** Candidates before `:entityId`, or the router reads "candidates" as an id. */
  @Get('candidates')
  @ApiQuery({ name: 'minDocuments', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(entityCandidateListResponseSchema) })
  async listCandidates(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(entityCandidateListQuerySchema)) query: EntityCandidateListQuery,
  ): Promise<EntityCandidateListResponse> {
    return this.candidates.list(session.userId, query);
  }

  @Post('candidates/:candidateId/confirm')
  @ApiBody({ schema: openApiSchema(confirmEntityCandidateRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(confirmEntityCandidateResponseSchema) })
  async confirmCandidate(
    @CurrentSession() session: VerifiedSession,
    @Param('candidateId') candidateId: string,
    @Body(zodPipe(confirmEntityCandidateRequestSchema)) body: ConfirmEntityCandidateRequest,
  ): Promise<ConfirmEntityCandidateResponse> {
    return this.candidates.confirm({
      userId: session.userId,
      candidateId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('candidates/:candidateId/dismiss')
  @ApiOkResponse({ schema: openApiResponseSchema(dismissEntityCandidateResponseSchema) })
  async dismissCandidate(
    @CurrentSession() session: VerifiedSession,
    @Param('candidateId') candidateId: string,
  ): Promise<DismissEntityCandidateResponse> {
    return this.candidates.dismiss({ userId: session.userId, candidateId });
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createEntityRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(entityMutationResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(createEntityRequestSchema)) body: CreateEntityRequest,
  ): Promise<EntityMutationResponse> {
    return this.entities.create({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get(':entityId')
  @ApiOkResponse({ schema: openApiResponseSchema(entityProfileSchema) })
  async profile(
    @CurrentSession() session: VerifiedSession,
    @Param('entityId') entityId: string,
  ): Promise<EntityProfile> {
    return this.profiles.profile(session.userId, entityId);
  }

  @Patch(':entityId')
  @ApiBody({ schema: openApiSchema(updateEntityRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(entityMutationResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('entityId') entityId: string,
    @Body(zodPipe(updateEntityRequestSchema)) body: UpdateEntityRequest,
  ): Promise<EntityMutationResponse> {
    return this.entities.update({
      userId: session.userId,
      entityId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':entityId/pages')
  @ApiBody({ schema: openApiSchema(linkEntityPageRequestSchema) })
  async linkPage(
    @CurrentSession() session: VerifiedSession,
    @Param('entityId') entityId: string,
    @Body(zodPipe(linkEntityPageRequestSchema)) body: LinkEntityPageRequest,
  ): Promise<{ entityId: string; documentId: string; created: boolean }> {
    return this.entities.linkPage({ userId: session.userId, entityId, request: body });
  }

  @Delete(':entityId/pages/:documentId')
  async unlinkPage(
    @CurrentSession() session: VerifiedSession,
    @Param('entityId') entityId: string,
    @Param('documentId') documentId: string,
  ): Promise<{ entityId: string; documentId: string; removed: boolean }> {
    return this.entities.unlinkPage({ userId: session.userId, entityId, documentId });
  }
}
