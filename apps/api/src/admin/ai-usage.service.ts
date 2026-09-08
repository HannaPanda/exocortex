import { Inject, Injectable } from '@nestjs/common';

import {
  type AiRunStatus,
  type AiUsageCost,
  type AiUsageDay,
  type AiUsageErrorRow,
  type AiUsageModelRow,
  type AiUsageQuery,
  type AiUsageResponse,
  type AiUsageStatusCounts,
  type AiUsageTokens,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AI_RUN_STATUS_TO_CONTRACT } from '../ai/run-mapper';
import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform-tokens';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_MS = 30 * DAY_MS;
/** A year and a day. Long enough for "the last year", short enough to stay one query. */
const MAX_RANGE_MS = 366 * DAY_MS;

type StatusPrisma = keyof typeof AI_RUN_STATUS_TO_CONTRACT;

/** Every status at zero, so a caller never has to check whether a key exists. */
function emptyStatusCounts(): AiUsageStatusCounts {
  const counts: Partial<Record<AiRunStatus, number>> = {};
  for (const status of Object.values(AI_RUN_STATUS_TO_CONTRACT)) counts[status] = 0;
  return counts as AiUsageStatusCounts;
}

/**
 * Postgres returns `bigint` for `SUM` and `COUNT` over integers, and `null`
 * for an aggregate over no rows even where `COALESCE` was applied to the sum.
 */
function toInt(value: bigint | number | null): number {
  if (value === null) return 0;
  return typeof value === 'bigint' ? Number(value) : Math.round(value);
}

