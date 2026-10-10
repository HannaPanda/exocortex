import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { tokenHasScope, type VerifiedSession } from '@exocortex/auth';
import {
  type AiWriteMode,
  type AwaitChildrenRequest,
  awaitChildrenRequestSchema,
  type AwaitChildrenResponse,
  awaitChildrenResponseSchema,
  type ChildResultsQuery,
  childResultsQuerySchema,
  type ChildResultsResponse,
  childResultsResponseSchema,
  type DelegateWorkRequest,
  delegateWorkRequestSchema,
  type DelegateWorkResponse,
  delegateWorkResponseSchema,
} from '@exocortex/contracts';

import { type AuthenticatedRequest, CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { workItemActorOf } from './work-item-actor';
import { WorkItemDelegationService } from './work-item-delegation.service';
import { mayLoosenWriteMode } from './work-items.controller';

/**
 * What the caller may itself write (issue #144): a child it hands on is held
 * to that too. A person and a writing token write directly; a token that may
 * only propose proposes; a run of the built-in AI is held to the mode signed
 * into its service token.
 */
function callerWriteCeiling(request: AuthenticatedRequest): AiWriteMode {
  if (request.exocortexCredential === 'service_token') {
    return request.exocortexWriteMode ?? 'direct';
  }
  if (request.exocortexCredential === 'api_token') {
    return tokenHasScope(request.exocortexTokenScopes ?? [], 'write') ? 'direct' : 'propose';
  }
  return 'direct';
}

/**
 * Delegation (issue #144, ADR-072): handing a part of the work on, reading
 * what the parts brought back, and waiting for them. Sub-resources of the
 * parent, because each is something the parent does with its children.
 */
@ApiTags('work-items')
@Controller('api/work-items/:workItemId')
export class WorkItemDelegationController {
  constructor(private readonly delegation: WorkItemDelegationService) {}

  @Post('delegate')
  @ApiBody({ schema: openApiSchema(delegateWorkRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(delegateWorkResponseSchema) })
  async delegate(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param('workItemId') workItemId: string,
    @Body(zodPipe(delegateWorkRequestSchema)) body: DelegateWorkRequest,
  ): Promise<DelegateWorkResponse> {
    return this.delegation.delegate({
      parentId: workItemId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
      mayLoosen: mayLoosenWriteMode(request),
      callerWriteCeiling: callerWriteCeiling(request),
    });
  }

  @Get('children/results')
  @ApiQuery({ name: 'childIds', required: false })
  @ApiQuery({ name: 'maxChars', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(childResultsResponseSchema) })
  async childResults(
    @CurrentSession() session: VerifiedSession,
    @Param('workItemId') workItemId: string,
    @Query(zodPipe(childResultsQuerySchema)) query: ChildResultsQuery,
  ): Promise<ChildResultsResponse> {
    return this.delegation.childResults({ workItemId, userId: session.userId, query });
  }

  @Post('await-children')
  @ApiBody({ schema: openApiSchema(awaitChildrenRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(awaitChildrenResponseSchema) })
  async awaitChildren(
    @CurrentSession() session: VerifiedSession,
    @Param('workItemId') workItemId: string,
    @Body(zodPipe(awaitChildrenRequestSchema)) body: AwaitChildrenRequest,
  ): Promise<AwaitChildrenResponse> {
    return this.delegation.awaitChildren({
      workItemId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
