import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageWorkItems, WorkspaceAccessService } from '@exocortex/auth';
import {
  aiMessageSchema,
  assertionsProblem,
  type CreateEvalCaseRequest,
  createEvalCaseRequestSchema,
  type DeleteEvalResponse,
  EVAL_SUITE_FORMAT,
  type EvalCaseFromRunRequest,
  type EvalCaseListQuery,
  type EvalCaseListResponse,
  type EvalCaseResponse,
  type EvalFixture,
  fixtureProblem,
  type ImportEvalSuiteRequest,
  type ImportEvalSuiteResponse,
  type EvalSuiteFile,
  TOOL_DOMAINS,
  type UpdateEvalCaseRequest,
} from '@exocortex/contracts';
import { Prisma, type PrismaClient } from '@exocortex/database';
import { serializeMarkdown, yjsStateToProseMirrorJson } from '@exocortex/editor';

import { AppError } from '../common/app-error';
import { currentAiRunId } from '../common/correlation';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import {
  caseDefinition,
  EVAL_ATTEMPT_SELECT,
  EVAL_CASE_SELECT,
  type EvalCaseRow,
  REPLAY_MODE_TO_PRISMA,
  toEvalAttempt,
  toEvalCase,
} from './eval-mapper';

/** How many of a case's latest attempts its detail carries. */
const RECENT_ATTEMPTS = 30;
/** The characters of a page a case taken from a run keeps as its fixture. */
const FROM_RUN_FIXTURE_CHARS = 100_000;

type CaseFields = Omit<CreateEvalCaseRequest, 'name'> & { name?: string };

/**
 * Eval cases (issue #146, ADR-074): the tasks themselves.
 *
 * Reading is anybody's in the workspace, writing whoever may hand work over
 * (MEMBER), and never a run of the built-in AI: a case is what measures the
 * assistant, and a run that could rewrite its own exam would not be measured
 * by it. Every edit moves the revision; an attempt keeps the definition it
 * was made against, so editing a case never rewrites an old measurement.
 */