function toNullableInt(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/** The aggregate columns every total-shaped query below selects, in one shape. */
interface AggregateRow {
  runs: bigint;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  cachedInputTokens: bigint | null;
  measuredMicroUsd: bigint | null;
  estimatedMicroUsd: bigint | null;
  measuredRuns: bigint;
  estimatedRuns: bigint;
  unpricedRuns: bigint;
  toolIterations: bigint | null;
}

function toTokens(row: AggregateRow): AiUsageTokens {
  return {
    input: toInt(row.inputTokens),
    output: toInt(row.outputTokens),
    cachedInput: toInt(row.cachedInputTokens),
  };
}

function toCost(row: AggregateRow): AiUsageCost {
  return {
    measuredMicroUsd: toInt(row.measuredMicroUsd),
    estimatedMicroUsd: toInt(row.estimatedMicroUsd),
    measuredRuns: toInt(row.measuredRuns),
    estimatedRuns: toInt(row.estimatedRuns),
    unpricedRuns: toInt(row.unpricedRuns),
  };
}

/**
 * The AI usage view (issue #10).
 *
 * Its own service rather than four more methods on `AdminService`: this is the
 * only part of the admin area that aggregates instead of listing, and it is
 * also the only part written in SQL rather than through the Prisma query
 * builder. Both of those are deliberate.
 *
 * Why SQL: the questions here are `GROUP BY` with `FILTER` clauses and a
 * percentile, and Prisma's `groupBy` expresses none of the three. Assembling
 * this from seven separate `groupBy` calls and joining them in TypeScript would
 * be more code, more round-trips and less readable than the five statements
 * below. The rest of the admin area stays on the query builder.
 *
 * Everything reads `ai_run` over a time window. Since issue #10 the figures are
 * columns rather than JSON, so `createdAt` is the only predicate and the index
 * added with them serves it.
 */
@Injectable()
export class AiUsageService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Resolves the requested window.
   *
   * `to` is exclusive so that consecutive ranges neither overlap nor drop a
   * run on the boundary. An inverted or over-long range is a client error
   * rather than something to silently correct: quietly returning a different
   * window than the one asked for produces numbers nobody can reproduce.
   */
  private resolveRange(query: AiUsageQuery): { from: Date; to: Date } {
    const to = query.to === undefined ? new Date() : new Date(query.to);
    const from =
      query.from === undefined ? new Date(to.getTime() - DEFAULT_RANGE_MS) : new Date(query.from);
    if (from.getTime() >= to.getTime()) {
      throw AppError.validation('The start of the range must lie before its end');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw AppError.validation('The range may not span more than a year');
    }
    return { from, to };
  }

  async usage(query: AiUsageQuery): Promise<AiUsageResponse> {
    const { from, to } = this.resolveRange(query);

    const [totals, statusRows, modelRows, errorRows, dailyRows, percentiles] = await Promise.all([
      this.totals(from, to),
      this.byStatus(from, to),
      this.byModel(from, to),
      this.byErrorCode(from, to),
      this.daily(from, to),
      this.durationPercentiles(from, to),
    ]);

    const byStatus = emptyStatusCounts();
    for (const row of statusRows) byStatus[AI_RUN_STATUS_TO_CONTRACT[row.status]] = toInt(row.runs);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      runs: toInt(totals.runs),
      byStatus,
      successRate: successRate(byStatus),
      tokens: toTokens(totals),
      cost: toCost(totals),
      medianDurationMs: toNullableInt(percentiles.medianDurationMs),
      p95DurationMs: toNullableInt(percentiles.p95DurationMs),
      toolIterations: toInt(totals.toolIterations),
      prunedRuns: toInt(totals.prunedRuns),
      byModel: modelRows.map(toModelRow),
      byErrorCode: errorRows.map((row): AiUsageErrorRow => ({
        errorCode: row.errorCode,
        runs: toInt(row.runs),
        lastSeenAt: row.lastSeenAt.toISOString(),
      })),
      daily: toDailySeries(dailyRows, from, to),
    };
  }

  /**
   * The deployment-wide figures.
   *
   * `COUNT(column)` counts the non-null ones, which is exactly the
   * measured/estimated split: `providerCostMicroUsd` is set only when a
   * provider named a price, `estimatedCostMicroUsd` only when none did.
   * `unpricedRuns` is the third case the two columns cannot express on their
   * own -- a run that produced usage but has no price from either side,
   * because it names a model the registry does not hold.
   */
  private async totals(from: Date, to: Date): Promise<AggregateRow & { prunedRuns: bigint }> {
    const rows = await this.prisma.$queryRaw<(AggregateRow & { prunedRuns: bigint })[]>`
      SELECT
        COUNT(*) AS "runs",
        COALESCE(SUM("inputTokens"), 0) AS "inputTokens",
        COALESCE(SUM("outputTokens"), 0) AS "outputTokens",
        COALESCE(SUM("cachedInputTokens"), 0) AS "cachedInputTokens",
        COALESCE(SUM("providerCostMicroUsd"), 0) AS "measuredMicroUsd",
        COALESCE(SUM("estimatedCostMicroUsd"), 0) AS "estimatedMicroUsd",
        COUNT("providerCostMicroUsd") AS "measuredRuns",
        COUNT("estimatedCostMicroUsd") AS "estimatedRuns",
        COUNT(*) FILTER (
          WHERE "inputTokens" IS NOT NULL
            AND "providerCostMicroUsd" IS NULL
            AND "estimatedCostMicroUsd" IS NULL
        ) AS "unpricedRuns",
        COUNT(*) FILTER (WHERE "payloadsPrunedAt" IS NOT NULL) AS "prunedRuns",
        COALESCE(SUM("toolIterations"), 0) AS "toolIterations"
      FROM "ai_run"
      WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
    `;
    return rows[0]!;
  }

  /**
   * Median and 95th percentile of the wall-clock duration.
   *
   * Separate from `totals` only because `PERCENTILE_CONT` is an ordered-set
   * aggregate and reads better on its own line. Runs without a recorded
   * duration are skipped by the aggregate rather than counted as zero, which
   * is why both figures are nullable.
   */
  private async durationPercentiles(
    from: Date,
    to: Date,
  ): Promise<{ medianDurationMs: number | null; p95DurationMs: number | null }> {
    const rows = await this.prisma.$queryRaw<
      { medianDurationMs: number | null; p95DurationMs: number | null }[]
    >`
      SELECT
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "durationMs") AS "medianDurationMs",
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs") AS "p95DurationMs"
      FROM "ai_run"
      WHERE "createdAt" >= ${from} AND "createdAt" < ${to} AND "durationMs" IS NOT NULL
    `;
    return rows[0] ?? { medianDurationMs: null, p95DurationMs: null };
  }

  private async byStatus(from: Date, to: Date): Promise<{ status: StatusPrisma; runs: bigint }[]> {
    return this.prisma.$queryRaw<{ status: StatusPrisma; runs: bigint }[]>`
      SELECT "status", COUNT(*) AS "runs"
      FROM "ai_run"
      WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY "status"
    `;
  }

  /**
   * The breakdown that answers "which model, at what price, how reliably".
   *
   * The join against `ai_model` is a left join on the slug: a run keeps the
   * model string it was started with, and that model may since have left the
   * registry. Such a row still belongs in the table -- it cost money -- it just
   * has no display name to show.
   */
  private async byModel(from: Date, to: Date): Promise<ModelAggregateRow[]> {
    return this.prisma.$queryRaw<ModelAggregateRow[]>`
      SELECT
        r."model" AS "model",
        r."provider" AS "provider",
        MAX(m."displayName") AS "displayName",
        COUNT(*) AS "runs",
        COUNT(*) FILTER (WHERE r."status" = 'COMPLETED') AS "completedRuns",
        COUNT(*) FILTER (WHERE r."status" IN ('FAILED', 'TIMED_OUT')) AS "failedRuns",
        COALESCE(SUM(r."inputTokens"), 0) AS "inputTokens",
        COALESCE(SUM(r."outputTokens"), 0) AS "outputTokens",
        COALESCE(SUM(r."cachedInputTokens"), 0) AS "cachedInputTokens",
        COALESCE(SUM(r."providerCostMicroUsd"), 0) AS "measuredMicroUsd",
        COALESCE(SUM(r."estimatedCostMicroUsd"), 0) AS "estimatedMicroUsd",
        COUNT(r."providerCostMicroUsd") AS "measuredRuns",
        COUNT(r."estimatedCostMicroUsd") AS "estimatedRuns",
        COUNT(*) FILTER (
          WHERE r."inputTokens" IS NOT NULL
            AND r."providerCostMicroUsd" IS NULL
            AND r."estimatedCostMicroUsd" IS NULL
        ) AS "unpricedRuns",
        COALESCE(SUM(r."toolIterations"), 0) AS "toolIterations",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r."durationMs") AS "medianDurationMs"
      FROM "ai_run" r
      LEFT JOIN "ai_model" m ON m."slug" = r."model"
      WHERE r."createdAt" >= ${from} AND r."createdAt" < ${to}
      GROUP BY r."model", r."provider"
      ORDER BY COUNT(*) DESC
    `;
  }

  /**
   * How often each error code came up.
   *
   * Only `FAILED` and `TIMED_OUT` rows: a cancelled run carries an error code
   * too (`ai_cancelled`), but somebody pressing stop is not a fault, and
   * putting it in this table would make the most common entry the one nobody
   * needs to act on.
   */
  private async byErrorCode(
    from: Date,
    to: Date,
  ): Promise<{ errorCode: string | null; runs: bigint; lastSeenAt: Date }[]> {
    return this.prisma.$queryRaw<{ errorCode: string | null; runs: bigint; lastSeenAt: Date }[]>`
      SELECT "errorCode", COUNT(*) AS "runs", MAX("createdAt") AS "lastSeenAt"
      FROM "ai_run"
      WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        AND "status" IN ('FAILED', 'TIMED_OUT')
      GROUP BY "errorCode"
      ORDER BY COUNT(*) DESC
    `;
  }

  /**
   * Runs and cost per calendar day, split by status.
   *
   * `date_trunc` uses the database session's timezone, which is the same one
   * the deployment runs in; the boundary between two days in this series is
   * therefore the boundary a person here would draw.
   *
   * The cost per day takes the reported figure and falls back to the estimate,
   * because a stacked bar has room for one number. The measured/estimated split
   * stays available in the totals, where it can be shown honestly.
   */
  private async daily(from: Date, to: Date): Promise<DailyRow[]> {
    return this.prisma.$queryRaw<DailyRow[]>`
      SELECT
        to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS "date",
        "status",
        COUNT(*) AS "runs",
        COALESCE(SUM(COALESCE("providerCostMicroUsd", "estimatedCostMicroUsd")), 0) AS "costMicroUsd"
      FROM "ai_run"
      WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY 1, 2
      ORDER BY 1
    `;
  }
}

