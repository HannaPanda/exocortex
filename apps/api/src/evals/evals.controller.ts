import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CancelEvalRunResponse,
  cancelEvalRunResponseSchema,
  type CreateEvalCaseRequest,
  createEvalCaseRequestSchema,
  type DeleteEvalResponse,
  deleteEvalResponseSchema,
  type EvalAttemptResponse,
  evalAttemptResponseSchema,
  type EvalCaseFromRunRequest,
  evalCaseFromRunRequestSchema,
  type EvalCaseListQuery,
  evalCaseListQuerySchema,
  type EvalCaseListResponse,
  evalCaseListResponseSchema,
  type EvalCaseResponse,
  evalCaseResponseSchema,
  type EvalComparison,
  type EvalComparisonQuery,
  evalComparisonQuerySchema,
  evalComparisonSchema,
  type EvalRunDetailResponse,
  evalRunDetailResponseSchema,
  type EvalRunListResponse,
  evalRunListResponseSchema,
  type EvalSuiteFile,
  evalSuiteFileSchema,
  type ImportEvalSuiteRequest,
  importEvalSuiteRequestSchema,
  type ImportEvalSuiteResponse,
  importEvalSuiteResponseSchema,
  type ReviewEvalAttemptRequest,
  reviewEvalAttemptRequestSchema,
  type StartEvalRunRequest,
  startEvalRunRequestSchema,
  type UpdateEvalCaseRequest,
  updateEvalCaseRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { EvalCasesService } from './eval-cases.service';
import { EvalRunsService } from './eval-runs.service';

/**
 * Agent evals (issue #146, ADR-074): cases, the runs that replay them, the
 * attempts those are made of, and the comparison across them.
 */
@ApiTags('evals')
@Controller('api')
export class EvalsController {
  constructor(
    private readonly cases: EvalCasesService,
    private readonly runs: EvalRunsService,
  ) {}

  @Get('workspaces/:workspaceId/eval-cases')
  @ApiOkResponse({ schema: openApiResponseSchema(evalCaseListResponseSchema) })
  async listCases(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(evalCaseListQuerySchema)) query: EvalCaseListQuery,
  ): Promise<EvalCaseListResponse> {
    return this.cases.list({ workspaceId, userId: session.userId, query });
  }

  @Post('workspaces/:workspaceId/eval-cases')
  @ApiBody({ schema: openApiSchema(createEvalCaseRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(evalCaseResponseSchema) })
  async createCase(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createEvalCaseRequestSchema)) body: CreateEvalCaseRequest,
  ): Promise<EvalCaseResponse> {
    return this.cases.create({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('eval-cases/:caseId')
  @ApiOkResponse({ schema: openApiResponseSchema(evalCaseResponseSchema) })
  async getCase(
    @CurrentSession() session: VerifiedSession,
    @Param('caseId') caseId: string,
  ): Promise<EvalCaseResponse> {
    return this.cases.get({ caseId, userId: session.userId });
  }

  @Patch('eval-cases/:caseId')
  @ApiBody({ schema: openApiSchema(updateEvalCaseRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(evalCaseResponseSchema) })
  async updateCase(
    @CurrentSession() session: VerifiedSession,
    @Param('caseId') caseId: string,
    @Body(zodPipe(updateEvalCaseRequestSchema)) body: UpdateEvalCaseRequest,
  ): Promise<EvalCaseResponse> {
    return this.cases.update({
      caseId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete('eval-cases/:caseId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteEvalResponseSchema) })
  async deleteCase(
    @CurrentSession() session: VerifiedSession,
    @Param('caseId') caseId: string,
  ): Promise<DeleteEvalResponse> {
    return this.cases.delete({
      caseId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('ai/runs/:runId/eval-case')
  @ApiBody({ schema: openApiSchema(evalCaseFromRunRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(evalCaseResponseSchema) })
  async caseFromRun(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
    @Body(zodPipe(evalCaseFromRunRequestSchema)) body: EvalCaseFromRunRequest,
  ): Promise<EvalCaseResponse> {
    return this.cases.fromRun({
      runId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('workspaces/:workspaceId/eval-suites/:suite')
  @ApiOkResponse({ schema: openApiResponseSchema(evalSuiteFileSchema) })
  async exportSuite(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Param('suite') suite: string,
  ): Promise<EvalSuiteFile> {
    return this.cases.exportSuite({ workspaceId, suite, userId: session.userId });
  }

  @Post('workspaces/:workspaceId/eval-suites/import')
  @ApiBody({ schema: openApiSchema(importEvalSuiteRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(importEvalSuiteResponseSchema) })
  async importSuite(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(importEvalSuiteRequestSchema)) body: ImportEvalSuiteRequest,
  ): Promise<ImportEvalSuiteResponse> {
    return this.cases.importSuite({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('workspaces/:workspaceId/eval-runs')
  @ApiOkResponse({ schema: openApiResponseSchema(evalRunListResponseSchema) })
  async listRuns(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<EvalRunListResponse> {
    return this.runs.list({ workspaceId, userId: session.userId });
  }

  @Post('workspaces/:workspaceId/eval-runs')
  @ApiBody({ schema: openApiSchema(startEvalRunRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(evalRunDetailResponseSchema) })
  async startRun(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(startEvalRunRequestSchema)) body: StartEvalRunRequest,
  ): Promise<EvalRunDetailResponse> {
    return this.runs.start({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('eval-runs/:evalRunId')
  @ApiOkResponse({ schema: openApiResponseSchema(evalRunDetailResponseSchema) })
  async getRun(
    @CurrentSession() session: VerifiedSession,
    @Param('evalRunId') evalRunId: string,
  ): Promise<EvalRunDetailResponse> {
    return this.runs.get({ evalRunId, userId: session.userId });
  }

  @Post('eval-runs/:evalRunId/cancel')
  @ApiOkResponse({ schema: openApiResponseSchema(cancelEvalRunResponseSchema) })
  async cancelRun(
    @CurrentSession() session: VerifiedSession,
    @Param('evalRunId') evalRunId: string,
  ): Promise<CancelEvalRunResponse> {
    return this.runs.cancel({
      evalRunId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete('eval-runs/:evalRunId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteEvalResponseSchema) })
  async deleteRun(
    @CurrentSession() session: VerifiedSession,
    @Param('evalRunId') evalRunId: string,
  ): Promise<DeleteEvalResponse> {
    return this.runs.delete({
      evalRunId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('eval-comparison')
  @ApiOkResponse({ schema: openApiResponseSchema(evalComparisonSchema) })
  async compare(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(evalComparisonQuerySchema)) query: EvalComparisonQuery,
  ): Promise<EvalComparison> {
    return this.runs.compare({ runIds: query.runIds, userId: session.userId });
  }

  @Get('eval-attempts/:attemptId')
  @ApiOkResponse({ schema: openApiResponseSchema(evalAttemptResponseSchema) })
  async getAttempt(
    @CurrentSession() session: VerifiedSession,
    @Param('attemptId') attemptId: string,
  ): Promise<EvalAttemptResponse> {
    return this.runs.getAttempt({ attemptId, userId: session.userId });
  }

  @Patch('eval-attempts/:attemptId/review')
  @ApiBody({ schema: openApiSchema(reviewEvalAttemptRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(evalAttemptResponseSchema) })
  async reviewAttempt(
    @CurrentSession() session: VerifiedSession,
    @Param('attemptId') attemptId: string,
    @Body(zodPipe(reviewEvalAttemptRequestSchema)) body: ReviewEvalAttemptRequest,
  ): Promise<EvalAttemptResponse> {
    return this.runs.review({
      attemptId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
