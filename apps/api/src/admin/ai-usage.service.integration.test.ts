import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';

import { AiUsageService } from './ai-usage.service';

/**
 * The AI usage report (issue #10).
 *
 * The whole point of the endpoint is arithmetic, so the test is about whether
 * the arithmetic is honest rather than whether a route answers. Three
 * properties matter and none of them is obvious from the SQL:
 *
 *   * measured and estimated cost never merge into one figure,
 *   * a cancelled run does not count against the success rate,
 *   * a day on which nothing ran still appears in the series.
 *
 * The fixture runs live in the year 2000 so this can aggregate over a window
 * no real run of this deployment can fall into -- the integration tests here
 * talk to the production database.
 */
loadDotEnv();

const FROM = new Date('2000-01-01T00:00:00.000Z');
const TO = new Date('2000-01-06T00:00:00.000Z');

let prisma: PrismaClient;
let service: AiUsageService;
let userId: string;
let workspaceId: string;

/** `createdAt` on the given day of January 2000, at midday local time. */
function day(index: number): Date {
  return new Date(2000, 0, index, 12, 0, 0);
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  service = new AiUsageService(prisma);

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `usage-${suffix}@exocortex.test`, name: 'Usage', emailVerified: true },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Usage ${suffix}`,
      slug: `usage-${suffix}`,
      members: { create: [{ userId, role: 'OWNER' }] },
    },
  });
  workspaceId = workspace.id;

  const base = { workspaceId, createdById: userId, provider: 'mock', messages: [] };
  await prisma.aiRun.createMany({
    data: [
      // Day 1: two completed runs, one priced by the provider, one estimated.
      {
        ...base,
        model: 'mock/a',
        status: 'COMPLETED',
        createdAt: day(1),
        inputTokens: 1_000,
        outputTokens: 200,
        cachedInputTokens: 400,
        providerCostMicroUsd: 5_000,
        durationMs: 2_000,
        toolIterations: 1,
      },
      {
        ...base,
        model: 'mock/a',
        status: 'COMPLETED',
        createdAt: day(1),
        inputTokens: 500,
        outputTokens: 100,
        cachedInputTokens: 0,
        estimatedCostMicroUsd: 3_000,
        durationMs: 4_000,
      },
      // Day 2: one failure and one cancellation. The cancellation must not
      // touch the success rate, the failure must show up under its code.
      {
        ...base,
        model: 'mock/b',
        status: 'FAILED',
        errorCode: 'ai_provider_error',
        createdAt: day(2),
        inputTokens: 100,
        outputTokens: 0,
        cachedInputTokens: 0,
        durationMs: 500,
      },
      {
        ...base,
        model: 'mock/b',
        status: 'CANCELLED',
        errorCode: 'ai_cancelled',
        createdAt: day(2),
      },
      // Day 4: a timeout. Day 3 stays empty on purpose.
      {
        ...base,
        model: 'mock/b',
        status: 'TIMED_OUT',
        errorCode: 'ai_timeout',
        createdAt: day(4),
      },
    ],
  });
});

afterAll(async () => {
  await prisma.aiRun.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('the usage report', () => {
  it('keeps reported and estimated cost apart instead of adding them up', async () => {
    const usage = await service.usage({ from: FROM.toISOString(), to: TO.toISOString() });

    expect(usage.cost.measuredMicroUsd).toBe(5_000);
    expect(usage.cost.estimatedMicroUsd).toBe(3_000);
    expect(usage.cost.measuredRuns).toBe(1);
    expect(usage.cost.estimatedRuns).toBe(1);
    // The failed run recorded tokens but has no price from either side.
    expect(usage.cost.unpricedRuns).toBe(1);
  });

  it('counts a cancelled run in neither half of the success rate', async () => {
    const usage = await service.usage({ from: FROM.toISOString(), to: TO.toISOString() });

    expect(usage.runs).toBe(5);
    expect(usage.byStatus.cancelled).toBe(1);
    // Two completed out of two completed + one failed + one timed out.
    expect(usage.successRate).toBeCloseTo(2 / 4, 6);
  });

  it('reports tokens, duration percentiles and tool iterations', async () => {
    const usage = await service.usage({ from: FROM.toISOString(), to: TO.toISOString() });

    expect(usage.tokens).toEqual({ input: 1_600, output: 300, cachedInput: 400 });
    expect(usage.medianDurationMs).toBe(2_000);
    expect(usage.p95DurationMs).toBe(3_800);
    expect(usage.toolIterations).toBe(1);
  });

  it('breaks the runs down by model, busiest first', async () => {
    const usage = await service.usage({ from: FROM.toISOString(), to: TO.toISOString() });

    const [busiest] = usage.byModel;
    expect(busiest?.model).toBe('mock/b');
    expect(busiest?.runs).toBe(3);
    expect(busiest?.completedRuns).toBe(0);
    // The cancellation is not a failure here either.
    expect(busiest?.failedRuns).toBe(2);

    const other = usage.byModel.find((row) => row.model === 'mock/a');
    expect(other?.completedRuns).toBe(2);
    expect(other?.cost.measuredMicroUsd).toBe(5_000);
  });

  it('lists the error codes without the cancellation', async () => {
    const usage = await service.usage({ from: FROM.toISOString(), to: TO.toISOString() });

    const codes = usage.byErrorCode.map((row) => row.errorCode);
    expect(codes).toContain('ai_provider_error');
    expect(codes).toContain('ai_timeout');
    expect(codes).not.toContain('ai_cancelled');
  });

  it('fills the day nothing happened rather than closing the gap', async () => {
    const usage = await service.usage({ from: FROM.toISOString(), to: TO.toISOString() });

    expect(usage.daily).toHaveLength(5);
    expect(usage.daily.map((entry) => entry.runs)).toEqual([2, 2, 0, 1, 0]);
    expect(usage.daily[0]?.byStatus.completed).toBe(2);
    expect(usage.daily[0]?.costMicroUsd).toBe(8_000);
  });

  it('refuses a range that runs backwards', async () => {
    await expect(
      service.usage({ from: TO.toISOString(), to: FROM.toISOString() }),
    ).rejects.toThrow();
  });
});
