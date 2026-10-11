import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { assertPolicy, canManageWorkItems, WorkspaceAccessService } from '@exocortex/auth';
import {
  type CancelEvalRunResponse,
  type DeleteEvalResponse,
  EVAL_LIMITS,
  type EvalAttemptResponse,
  type EvalComparison,
  type EvalRunDetailResponse,
  type EvalRunListResponse,
  evalVariantLabel,
  type ReviewEvalAttemptRequest,
  type StartEvalRunRequest,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

import { ConversationsService } from '../ai/conversations.service';
import { AppError } from '../common/app-error';
import { currentAiRunId, runWithRequestContext } from '../common/correlation';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { outcomeOf } from './eval-assertions';
import { buildComparison } from './eval-comparison';
import {
  attemptDefinition,
  attemptVariant,
  caseDefinition,
  EVAL_ATTEMPT_SELECT,
  EVAL_CASE_SELECT,
  EVAL_RUN_SELECT,
  type EvalCaseRow,
  OUTCOME_TO_PRISMA,
  storedManual,
  toEvalAttempt,
  toEvalRun,
} from './eval-mapper';
import { EvalSandboxService } from './eval-sandbox.service';
import { EvalSettlementService } from './eval-settlement.service';

const LIST_LIMIT = 50;

/**
 * Eval runs and their attempts (issue #146, ADR-074).
 *
 * Starting writes the run and every attempt with its frozen case in one
 * transaction and answers at once; the attempts are then started one after
 * another in the background, because a fixture sandbox is a handful of page
 * writes each and the queue decides how many runs work at the same time
 * anyway. An attempt is an ordinary conversation turn with its run tagged,
 * so everything a run has (the inspector, the usage view, the trace) an
 * attempt has too.
 */
@Injectable()
export class EvalRunsService implements OnModuleInit {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly conversations: ConversationsService,
    private readonly sandbox: EvalSandboxService,
    private readonly settlement: EvalSettlementService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.settlement.onLaunch((attemptId) => this.launch(attemptId));
  }

  async start(input: {
    workspaceId: string;
    userId: string;
    request: StartEvalRunRequest;
    correlationId: string;
  }): Promise<EvalRunDetailResponse> {
    await this.assertMayRun(input.workspaceId, input.userId);
    const { request } = input;
    const cases = await this.prisma.evalCase.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(request.caseIds === undefined
          ? { suite: request.suite }
          : { id: { in: request.caseIds } }),
      },
      select: EVAL_CASE_SELECT,
      orderBy: { name: 'asc' },
    });
    if (
      cases.length === 0 ||
      (request.caseIds !== undefined && cases.length !== new Set(request.caseIds).size)
    ) {
      throw AppError.notFound('Eval case');
    }
    if (cases.length > EVAL_LIMITS.maxCasesPerRun) {
      throw new AppError(
        'eval_run_too_large',
        `At most ${EVAL_LIMITS.maxCasesPerRun} cases per run`,
      );
    }
    const total = cases.length * request.variants.length * request.repetitions;
    if (total > EVAL_LIMITS.maxAttemptsPerRun) {
      throw new AppError(
        'eval_run_too_large',
        `${total} attempts; one eval run may start at most ${EVAL_LIMITS.maxAttemptsPerRun}`,
      );
    }
    for (const row of cases) await this.assertStartable(row);
    for (const variant of request.variants) await this.assertModel(variant.modelSlug);

    const plan = attemptPlan(cases, request);
    const created = await this.prisma.evalRun.create({
      data: {
        workspaceId: input.workspaceId,
        label: request.label ?? null,
        suite: request.suite ?? null,
        variants: request.variants as unknown as Prisma.InputJsonArray,
        repetitions: request.repetitions,
        createdById: input.userId,
        attempts: {
          create: plan.map((entry, position) => ({
            workspaceId: input.workspaceId,
            caseId: entry.row.id,
            caseRevision: entry.row.revision,
            caseSnapshot: caseDefinition(entry.row) as unknown as Prisma.InputJsonObject,
            variant: entry.variant as unknown as Prisma.InputJsonObject,
            variantLabel: evalVariantLabel(entry.variant),
            repetition: entry.repetition,
            position,
          })),
        },
      },
      select: { id: true },
    });
    await this.announce(input.workspaceId, created.id, 'created', input.correlationId);

    // Started after the answer, in a context of its own: the request's
    // context ends with the response, the attempts do not.
    void runWithRequestContext({ correlationId: input.correlationId }, () =>
      this.launchAll(created.id),
    );
    return this.get({ evalRunId: created.id, userId: input.userId });
  }

  /** Starts the run's queued attempts in order; one that cannot start ends as an error. */
  private async launchAll(evalRunId: string): Promise<void> {
    const queued = await this.prisma.evalAttempt.findMany({
      where: { evalRunId, status: 'QUEUED' },
      select: { id: true },
      orderBy: { position: 'asc' },
    });
    for (const attempt of queued) await this.launch(attempt.id);
  }

  /** Claims one queued attempt and starts its run. Safe to call twice: only one claim wins. */
  async launch(attemptId: string): Promise<void> {
    const claimed = await this.prisma.evalAttempt.updateMany({
      where: { id: attemptId, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count !== 1) return;
    try {
      await this.startAttemptRun(attemptId);
    } catch (error) {
      await this.settlement.failLaunch(attemptId, error);
    }
  }

  private async startAttemptRun(attemptId: string): Promise<void> {
    const attempt = await this.prisma.evalAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: {
        ...EVAL_ATTEMPT_SELECT,
        evalRun: { select: { createdById: true, label: true, createdAt: true } },
      },
    });
    const userId = attempt.evalRun.createdById;
    if (userId === null) throw new AppError('eval_case_invalid', 'The eval run has no owner');
    const definition = attemptDefinition(attempt);
    const variant = attemptVariant(attempt);
    const correlationId = `eval-${attempt.id}`;
    const title = `Eval: ${definition.name} · ${attempt.variantLabel} #${attempt.repetition}`;

    let documentId = definition.documentId;
    if (definition.replayMode === 'fixture' && definition.fixture !== null) {
      const containerId = await this.sandbox.container({
        evalRunId: attempt.evalRunId,
        workspaceId: attempt.workspaceId,
        userId,
        title: `Eval-Sandbox: ${attempt.evalRun.label ?? attempt.evalRun.createdAt.toISOString().slice(0, 16)}`,
        correlationId,
      });
      const built = await this.sandbox.build({
        attemptId: attempt.id,
        workspaceId: attempt.workspaceId,
        userId,
        containerId,
        title,
        fixture: definition.fixture,
        correlationId,
      });
      await this.prisma.evalAttempt.update({
        where: { id: attempt.id },
        data: { sandboxPages: built.pages as unknown as Prisma.InputJsonObject },
      });
      documentId = built.startId;
    }

    const { conversation } = await this.conversations.create({
      userId,
      request: {
        workspaceId: attempt.workspaceId,
        documentId,
        title: title.slice(0, 120),
        modelSlug: variant.modelSlug,
        reasoningLevel: variant.reasoningLevel,
      },
    });
    await this.prisma.evalAttempt.update({
      where: { id: attempt.id },
      data: { conversationId: conversation.id },
    });
    const posted = await this.conversations.postMessage({
      conversationId: conversation.id,
      userId,
      correlationId,
      evalAttemptId: attempt.id,
      request: { content: definition.prompt, documentId, reasoningLevel: variant.reasoningLevel },
    });
    if (posted.run !== null) {
      await this.prisma.evalAttempt.update({
        where: { id: attempt.id },
        data: { aiRunId: posted.run.id },
      });
    }
  }

  async list(input: { workspaceId: string; userId: string }): Promise<EvalRunListResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);
    const rows = await this.prisma.evalRun.findMany({
      where: { workspaceId: input.workspaceId },
      select: EVAL_RUN_SELECT,
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return { runs: rows.map(toEvalRun) };
  }

  async get(input: { evalRunId: string; userId: string }): Promise<EvalRunDetailResponse> {
    const row = await this.prisma.evalRun.findUnique({
      where: { id: input.evalRunId },
      select: EVAL_RUN_SELECT,
    });
    if (row === null) throw AppError.notFound('Eval run');
    await this.access.requireRole(row.workspaceId, input.userId);
    const attempts = await this.prisma.evalAttempt.findMany({
      where: { evalRunId: row.id },
      select: EVAL_ATTEMPT_SELECT,
      orderBy: { position: 'asc' },
    });
    const run = toEvalRun(row);
    const mapped = attempts.map((attempt) => toEvalAttempt(attempt, { includeAnswer: true }));
    return { run, attempts: mapped, comparison: buildComparison([run], mapped) };
  }

  /** Several runs side by side; every one must be in a workspace the caller reads. */
  async compare(input: { runIds: string[]; userId: string }): Promise<EvalComparison> {
    const rows = await this.prisma.evalRun.findMany({
      where: { id: { in: input.runIds } },
      select: EVAL_RUN_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length !== new Set(input.runIds).size) throw AppError.notFound('Eval run');
    for (const workspaceId of new Set(rows.map((row) => row.workspaceId))) {
      await this.access.requireRole(workspaceId, input.userId);
    }
    const attempts = await this.prisma.evalAttempt.findMany({
      where: { evalRunId: { in: rows.map((row) => row.id) } },
      select: EVAL_ATTEMPT_SELECT,
      orderBy: { position: 'asc' },
    });
    return buildComparison(
      rows.map(toEvalRun),
      attempts.map((attempt) => toEvalAttempt(attempt, { includeAnswer: false })),
    );
  }

  async getAttempt(input: { attemptId: string; userId: string }): Promise<EvalAttemptResponse> {
    const row = await this.prisma.evalAttempt.findUnique({
      where: { id: input.attemptId },
      select: EVAL_ATTEMPT_SELECT,
    });
    if (row === null) throw AppError.notFound('Eval attempt');
    await this.access.requireRole(row.workspaceId, input.userId);
    return { attempt: toEvalAttempt(row, { includeAnswer: true }) };
  }

  async cancel(input: {
    evalRunId: string;
    userId: string;
    correlationId: string;
  }): Promise<CancelEvalRunResponse> {
    const run = await this.loadRun(input.evalRunId);
    await this.assertMayRun(run.workspaceId, input.userId);
    const open = await this.prisma.evalAttempt.findMany({
      where: { evalRunId: run.id, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
      orderBy: { position: 'desc' },
    });
    let cancelled = 0;
    for (const attempt of open) {
      if (await this.settlement.settle(attempt.id, { cancelled: true })) cancelled += 1;
    }
    await this.announce(run.workspaceId, run.id, 'updated', input.correlationId);
    const { run: mapped } = await this.get({ evalRunId: run.id, userId: input.userId });
    return { run: mapped, cancelledAttempts: cancelled };
  }

  async delete(input: {
    evalRunId: string;
    userId: string;
    correlationId: string;
  }): Promise<DeleteEvalResponse> {
    const run = await this.loadRun(input.evalRunId);
    await this.assertMayRun(run.workspaceId, input.userId);
    // Cancelled first, so no sandbox, proposal or question outlives its run.
    await this.cancel(input);
    await this.prisma.evalRun.delete({ where: { id: run.id } });
    await this.announce(run.workspaceId, run.id, 'deleted', input.correlationId);
    return { deleted: true };
  }

  /**
   * A person's judgement of one attempt. It stands beside the outcome; only
   * the answers to `manual` checks move it, because those are checks too.
   */
  async review(input: {
    attemptId: string;
    userId: string;
    request: ReviewEvalAttemptRequest;
    correlationId: string;
  }): Promise<EvalAttemptResponse> {
    const row = await this.prisma.evalAttempt.findUnique({
      where: { id: input.attemptId },
      select: EVAL_ATTEMPT_SELECT,
    });
    if (row === null) throw AppError.notFound('Eval attempt');
    await this.assertMayRun(row.workspaceId, input.userId);
    if (row.status !== 'FINISHED') {
      throw new AppError('eval_attempt_not_finished', 'Only a finished attempt can be reviewed');
    }
    const { request } = input;
    const manual = { ...storedManual(row.reviewManual), ...request.manual };
    const attempt = toEvalAttempt(row, { includeAnswer: false });
    const manualIds = new Set(
      [...attemptDefinition(row).invariants, ...attemptDefinition(row).criteria]
        .filter((assertion) => assertion.kind === 'manual')
        .map((assertion) => assertion.id),
    );
    for (const id of Object.keys(request.manual ?? {})) {
      if (!manualIds.has(id))
        throw new AppError('eval_case_invalid', `"${id}" is not a manual check`);
    }
    const assertions = attempt.assertions.map((result) =>
      result.kind === 'manual' ? { ...result, passed: manual[result.id] ?? null } : result,
    );
    const outcome =
      attempt.outcome === 'error' || attempt.metrics === null
        ? attempt.outcome
        : outcomeOf(attempt.metrics.runStatus, assertions);

    await this.prisma.evalAttempt.update({
      where: { id: row.id },
      data: {
        ...(request.verdict === undefined
          ? {}
          : {
              reviewVerdict:
                request.verdict === null
                  ? null
                  : (request.verdict.toUpperCase() as 'PASSED' | 'FAILED'),
            }),
        ...(request.score === undefined ? {} : { reviewScore: request.score }),
        ...(request.note === undefined ? {} : { reviewNote: request.note }),
        reviewManual: manual as Prisma.InputJsonObject,
        assertions: assertions as unknown as Prisma.InputJsonArray,
        ...(outcome === null ? {} : { outcome: OUTCOME_TO_PRISMA[outcome] }),
        reviewedById: input.userId,
        reviewedAt: new Date(),
      },
    });
    await this.announce(row.workspaceId, row.evalRunId, 'updated', input.correlationId);
    return this.getAttempt({ attemptId: row.id, userId: input.userId });
  }

  private async loadRun(evalRunId: string) {
    const run = await this.prisma.evalRun.findUnique({
      where: { id: evalRunId },
      select: { id: true, workspaceId: true },
    });
    if (run === null) throw AppError.notFound('Eval run');
    return run;
  }

  /**
   * Who may start, stop and review evals: whoever may hand work over. Never a
   * run of the built-in AI: an eval measures it, and a run that starts
   * paid runs of itself would be spending without a person.
   */
  private async assertMayRun(workspaceId: string, userId: string): Promise<void> {
    if (currentAiRunId() !== undefined) {
      throw AppError.forbidden('A run of the built-in AI cannot start or change evals');
    }
    const role = await this.access.findRole(workspaceId, userId);
    if (role === null) throw AppError.notFound('Eval run');
    assertPolicy(canManageWorkItems(role));
  }

  /** A case whose page or profile has gone is refused, not quietly replayed as another task. */
  private async assertStartable(row: EvalCaseRow): Promise<void> {
    if (row.documentId !== null) {
      const page = await this.prisma.document.findFirst({
        where: { id: row.documentId, workspaceId: row.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (page === null) {
        throw new AppError('eval_case_invalid', `The start page of "${row.name}" is gone`);
      }
    }
    if (row.agentProfileId !== null) {
      const profile = await this.prisma.agentProfile.findFirst({
        where: { id: row.agentProfileId, workspaceId: row.workspaceId },
        select: { id: true },
      });
      if (profile === null) {
        throw new AppError('eval_case_invalid', `The agent profile of "${row.name}" is gone`);
      }
    }
  }

  private async assertModel(slug: string): Promise<void> {
    const model = await this.prisma.aiModel.findUnique({
      where: { slug },
      select: { enabled: true },
    });
    if (model === null) throw new AppError('ai_model_unknown', `Unknown AI model slug "${slug}"`);
    if (!model.enabled) throw new AppError('ai_model_disabled', `AI model "${slug}" is disabled`);
  }

  private async announce(
    workspaceId: string,
    evalRunId: string,
    action: 'created' | 'updated' | 'deleted',
    correlationId: string,
  ): Promise<void> {
    await this.realtime.emit('eval.changed', workspaceId, correlationId, {
      evalCaseId: null,
      evalRunId,
      action,
    });
  }
}

/**
 * The order attempts are made in: repetition by repetition, every case, with
 * the variants reversed on every other repetition, so no variant is always
 * the one that warms a provider's cache.
 */
export function attemptPlan(
  cases: readonly EvalCaseRow[],
  request: Pick<StartEvalRunRequest, 'variants' | 'repetitions'>,
): { row: EvalCaseRow; variant: StartEvalRunRequest['variants'][number]; repetition: number }[] {
  const plan = [];
  for (let repetition = 1; repetition <= request.repetitions; repetition += 1) {
    const variants = repetition % 2 === 0 ? [...request.variants].reverse() : request.variants;
    for (const row of cases) {
      for (const variant of variants) plan.push({ row, variant, repetition });
    }
  }
  return plan;
}