@Injectable()
export class EvalCasesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(input: {
    workspaceId: string;
    userId: string;
    query: EvalCaseListQuery;
  }): Promise<EvalCaseListResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);
    const [rows, suites] = await Promise.all([
      this.prisma.evalCase.findMany({
        where: {
          workspaceId: input.workspaceId,
          ...(input.query.suite === undefined ? {} : { suite: input.query.suite }),
        },
        select: EVAL_CASE_SELECT,
        orderBy: [{ suite: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.evalCase.findMany({
        where: { workspaceId: input.workspaceId, suite: { not: null } },
        select: { suite: true },
        distinct: ['suite'],
        orderBy: { suite: 'asc' },
      }),
    ]);
    const names = await this.names(rows);
    return {
      cases: rows.map((row) =>
        toEvalCase(row, { ...names, lastAttemptAt: names.lastAttempts.get(row.id) ?? null }),
      ),
      suites: suites.flatMap((row) => (row.suite === null ? [] : [row.suite])),
    };
  }

  async get(input: { caseId: string; userId: string }): Promise<EvalCaseResponse> {
    const row = await this.loadRow(input.caseId);
    await this.access.requireRole(row.workspaceId, input.userId);
    const [names, attempts] = await Promise.all([
      this.names([row]),
      this.prisma.evalAttempt.findMany({
        where: { caseId: row.id },
        select: EVAL_ATTEMPT_SELECT,
        orderBy: { createdAt: 'desc' },
        take: RECENT_ATTEMPTS,
      }),
    ]);
    return {
      evalCase: toEvalCase(row, {
        ...names,
        lastAttemptAt: names.lastAttempts.get(row.id) ?? null,
      }),
      recentAttempts: attempts.map((attempt) => toEvalAttempt(attempt, { includeAnswer: false })),
    };
  }

  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateEvalCaseRequest;
    correlationId: string;
    sourceRunId?: string;
  }): Promise<EvalCaseResponse> {
    await this.assertMayWrite(input.workspaceId, input.userId);
    await this.validate(input.workspaceId, input.request);
    const created = await this.writeUnique(() =>
      this.prisma.evalCase.create({
        data: {
          ...(this.columns(input.request) as Omit<
            Prisma.EvalCaseUncheckedCreateInput,
            'workspaceId' | 'name' | 'prompt' | 'replayMode'
          >),
          workspaceId: input.workspaceId,
          name: input.request.name,
          prompt: input.request.prompt,
          replayMode: REPLAY_MODE_TO_PRISMA[input.request.replayMode],
          sourceRunId: input.sourceRunId ?? null,
          createdById: input.userId,
          updatedById: input.userId,
        },
        select: { id: true },
      }),
    );
    await this.announce(input.workspaceId, created.id, 'created', input.correlationId);
    return this.get({ caseId: created.id, userId: input.userId });
  }

  async update(input: {
    caseId: string;
    userId: string;
    request: UpdateEvalCaseRequest;
    correlationId: string;
  }): Promise<EvalCaseResponse> {
    const existing = await this.loadRow(input.caseId);
    await this.assertMayWrite(existing.workspaceId, input.userId);
    // The cross-field rules hold for the case as it will be, not for the patch.
    const merged = { ...caseDefinition(existing), ...input.request };
    const parsed = createEvalCaseRequestSchema.safeParse(merged);
    if (!parsed.success) {
      throw new AppError('eval_case_invalid', parsed.error.issues[0]?.message ?? 'Invalid case');
    }
    await this.validate(existing.workspaceId, parsed.data);
    await this.writeUnique(() =>
      this.prisma.evalCase.update({
        where: { id: existing.id },
        data: {
          ...this.columns(input.request),
          revision: { increment: 1 },
          updatedById: input.userId,
        },
      }),
    );
    await this.announce(existing.workspaceId, existing.id, 'updated', input.correlationId);
    return this.get({ caseId: existing.id, userId: input.userId });
  }

  /** The attempts stay: they carry the case they were made against. */
  async delete(input: {
    caseId: string;
    userId: string;
    correlationId: string;
  }): Promise<DeleteEvalResponse> {
    const existing = await this.loadRow(input.caseId);
    await this.assertMayWrite(existing.workspaceId, input.userId);
    await this.prisma.evalCase.delete({ where: { id: existing.id } });
    await this.announce(existing.workspaceId, existing.id, 'deleted', input.correlationId);
    return { deleted: true };
  }

  /**
   * A case from a real run: its prompt, its page and its profile. In the
   * fixture mode the page is copied as it reads now, which after a run that
   * changed it is the changed page; the person names the mode knowing that.
   */
  async fromRun(input: {
    runId: string;
    userId: string;
    request: EvalCaseFromRunRequest;
    correlationId: string;
  }): Promise<EvalCaseResponse> {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: input.runId },
      select: {
        id: true,
        workspaceId: true,
        documentId: true,
        agentProfileId: true,
        messages: true,
        payloadsPrunedAt: true,
      },
    });
    if (run === null) throw AppError.notFound('AI run');
    await this.access.requireRole(run.workspaceId, input.userId);
    const messages = aiMessageSchema.array().safeParse(run.messages);
    const prompt = messages.success
      ? messages.data.find((message) => message.role === 'user')?.content.trim()
      : undefined;
    if (prompt === undefined || prompt.length === 0) {
      throw new AppError('eval_case_invalid', 'The run kept no prompt to replay');
    }

    const { replayMode } = input.request;
    const fixture = replayMode === 'fixture' ? await this.fixtureFrom(run.documentId) : null;
    const profileId =
      run.agentProfileId === null
        ? null
        : ((
            await this.prisma.agentProfile.findFirst({
              where: { id: run.agentProfileId, workspaceId: run.workspaceId },
              select: { id: true },
            })
          )?.id ?? null);

    return this.create({
      workspaceId: run.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      sourceRunId: run.id,
      request: {
        name: input.request.name,
        description: input.request.description ?? null,
        suite: input.request.suite ?? null,
        prompt: prompt.slice(0, 20_000),
        replayMode,
        documentId: replayMode === 'fixture' ? null : run.documentId,
        fixture,
        agentProfileId: profileId,
        invariants: [],
        criteria: [],
      },
    });
  }

  /** A suite as a file a repository can keep. */
  async exportSuite(input: {
    workspaceId: string;
    suite: string;
    userId: string;
  }): Promise<EvalSuiteFile> {
    await this.access.requireRole(input.workspaceId, input.userId);
    const rows = await this.prisma.evalCase.findMany({
      where: { workspaceId: input.workspaceId, suite: input.suite },
      select: EVAL_CASE_SELECT,
      orderBy: { name: 'asc' },
    });
    if (rows.length === 0) throw AppError.notFound('Eval suite');
    return {
      format: EVAL_SUITE_FORMAT,
      suite: input.suite,
      exportedAt: new Date().toISOString(),
      cases: rows.map((row) => {
        const definition = caseDefinition(row);
        return { ...definition, suite: input.suite };
      }),
    };
  }

  /**
   * Takes a suite file over, case by case and matched by name. A case that
   * names a page or a profile this workspace does not have is taken without
   * it and says so, rather than failing the file.
   */
  async importSuite(input: {
    workspaceId: string;
    userId: string;
    request: ImportEvalSuiteRequest;
    correlationId: string;
  }): Promise<ImportEvalSuiteResponse> {
    await this.assertMayWrite(input.workspaceId, input.userId);
    const suite = input.request.suite ?? input.request.file.suite;
    const result: ImportEvalSuiteResponse = { created: 0, updated: 0, unchanged: 0, skipped: [] };
    for (const entry of input.request.file.cases) {
      const request = await this.bindable(input.workspaceId, { ...entry, suite });
      const parsed = createEvalCaseRequestSchema.safeParse(request);
      if (!parsed.success) {
        result.skipped.push({ name: entry.name, reason: parsed.error.issues[0]?.message ?? '' });
        continue;
      }
      const existing = await this.prisma.evalCase.findUnique({
        where: { workspaceId_name: { workspaceId: input.workspaceId, name: entry.name } },
        select: EVAL_CASE_SELECT,
      });
      try {
        if (existing === null) {
          await this.create({ ...input, request: parsed.data });
          result.created += 1;
        } else if (sameDefinition(existing, parsed.data)) {
          result.unchanged += 1;
        } else {
          const { name: _name, ...rest } = parsed.data;
          await this.update({
            caseId: existing.id,
            userId: input.userId,
            request: rest,
            correlationId: input.correlationId,
          });
          result.updated += 1;
        }
      } catch (error) {
        result.skipped.push({
          name: entry.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  /** A page and a profile are kept only where they exist in this workspace. */
  private async bindable<T extends { documentId?: string | null; agentProfileId?: string | null }>(
    workspaceId: string,
    entry: T,
  ): Promise<T> {
    const [page, profile] = await Promise.all([
      entry.documentId == null
        ? null
        : this.prisma.document.findFirst({
            where: { id: entry.documentId, workspaceId, archivedAt: null },
            select: { id: true },
          }),
      entry.agentProfileId == null
        ? null
        : this.prisma.agentProfile.findFirst({
            where: { id: entry.agentProfileId, workspaceId },
            select: { id: true },
          }),
    ]);
    return { ...entry, documentId: page?.id ?? null, agentProfileId: profile?.id ?? null };
  }

  private async fixtureFrom(documentId: string | null): Promise<EvalFixture> {
    if (documentId === null) {
      throw new AppError('eval_case_invalid', 'The run stood on no page to copy as a fixture');
    }
    const row = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { title: true, content: { select: { yjsState: true } } },
    });
    if (row === null) throw new AppError('eval_case_invalid', 'The run’s page is gone');
    const markdown =
      row.content === null
        ? ''
        : serializeMarkdown(yjsStateToProseMirrorJson(row.content.yjsState));
    return {
      pages: [
        {
          key: 'seite',
          title: row.title.slice(0, 300),
          markdown: markdown.slice(0, FROM_RUN_FIXTURE_CHARS),
          parentKey: null,
        },
      ],
      startKey: 'seite',
    };
  }

  private async assertMayWrite(workspaceId: string, userId: string): Promise<void> {
    if (currentAiRunId() !== undefined) {
      throw AppError.forbidden('A run of the built-in AI cannot change eval cases');
    }
    const role = await this.access.findRole(workspaceId, userId);
    if (role === null) throw AppError.notFound('Eval case');
    assertPolicy(canManageWorkItems(role));
  }

  private async loadRow(caseId: string): Promise<EvalCaseRow> {
    const row = await this.prisma.evalCase.findUnique({
      where: { id: caseId },
      select: EVAL_CASE_SELECT,
    });
    if (row === null) throw AppError.notFound('Eval case');
    return row;
  }

  /** The start page must be a live page here, the profile one of this workspace's. */
  private async validate(workspaceId: string, request: CreateEvalCaseRequest): Promise<void> {
    if (request.documentId != null) {
      const page = await this.prisma.document.findFirst({
        where: { id: request.documentId, workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (page === null) {
        throw new AppError(
          'eval_case_invalid',
          'The start page is not a live page of this workspace',
        );
      }
    }
    if (request.agentProfileId != null) {
      const profile = await this.prisma.agentProfile.findFirst({
        where: { id: request.agentProfileId, workspaceId },
        select: { id: true },
      });
      if (profile === null) {
        throw new AppError('eval_case_invalid', 'The agent profile is not one of this workspace');
      }
    }
    // Repeated from the contract for the update path, which merges first.
    const fixture = request.fixture ?? null;
    const problem =
      (fixture === null ? null : fixtureProblem(fixture)) ??
      assertionsProblem({
        replayMode: request.replayMode,
        fixture,
        assertions: [...request.invariants, ...request.criteria],
      });
    if (problem !== null) throw new AppError('eval_case_invalid', problem);
  }

  /** The columns a request sets; absent leaves a column alone, null clears it. */
  private columns(
    request: Partial<CaseFields>,
  ): Omit<Prisma.EvalCaseUncheckedUpdateInput, 'revision'> {
    const data: Omit<Prisma.EvalCaseUncheckedUpdateInput, 'revision'> = {};
    if (request.name !== undefined) data.name = request.name;
    if (request.description !== undefined) data.description = emptyToNull(request.description);
    if (request.suite !== undefined) data.suite = emptyToNull(request.suite);
    if (request.prompt !== undefined) data.prompt = request.prompt;
    if (request.replayMode !== undefined)
      data.replayMode = REPLAY_MODE_TO_PRISMA[request.replayMode];
    if (request.documentId !== undefined) data.documentId = request.documentId;
    if (request.fixture !== undefined) {
      data.fixture =
        request.fixture === null
          ? Prisma.DbNull
          : (request.fixture as unknown as Prisma.InputJsonObject);
    }
    if (request.agentProfileId !== undefined) data.agentProfileId = request.agentProfileId;
    if (request.toolDomains !== undefined) {
      data.toolDomains =
        request.toolDomains === null
          ? Prisma.DbNull
          : TOOL_DOMAINS.filter((domain) => request.toolDomains!.includes(domain));
    }
    if (request.budgetMicroUsd !== undefined) data.budgetMicroUsd = request.budgetMicroUsd;
    if (request.maxToolIterations !== undefined) data.maxToolIterations = request.maxToolIterations;
    if (request.maxRunSeconds !== undefined) data.maxRunSeconds = request.maxRunSeconds;
    if (request.invariants !== undefined) {
      data.invariants = request.invariants as unknown as Prisma.InputJsonArray;
    }
    if (request.criteria !== undefined) {
      data.criteria = request.criteria as unknown as Prisma.InputJsonArray;
    }
    if (request.expectedOutcome !== undefined) {
      data.expectedOutcome = emptyToNull(request.expectedOutcome);
    }
    return data;
  }

  /** Runs a write, turning a clash on the unique name into its own code. */
  private async writeUnique<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(
          'eval_case_name_taken',
          'Another eval case in this workspace has that name',
        );
      }
      throw error;
    }
  }

  /** Titles and names the cases point at, and when each was last attempted. */
  private async names(rows: readonly EvalCaseRow[]) {
    const documentIds = rows.flatMap((row) => (row.documentId === null ? [] : [row.documentId]));
    const profileIds = rows.flatMap((row) =>
      row.agentProfileId === null ? [] : [row.agentProfileId],
    );
    const [documents, profiles, last] = await Promise.all([
      documentIds.length === 0
        ? []
        : this.prisma.document.findMany({
            where: { id: { in: documentIds }, archivedAt: null },
            select: { id: true, title: true },
          }),
      profileIds.length === 0
        ? []
        : this.prisma.agentProfile.findMany({
            where: { id: { in: profileIds } },
            select: { id: true, name: true },
          }),
      this.prisma.evalAttempt.groupBy({
        by: ['caseId'],
        where: { caseId: { in: rows.map((row) => row.id) } },
        _max: { createdAt: true },
      }),
    ]);
    return {
      documents: new Map(documents.map((row) => [row.id, row.title])),
      profiles: new Map(profiles.map((row) => [row.id, row.name])),
      lastAttempts: new Map(
        last.flatMap((row) =>
          row.caseId === null || row._max.createdAt === null
            ? []
            : [[row.caseId, row._max.createdAt]],
        ),
      ),
    };
  }

  private async announce(
    workspaceId: string,
    evalCaseId: string,
    action: 'created' | 'updated' | 'deleted',
    correlationId: string,
  ): Promise<void> {
    await this.realtime.emit('eval.changed', workspaceId, correlationId, {
      evalCaseId,
      evalRunId: null,
      action,
    });
  }
}

function emptyToNull(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}

/** Whether an imported case says what the stored one says already. */
function sameDefinition(row: EvalCaseRow, request: CreateEvalCaseRequest): boolean {
  const stored = caseDefinition(row);
  const incoming = {
    ...stored,
    description: request.description ?? null,
    suite: request.suite ?? null,
    prompt: request.prompt,
    replayMode: request.replayMode,
    documentId: request.documentId ?? null,
    fixture: request.fixture ?? null,
    agentProfileId: request.agentProfileId ?? null,
    toolDomains: request.toolDomains ?? null,
    budgetMicroUsd: request.budgetMicroUsd ?? null,
    maxToolIterations: request.maxToolIterations ?? null,
    maxRunSeconds: request.maxRunSeconds ?? null,
    invariants: request.invariants,
    criteria: request.criteria,
    expectedOutcome: request.expectedOutcome ?? null,
  };
  return JSON.stringify(stored) === JSON.stringify(incoming);
}