interface ModelAggregateRow extends AggregateRow {
  model: string;
  provider: string;
  displayName: string | null;
  completedRuns: bigint;
  failedRuns: bigint;
  medianDurationMs: number | null;
}

interface DailyRow {
  date: string;
  status: StatusPrisma;
  runs: bigint;
  costMicroUsd: bigint;
}

function toModelRow(row: ModelAggregateRow): AiUsageModelRow {
  return {
    model: row.model,
    provider: row.provider,
    displayName: row.displayName,
    runs: toInt(row.runs),
    completedRuns: toInt(row.completedRuns),
    failedRuns: toInt(row.failedRuns),
    tokens: toTokens(row),
    cost: toCost(row),
    medianDurationMs: toNullableInt(row.medianDurationMs),
    toolIterations: toInt(row.toolIterations),
  };
}

/**
 * Completed runs over runs that reached a terminal status.
 *
 * Cancelled runs are in neither half. A run somebody stopped tells you nothing
 * about whether the AI works, and counting it as a failure would make a
 * deployment look worse the more its users change their minds. Runs still
 * pending or running are excluded for the same reason: they have no outcome yet.
 */
function successRate(byStatus: AiUsageStatusCounts): number | null {
  const completed = byStatus.completed;
  const finished = completed + byStatus.failed + byStatus.timed_out;
  return finished === 0 ? null : completed / finished;
}

/**
 * The daily rows pivoted into one entry per day, including the days on which
 * nothing ran.
 *
 * A chart drawn straight from the grouped rows would silently close the gaps
 * and show a quiet week as a steep line between two busy days. Filling the
 * range is what makes "nothing happened here" visible.
 */
function toDailySeries(rows: readonly DailyRow[], from: Date, to: Date): AiUsageDay[] {
  const byDate = new Map<string, AiUsageDay>();
  for (const row of rows) {
    const day = byDate.get(row.date) ?? {
      date: row.date,
      runs: 0,
      byStatus: emptyStatusCounts(),
      costMicroUsd: 0,
    };
    day.runs += toInt(row.runs);
    day.byStatus[AI_RUN_STATUS_TO_CONTRACT[row.status]] += toInt(row.runs);
    day.costMicroUsd += toInt(row.costMicroUsd);
    byDate.set(row.date, day);
  }

  const series: AiUsageDay[] = [];
  // Walk the range by local calendar day, the same unit `date_trunc` produced.
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cursor.getTime() < to.getTime()) {
    const date = localDate(cursor);
    series.push(
      byDate.get(date) ?? { date, runs: 0, byStatus: emptyStatusCounts(), costMicroUsd: 0 },
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return series;
}

/** `YYYY-MM-DD` in local time; `toISOString` would shift the day in any timezone east of UTC. */
function localDate(value: Date): string {
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}
