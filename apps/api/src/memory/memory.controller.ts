import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type MemoryCaptureRequest,
  memoryCaptureRequestSchema,
  type MemoryCaptureResponse,
  memoryCaptureResponseSchema,
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
  constructor(private readonly memory: MemoryService) {}

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
}
