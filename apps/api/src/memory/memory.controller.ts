import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type MemoryCaptureRequest,
  memoryCaptureRequestSchema,
  type MemoryCaptureResponse,
  memoryCaptureResponseSchema,
  type MemoryConsolidateRequest,
  memoryConsolidateRequestSchema,
  type MemoryConsolidateResponse,
  memoryConsolidateResponseSchema,
  type MemoryFactListQuery,
  memoryFactListQuerySchema,
  type MemoryFactListResponse,
  memoryFactListResponseSchema,
  type MemoryFactPromoteRequest,
  memoryFactPromoteRequestSchema,
  type MemoryFactPromoteResponse,
  memoryFactPromoteResponseSchema,
  type MemoryRecallRequest,
  memoryRecallRequestSchema,
  type MemoryRecallResponse,
  memoryRecallResponseSchema,
  type MemoryRememberRequest,
  memoryRememberRequestSchema,
  type MemoryRememberResponse,
  memoryRememberResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { MemoryService } from './memory.service';
import { MemoryFactsService } from './memory-facts.service';

/**
 * The memory surface for agents (issue #34).
 *
 * `recall` is a GET on purpose, and not only because it reads nothing but
 * search results: `requiredScopeForRequest` derives the needed scope from the
 * method, so a POST would force every remembering client to hold a `write`
 * token just to look something up.
 */
@ApiTags('memory')
@Controller('api/memory')
export class MemoryController {
  constructor(
    private readonly memory: MemoryService,
    private readonly facts: MemoryFactsService,
  ) {}

  @Get('recall')
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'project', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'maxChars', required: false })
  @ApiQuery({ name: 'includeKnowledge', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryRecallResponseSchema) })
  async recall(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(memoryRecallRequestSchema)) query: MemoryRecallRequest,
  ): Promise<MemoryRecallResponse> {
    return this.memory.recall(session.userId, query);
  }

  @Post('remember')
  @ApiBody({ schema: openApiSchema(memoryRememberRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryRememberResponseSchema) })
  async remember(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(memoryRememberRequestSchema)) body: MemoryRememberRequest,
  ): Promise<MemoryRememberResponse> {
    return this.memory.remember({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('capture')
  @ApiBody({ schema: openApiSchema(memoryCaptureRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryCaptureResponseSchema) })
  async capture(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(memoryCaptureRequestSchema)) body: MemoryCaptureRequest,
  ): Promise<MemoryCaptureResponse> {
    return this.memory.capture({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  /**
   * The distilled facts of a project (issue #46).
   *
   * A GET for the same reason `recall` is one: reading what is known must not
   * require a `write` token.
   */
  @Get('facts')
  @ApiQuery({ name: 'project', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryFactListResponseSchema) })
  async listFacts(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(memoryFactListQuerySchema)) query: MemoryFactListQuery,
  ): Promise<MemoryFactListResponse> {
    return this.facts.list(session.userId, query);
  }

  /**
   * Applies one consolidation run. The worker's only way in: it decides what a
   * note means, the API decides what that does to the memory.
   */
  @Post('facts')
  @ApiBody({ schema: openApiSchema(memoryConsolidateRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryConsolidateResponseSchema) })
  async consolidate(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(memoryConsolidateRequestSchema)) body: MemoryConsolidateRequest,
  ): Promise<MemoryConsolidateResponse> {
    return this.facts.consolidate({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('facts/:factId/promote')
  @ApiBody({ schema: openApiSchema(memoryFactPromoteRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryFactPromoteResponseSchema) })
  async promote(
    @CurrentSession() session: VerifiedSession,
    @Param('factId') factId: string,
    @Body(zodPipe(memoryFactPromoteRequestSchema)) body: MemoryFactPromoteRequest,
  ): Promise<MemoryFactPromoteResponse> {
    return this.facts.promote({
      userId: session.userId,
      factId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
