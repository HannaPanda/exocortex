import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { type ApiEnv } from '@exocortex/config';
import { type PostConversationMessageResponse } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';

import { type ConversationsService } from '../ai/conversations.service';
import { type ChangesetsService } from '../changesets/changesets.service';
import { AppError } from '../common/app-error';
import { runWithRequestContext } from '../common/correlation';
import { type RealtimeService } from '../realtime/realtime.service';

import { EvalCasesService } from './eval-cases.service';
import { EvalRunsService } from './eval-runs.service';
import { type EvalSandboxService } from './eval-sandbox.service';
import { EvalSettlementService } from './eval-settlement.service';

/**
 * Evals against the real database (issue #146, ADR-074).
 *
 * The conversation service is a stand-in that writes the run row the real
 * one would, tagged with the attempt, and the sandbox is a stand-in too; what
 * is proven here is the eval's side: what a start freezes, how the attempts
 * are ordered, how a finished run is measured and decided, what a review
 * changes, and that nothing an attempt was allowed to leave behind survives
 * it.
 */
loadDotEnv();

const correlationId = 'test-correlation';
const logger = createLogger({ name: 'api-test', level: 'silent' });
const realtime = { emit: async () => undefined } as unknown as RealtimeService;

let prisma: PrismaClient;
let cases: EvalCasesService;
let runs: EvalRunsService;
let settlement: EvalSettlementService;
let workspaceId: string;
let ownerId: string;
let pageId: string;
const modelSlugs: string[] = [];
const sandboxFails = { value: false };

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; tries < 100; tries += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting');
}

