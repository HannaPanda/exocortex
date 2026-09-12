import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AutomationRuleListResponse,
  automationRuleListResponseSchema,
  type AutomationRuleResponse,
  automationRuleResponseSchema,
  type AutomationRunListResponse,
  automationRunListResponseSchema,
  type CreateAutomationRuleRequest,
  createAutomationRuleRequestSchema,
  type CreateAutomationRuleResponse,
  createAutomationRuleResponseSchema,
  type DeleteAutomationRuleResponse,
  deleteAutomationRuleResponseSchema,
  type TriggerAutomationRuleRequest,
  triggerAutomationRuleRequestSchema,
  type TriggerAutomationRuleResponse,
  triggerAutomationRuleResponseSchema,
  type UpdateAutomationRuleRequest,
  updateAutomationRuleRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { AutomationDispatchService } from './automation-dispatch.service';
import { AutomationsService } from './automations.service';

/**
 * The rules of one workspace, and their run log (issue #50, ADR-024).
 *
 * Reading needs membership, writing needs OWNER (`canManageAutomations`). The
 * run log sits here rather than under a rule because the question people ask is
 * "what have the automations been doing", not "what has rule 4 been doing" --
 * the per-rule view is the same route with a query parameter.
 */
@ApiTags('workspaces')
@Controller('api/workspaces/:workspaceId/automations')
export class WorkspaceAutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(automationRuleListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<AutomationRuleListResponse> {
    return this.automations.list(workspaceId, session.userId);
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createAutomationRuleRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(createAutomationRuleResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createAutomationRuleRequestSchema)) body: CreateAutomationRuleRequest,
  ): Promise<CreateAutomationRuleResponse> {
    return this.automations.create({ workspaceId, userId: session.userId, request: body });
  }

  @Get('runs')
  @ApiOkResponse({ schema: openApiResponseSchema(automationRunListResponseSchema) })
  async runs(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query('ruleId') ruleId?: string,
  ): Promise<AutomationRunListResponse> {
    return this.automations.listRuns({ workspaceId, userId: session.userId, ruleId });
  }
}

/**
 * One rule, addressed by its own id: change it, delete it, fire it by hand.
 *
 * There is deliberately no `GET /api/automations/:ruleId`. Reading one rule is
 * reading the list and picking it: the list is per workspace, never long, and
 * carries every field a single read would. A second read path would be a second
 * place for the "never hand the signing secret back" rule to be got wrong.
 */
@ApiTags('workspaces')
@Controller('api/automations')
export class AutomationsController {
  constructor(
    private readonly automations: AutomationsService,
    private readonly dispatch: AutomationDispatchService,
  ) {}

  @Patch(':ruleId')
  @ApiBody({ schema: openApiSchema(updateAutomationRuleRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(automationRuleResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('ruleId') ruleId: string,
    @Body(zodPipe(updateAutomationRuleRequestSchema)) body: UpdateAutomationRuleRequest,
  ): Promise<AutomationRuleResponse> {
    return {
      rule: await this.automations.update({ ruleId, userId: session.userId, request: body }),
    };
  }

  @Delete(':ruleId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteAutomationRuleResponseSchema) })
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Param('ruleId') ruleId: string,
  ): Promise<DeleteAutomationRuleResponse> {
    await this.automations.remove(ruleId, session.userId);
    return { deleted: true };
  }

  /**
   * Fires the rule once, against one page, without waiting for the debounce.
   *
   * The endpoint that makes an automation debuggable: without it the only way
   * to find out whether a rule works is to edit a page and wait a minute. It is
   * also what lets an agent finish the job it started -- writing a rule it
   * cannot try is half a capability.
   */
  @Post(':ruleId/trigger')
  @ApiBody({ schema: openApiSchema(triggerAutomationRuleRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(triggerAutomationRuleResponseSchema) })
  async trigger(
    @CurrentSession() session: VerifiedSession,
    @Param('ruleId') ruleId: string,
    @Body(zodPipe(triggerAutomationRuleRequestSchema)) body: TriggerAutomationRuleRequest,
  ): Promise<TriggerAutomationRuleResponse> {
    return {
      run: await this.dispatch.trigger({ ruleId, userId: session.userId, request: body }),
    };
  }
}