/** Ends an attempt's run the way the worker would, with one tool call recorded. */
async function finishRun(attemptId: string, answer: string, toolName = 'exo_search') {
  const run = await prisma.aiRun.findFirstOrThrow({ where: { evalAttemptId: attemptId } });
  const now = new Date();
  await prisma.aiRun.update({
    where: { id: run.id },
    data: {
      status: 'COMPLETED',
      resultText: answer,
      startedAt: new Date(now.getTime() - 4_000),
      finishedAt: now,
      inputTokens: 1_000,
      outputTokens: 100,
      providerCostMicroUsd: 700,
    },
  });
  await prisma.aiRunEvent.create({
    data: {
      runId: run.id,
      sequence: 1,
      kind: 'tool_call',
      at: now,
      durationMs: 20,
      data: {
        iteration: 1,
        toolName,
        status: 'succeeded',
        target: null,
        resultChars: 10,
        resultTruncated: false,
        untrustedOrigin: null,
        repeated: false,
        pausedRun: false,
      },
    },
  });
  return run;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma);
  const conversations = {
    create: async (input: { userId: string; request: { workspaceId: string; title?: string } }) => {
      const conversation = await prisma.aiConversation.create({
        data: {
          workspaceId: input.request.workspaceId,
          createdById: input.userId,
          title: input.request.title ?? 'Eval',
        },
      });
      return { conversation: { id: conversation.id } };
    },
    postMessage: async (input: {
      conversationId: string;
      userId: string;
      evalAttemptId?: string;
      request: { content: string };
    }): Promise<Pick<PostConversationMessageResponse, 'run'>> => {
      const run = await prisma.aiRun.create({
        data: {
          workspaceId,
          createdById: input.userId,
          provider: 'mock',
          model: 'mock/model',
          messages: [{ role: 'user', content: input.request.content }],
          conversationId: input.conversationId,
          evalAttemptId: input.evalAttemptId ?? null,
          status: 'PENDING',
        },
      });
      return { run: { id: run.id } as PostConversationMessageResponse['run'] };
    },
  } as unknown as ConversationsService;
  const sandbox = {
    container: async () => {
      if (sandboxFails.value) throw new AppError('document_access_denied', 'no');
      return 'container';
    },
    build: async () => ({ rootId: 'root', pages: {}, startId: 'root' }),
    read: async () => ({
      pages: {},
      changedPages: 0,
      createdPages: [],
      createdCount: 0,
      truncated: false,
    }),
    destroy: async () => undefined,
  } as unknown as EvalSandboxService;
  const changesets = { reject: async () => undefined } as unknown as ChangesetsService;

  settlement = new EvalSettlementService(
    prisma,
    logger,
    { REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6382' } as ApiEnv,
    sandbox,
    changesets,
    realtime,
  );
  cases = new EvalCasesService(prisma, access, realtime);
  runs = new EvalRunsService(prisma, access, conversations, sandbox, settlement, realtime);
  runs.onModuleInit();

  const suffix = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `ev-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
  });
  ownerId = owner.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Evals ${suffix}`,
      slug: `evals-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;
  const page = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Issue',
      orderKey: 'a0',
      createdById: ownerId,
      updatedById: ownerId,
    },
  });
  pageId = page.id;
  for (const name of ['fast', 'slow']) {
    const slug = `test/${name}-${suffix}`;
    modelSlugs.push(slug);
    await prisma.aiModel.create({
      data: {
        slug,
        displayName: name,
        contextWindowTokens: 100_000,
        inputMicroUsdPerMTok: 1,
        outputMicroUsdPerMTok: 1,
      },
    });
  }
});

afterAll(async () => {
  await prisma.evalRun.deleteMany({ where: { workspaceId } });
  await prisma.evalCase.deleteMany({ where: { workspaceId } });
  await prisma.aiRun.deleteMany({ where: { workspaceId } });
  await prisma.aiModel.deleteMany({ where: { slug: { in: modelSlugs } } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

async function planCase(name: string) {
  const { evalCase } = await cases.create({
    workspaceId,
    userId: ownerId,
    correlationId,
    request: {
      name,
      suite: 'regression',
      prompt: 'Analysiere das Issue und mach einen Plan.',
      replayMode: 'read_only',
      documentId: pageId,
      invariants: [{ id: 'keine-aenderung', kind: 'no_changes' }],
      criteria: [
        { id: 'adr', kind: 'answer_contains', text: 'ADR-063', caseSensitive: false },
        { id: 'umsetzbar', kind: 'manual', text: 'Der Plan ist umsetzbar' },
      ],
    },
  });
  return evalCase;
}

describe('eval cases', () => {
  it('refuses a start page outside the workspace and a name twice', async () => {
    await expect(
      cases.create({
        workspaceId,
        userId: ownerId,
        correlationId,
        request: {
          name: 'Fremd',
          prompt: 'x',
          replayMode: 'read_only',
          documentId: 'doc-not-here-123',
          invariants: [],
          criteria: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'eval_case_invalid' });
    await planCase('Doppelt');
    await expect(planCase('Doppelt')).rejects.toMatchObject({ code: 'eval_case_name_taken' });
  });

  it('moves the revision on every edit and refuses a check the mode cannot decide', async () => {
    const created = await planCase('Revision');
    const { evalCase } = await cases.update({
      caseId: created.id,
      userId: ownerId,
      correlationId,
      request: { prompt: 'Anders gefragt' },
    });
    expect(evalCase.revision).toBe(2);
    await expect(
      cases.update({
        caseId: created.id,
        userId: ownerId,
        correlationId,
        request: { criteria: [{ id: 'p', kind: 'proposed_changes', min: 1, max: null }] },
      }),
    ).rejects.toMatchObject({ code: 'eval_case_invalid' });
  });

  it('exports a suite and reads it back unchanged', async () => {
    const file = await cases.exportSuite({ workspaceId, suite: 'regression', userId: ownerId });
    expect(file.cases.length).toBeGreaterThan(0);
    const result = await cases.importSuite({
      workspaceId,
      userId: ownerId,
      correlationId,
      request: { file },
    });
    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: file.cases.length });
  });

  it('is not the built-in AI’s to change', async () => {
    await expect(
      runWithRequestContext({ correlationId, aiRunId: 'run-x' }, () => planCase('Von der KI')),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('eval runs', () => {
  it('replays a case per variant and repetition, alternating the order', async () => {
    const evalCase = await planCase('Plan erstellen');
    const started = await runs.start({
      workspaceId,
      userId: ownerId,
      correlationId,
      request: {
        caseIds: [evalCase.id],
        variants: [
          { modelSlug: modelSlugs[0]!, reasoningLevel: 'none', providerRouting: null, label: 'A' },
          { modelSlug: modelSlugs[1]!, reasoningLevel: 'none', providerRouting: null, label: 'B' },
        ],
        repetitions: 2,
      },
    });
    expect(started.attempts.map((attempt) => attempt.variantLabel)).toEqual(['A', 'B', 'B', 'A']);

    const launched = await waitFor(
      () =>
        prisma.evalAttempt.findMany({
          where: { evalRunId: started.run.id },
          orderBy: { position: 'asc' },
        }),
      (rows) => rows.every((row) => row.status === 'RUNNING' && row.aiRunId !== null),
    );
    // The run carries the attempt from the moment it exists.
    const tagged = await prisma.aiRun.count({
      where: { evalAttemptId: { in: launched.map((row) => row.id) } },
    });
    expect(tagged).toBe(4);

    // Still running: nothing to settle.
    expect(await settlement.settle(launched[0]!.id)).toBe(false);

    await finishRun(launched[0]!.id, 'Der Plan folgt ADR-063.');
    await finishRun(launched[1]!.id, 'Ein Plan ohne Verweis.');
    expect(await settlement.settle(launched[0]!.id)).toBe(true);
    expect(await settlement.settle(launched[0]!.id)).toBe(false);
    await settlement.settle(launched[1]!.id);

    const { attempt: passed } = await runs.getAttempt({
      attemptId: launched[0]!.id,
      userId: ownerId,
    });
    expect(passed).toMatchObject({ status: 'finished', outcome: 'passed' });
    expect(passed.metrics).toMatchObject({
      toolCalls: 1,
      tools: { exo_search: 1 },
      costMicroUsd: 700,
      durationMs: 4_000,
    });
    expect(passed.assertions.find((result) => result.id === 'umsetzbar')?.passed).toBeNull();
    expect(passed.answer).toContain('ADR-063');
    const conversation = await prisma.aiConversation.findUniqueOrThrow({
      where: { id: launched[0]!.conversationId! },
    });
    expect(conversation.archivedAt).not.toBeNull();

    const { attempt: failed } = await runs.getAttempt({
      attemptId: launched[1]!.id,
      userId: ownerId,
    });
    expect(failed.outcome).toBe('failed');

    // A review answers the manual check, and that is a check like any other.
    const { attempt: reviewed } = await runs.review({
      attemptId: launched[0]!.id,
      userId: ownerId,
      correlationId,
      request: { verdict: 'failed', score: 2, note: 'zu vage', manual: { umsetzbar: false } },
    });
    expect(reviewed).toMatchObject({ outcome: 'failed', review: { verdict: 'failed', score: 2 } });
    await expect(
      runs.review({
        attemptId: launched[2]!.id,
        userId: ownerId,
        correlationId,
        request: { verdict: 'passed' },
      }),
    ).rejects.toMatchObject({ code: 'eval_attempt_not_finished' });

    // Cancelling ends the two still running, and their runs with them.
    const cancelled = await runs.cancel({
      evalRunId: started.run.id,
      userId: ownerId,
      correlationId,
    });
    expect(cancelled.cancelledAttempts).toBe(2);
    const runStatuses = await prisma.aiRun.findMany({
      where: { evalAttemptId: { in: [launched[2]!.id, launched[3]!.id] } },
      select: { status: true },
    });
    expect(runStatuses.map((row) => row.status)).toEqual(['CANCELLED', 'CANCELLED']);

    const detail = await runs.get({ evalRunId: started.run.id, userId: ownerId });
    expect(detail.run.counts).toMatchObject({ finished: 2, cancelled: 2, failed: 2 });
    expect(detail.comparison.cells.map((cell) => [cell.variantLabel, cell.finished])).toEqual([
      ['A', 1],
      ['B', 1],
    ]);
  });

  it('refuses more attempts than one run may start, and a disabled model', async () => {
    const evalCase = await planCase('Zu groß');
    await planCase('Zu groß 2');
    await planCase('Zu groß 3');
    const variant = {
      modelSlug: modelSlugs[0]!,
      reasoningLevel: 'none' as const,
      providerRouting: null,
      label: null,
    };
    // Three cases from the suite, six variants, five repetitions: 90 attempts.
    await expect(
      runs.start({
        workspaceId,
        userId: ownerId,
        correlationId,
        request: {
          suite: 'regression',
          variants: Array.from({ length: 6 }, (_, index) => ({ ...variant, label: `v${index}` })),
          repetitions: 5,
        },
      }),
    ).rejects.toMatchObject({ code: 'eval_run_too_large' });
    await prisma.aiModel.update({ where: { slug: modelSlugs[1]! }, data: { enabled: false } });
    await expect(
      runs.start({
        workspaceId,
        userId: ownerId,
        correlationId,
        request: {
          caseIds: [evalCase.id],
          variants: [{ ...variant, modelSlug: modelSlugs[1]! }],
          repetitions: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'ai_model_disabled' });
    await prisma.aiModel.update({ where: { slug: modelSlugs[1]! }, data: { enabled: true } });
  });

  it('ends an attempt whose sandbox cannot be built as an error, not as a model failure', async () => {
    const { evalCase } = await cases.create({
      workspaceId,
      userId: ownerId,
      correlationId,
      request: {
        name: 'Fixture',
        prompt: 'Verschiebe Abschnitt B.',
        replayMode: 'fixture',
        fixture: {
          pages: [{ key: 'notizen', title: 'Notizen', markdown: '# A\n\n# B', parentKey: null }],
          startKey: 'notizen',
        },
        invariants: [],
        criteria: [
          { id: 'b', kind: 'page_contains', page: 'notizen', text: 'B', caseSensitive: false },
        ],
      },
    });
    sandboxFails.value = true;
    const started = await runs.start({
      workspaceId,
      userId: ownerId,
      correlationId,
      request: {
        caseIds: [evalCase.id],
        variants: [
          { modelSlug: modelSlugs[0]!, reasoningLevel: 'none', providerRouting: null, label: null },
        ],
        repetitions: 1,
      },
    });
    const [attempt] = await waitFor(
      () => prisma.evalAttempt.findMany({ where: { evalRunId: started.run.id } }),
      (rows) => rows.every((row) => row.status === 'FINISHED'),
    );
    sandboxFails.value = false;
    expect(attempt).toMatchObject({ outcome: 'ERROR', errorCode: 'document_access_denied' });
    expect(await prisma.aiRun.count({ where: { evalAttemptId: attempt!.id } })).toBe(0);
  });

  it('compares two runs of the same case side by side', async () => {
    const listed = await runs.list({ workspaceId, userId: ownerId });
    const ids = listed.runs.slice(0, 2).map((run) => run.id);
    const comparison = await runs.compare({ runIds: ids, userId: ownerId });
    expect(comparison.runs).toHaveLength(2);
  });
});
