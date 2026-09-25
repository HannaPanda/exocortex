'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AiRunStatus,
  type AiUsageCost,
  type AiUsageDay,
  type AiUsageResponse,
  type AiUsageStatusCounts,
} from '@exocortex/contracts';
import {
  Button,
  cn,
  EmptyState,
  ErrorState,
  LoadingState,
  Readout,
  SectionRule,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useAdminAiUsage } from '@/lib/api/admin-queries';

type Formatter = ReturnType<typeof useFormatter>;
type Translator = ReturnType<typeof useTranslations<'admin.usage'>>;

const PERCENT = { style: 'percent', maximumFractionDigits: 1 } as const;

const RANGES = [
  { days: 1, labelKey: 'day' },
  { days: 7, labelKey: 'week' },
  { days: 30, labelKey: 'month' },
  { days: 90, labelKey: 'quarter' },
] as const;

/**
 * The four statuses a bar can stack, in the order they are stacked.
 *
 * `pending` and `running` are left out on purpose: a run that has not finished
 * yet has no outcome, and drawing it beside the finished ones would make the
 * most recent day look worse (or better) than it turns out to be.
 */
const STACKED_STATUSES = [
  { status: 'completed', className: 'bg-success' },
  { status: 'failed', className: 'bg-destructive' },
  { status: 'timed_out', className: 'bg-warning' },
  { status: 'cancelled', className: 'bg-muted-foreground' },
] as const satisfies readonly { status: AiRunStatus; className: string }[];

/** Micro-USD as a dollar amount; up to four decimals, because most runs cost cents. */
function formatMicroUsd(format: Formatter, microUsd: number): string {
  return format.number(microUsd / 1_000_000, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatDuration(format: Formatter, ms: number | null): string {
  if (ms === null) return '–';
  return ms < 1_000
    ? format.number(ms, { style: 'unit', unit: 'millisecond' })
    : format.number(ms / 1_000, {
        style: 'unit',
        unit: 'second',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
}

/**
 * Day and month of an ISO day (`08.09.` in German): the axis has room for a
 * day and a month, not a year. Read in UTC, the zone the API names days in.
 */
function formatDayLabel(format: Formatter, date: string): string {
  return format.dateTime(new Date(`${date}T00:00:00Z`), {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  });
}

/**
 * The run count broken into groups that add up to it.
 *
 * Naming only the successes and the failures left the subtitle short but wrong:
 * a cancelled or still-running run is in the number above and was in neither
 * half below, so the two lines did not agree and nothing on the page said why.
 * Every run is in exactly one group here.
 *
 * A timeout sits with the failures because both are the system not delivering.
 * A cancellation is its own group because somebody chose it, which is also the
 * reason it stays out of the success rate and the error table. Groups at zero
 * are left out: "0 abgebrochen" is noise on a page about the figures that are
 * not zero.
 */
function runBreakdown(t: Translator, byStatus: AiUsageStatusCounts): string | undefined {
  const groups = [
    [byStatus.completed, 'completed'],
    [byStatus.failed + byStatus.timed_out, 'failed'],
    [byStatus.cancelled, 'cancelled'],
    [byStatus.pending + byStatus.running, 'open'],
  ] as const;
  const parts = groups
    .filter(([count]) => count > 0)
    .map(([count, key]) => t(`breakdown.${key}`, { count }));
  return parts.length === 0 ? undefined : parts.join(', ');
}

/**
 * Money as one line, with the estimated part named rather than folded in.
 *
 * The whole reason the API keeps the two apart (issue #10) is that a total made
 * only of reported costs counts every unreported run as free. Showing the sum
 * and then saying how much of it was calculated is the honest version.
 */
function CostSummary({ cost }: { cost: AiUsageCost }) {
  const t = useTranslations('admin.usage');
  const format = useFormatter();
  const total = cost.measuredMicroUsd + cost.estimatedMicroUsd;
  const parts: string[] = [];
  if (cost.estimatedMicroUsd > 0) {
    parts.push(t('costEstimated', { amount: formatMicroUsd(format, cost.estimatedMicroUsd) }));
  }
  if (cost.unpricedRuns > 0) {
    parts.push(t('costUnpriced', { count: cost.unpricedRuns }));
  }
  // Whose money this was. Only shown once a workspace actually brought its own
  // key: on a deployment without BYOK the line would say "0 fremd bezahlt"
  // forever, which is noise and not information.
  if (cost.ownKeyRuns > 0) {
    parts.push(t('costOwnKey', { amount: formatMicroUsd(format, cost.ownKeyMicroUsd) }));
  }
  return (
    <Readout
      label={t('cost')}
      value={formatMicroUsd(format, total)}
      tone="live"
      note={parts.length === 0 ? t('costFullyReported') : parts.join(' · ')}
      data-testid="usage-metric-cost"
    />
  );
}

/**
 * Runs per day, stacked by outcome.
 *
 * Hand-drawn from flex boxes rather than a charting library: the repository has
 * no chart dependency, and one bar chart is not a reason to acquire one. Every
 * day in the range gets a column, including the empty ones -- the API fills the
 * gaps for exactly this reason, so a quiet week reads as a quiet week instead
 * of vanishing between two busy days.
 */
function DailyChart({ daily }: { daily: readonly AiUsageDay[] }) {
  const chartTableId = React.useId();
  const t = useTranslations('admin.usage');
  const format = useFormatter();
  const dayLabel = (date: string): string => formatDayLabel(format, date);
  const peak = Math.max(1, ...daily.map((day) => day.runs));
  // A dense range gets a label every few days; otherwise they overlap.
  const labelEvery = Math.ceil(daily.length / 12);

  const busiest = daily.reduce(
    (peakDay, day) => (day.runs > peakDay.runs ? day : peakDay),
    daily[0] ?? { date: '', runs: 0, costMicroUsd: 0, byStatus: {} as AiUsageStatusCounts },
  );

  return (
    // A section rather than a card: everything else on this page is announced
    // by a rule now, and one boxed block in the middle of it would be the only
    // thing claiming to be separate from the page it is about.
    <section className="flex flex-col gap-3">
      <SectionRule>{t('chart.title')}</SectionRule>
      <div className="space-y-3">
        {/*
         * The bars are the picture; the table under them is the same data for
         * anybody the picture does not reach. It was `role="img"` over a row of
         * empty divs whose numbers lived in a `title` attribute, which a screen
         * reader never reads and a finger cannot summon: position was the only
         * carrier of the one quantitative view of what the AI costs, on a
         * product whose own rule is that meaning never rides on one channel.
         */}
        <div
          className="flex h-40 items-end gap-px"
          role="img"
          aria-label={t('chart.imageLabel')}
          aria-describedby={chartTableId}
        >
          {daily.map((day, index) => (
            <div
              key={day.date}
              className="flex h-full flex-1 flex-col justify-end gap-px"
              title={t('chart.column', {
                day: dayLabel(day.date),
                runs: day.runs,
                cost: formatMicroUsd(format, day.costMicroUsd),
              })}
              data-testid={index === 0 ? 'usage-chart-column' : undefined}
            >
              {STACKED_STATUSES.map((segment) => {
                const count = day.byStatus[segment.status];
                if (count === 0) return null;
                return (
                  <div
                    key={segment.status}
                    className={cn('w-full rounded-xs', segment.className)}
                    style={{ height: `${(count / peak) * 100}%` }}
                  />
                );
              })}
              {day.runs === 0 ? <div className="h-px w-full bg-border" /> : null}
            </div>
          ))}
        </div>
        <div className="flex gap-px text-nano text-muted-foreground">
          {daily.map((day, index) => (
            <span key={day.date} className="flex-1 truncate text-center">
              {index % labelEvery === 0 ? dayLabel(day.date) : ''}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {STACKED_STATUSES.map((segment) => (
            <span key={segment.status} className="flex items-center gap-1.5">
              <span className={cn('size-2 rounded-xs', segment.className)} aria-hidden />
              {t(`statuses.${segment.status}`)}
            </span>
          ))}
        </div>

        {/* Visible to everyone as one sentence, and complete to a screen
            reader as the table the picture describes. */}
        <p className="text-xs text-muted-foreground">
          {daily.length === 0
            ? t('chart.noDays')
            : t('chart.busiest', { day: dayLabel(busiest.date), runs: busiest.runs })}
        </p>
        <table id={chartTableId} className="exocortex-sr-only">
          <caption>{t('chart.tableCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('chart.day')}</th>
              <th scope="col">{t('chart.runs')}</th>
              <th scope="col">{t('chart.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((day) => (
              <tr key={day.date}>
                <th scope="row">{dayLabel(day.date)}</th>
                <td>{format.number(day.runs)}</td>
                <td>{formatMicroUsd(format, day.costMicroUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ModelTable({ usage }: { usage: AiUsageResponse }) {
  const t = useTranslations('admin.usage.modelTable');
  const format = useFormatter();
  return (
    <Table narrow="list">
      <TableCaption>{t('caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t('model')}</TableHead>
          <TableHead className="text-right">{t('runs')}</TableHead>
          <TableHead className="text-right">{t('success')}</TableHead>
          <TableHead className="text-right">{t('tokens')}</TableHead>
          <TableHead className="text-right">{t('cost')}</TableHead>
          <TableHead className="text-right">{t('median')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {usage.byModel.map((row) => {
          const finished = row.completedRuns + row.failedRuns;
          return (
            <TableRow key={`${row.provider}:${row.model}`}>
              <TableCell cell="title">
                <div className="font-medium">{row.displayName ?? row.model}</div>
                <div className="text-xs text-muted-foreground">
                  {row.model} · {row.provider}
                </div>
              </TableCell>
              <TableCell label={t('runs')} className="text-right tabular-nums">
                {format.number(row.runs)}
              </TableCell>
              <TableCell label={t('success')} className="text-right tabular-nums">
                {finished === 0 ? '–' : format.number(row.completedRuns / finished, PERCENT)}
              </TableCell>
              <TableCell label={t('tokens')} className="text-right tabular-nums">
                {format.number(row.tokens.input)} / {format.number(row.tokens.output)}
              </TableCell>
              <TableCell label={t('cost')} className="text-right tabular-nums">
                {formatMicroUsd(format, row.cost.measuredMicroUsd + row.cost.estimatedMicroUsd)}
                {row.cost.estimatedMicroUsd > 0 ? (
                  <span className="ml-1 text-xs text-muted-foreground">{t('estimated')}</span>
                ) : null}
              </TableCell>
              <TableCell label={t('median')} className="text-right tabular-nums">
                {formatDuration(format, row.medianDurationMs)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ErrorTable({ usage }: { usage: AiUsageResponse }) {
  const t = useTranslations('admin.usage.errorTable');
  const format = useFormatter();
  const failed = usage.byErrorCode.reduce((sum, row) => sum + row.runs, 0);
  return (
    <Table narrow="list">
      <TableCaption>{t('caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t('code')}</TableHead>
          <TableHead className="text-right">{t('runs')}</TableHead>
          <TableHead className="text-right">{t('share')}</TableHead>
          <TableHead className="text-right">{t('lastSeen')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {usage.byErrorCode.map((row) => (
          <TableRow key={row.errorCode ?? 'no-code'}>
            <TableCell cell="title" className="font-mono text-xs">
              {row.errorCode ?? t('noCode')}
            </TableCell>
            <TableCell label={t('runs')} className="text-right tabular-nums">
              {format.number(row.runs)}
            </TableCell>
            <TableCell label={t('share')} className="text-right tabular-nums">
              {failed === 0 ? '–' : format.number(row.runs / failed, PERCENT)}
            </TableCell>
            <TableCell label={t('lastSeen')} className="text-right tabular-nums">
              {format.dateTime(new Date(row.lastSeenAt), {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The `/admin/nutzung` page body: range picker, headline figures, three views. */
export function UsageReport() {
  const [days, setDays] = React.useState<number>(30);
  const usageQuery = useAdminAiUsage(days);
  const t = useTranslations('admin.usage');
  const format = useFormatter();

  const picker = (
    <div className="flex flex-wrap gap-1" role="group" aria-label={t('rangeLabel')}>
      {RANGES.map((range) => (
        <Button
          key={range.days}
          variant={range.days === days ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={range.days === days}
          onClick={() => setDays(range.days)}
        >
          {t(`ranges.${range.labelKey}`)}
        </Button>
      ))}
    </div>
  );

  if (usageQuery.isPending) {
    return (
      <div className="space-y-6">
        {picker}
        <LoadingState label={t('loading')} variant="skeleton" rows={4} />
      </div>
    );
  }

  if (usageQuery.isError) {
    return (
      <div className="space-y-6">
        {picker}
        <ErrorState title={t('loadFailed')} onRetry={() => void usageQuery.refetch()} />
      </div>
    );
  }

  const usage = usageQuery.data;
  const cachedShare =
    usage.tokens.input === 0 ? null : usage.tokens.cachedInput / usage.tokens.input;

  return (
    <div className="space-y-6">
      {picker}

      {/* The same vocabulary as the administration overview: a rule names the
          group, a leader carries each label to its figure, and the order is the
          ranking. What was spent and whether it worked comes before how long it
          took. */}
      <section className="flex flex-col gap-3">
        <SectionRule>{t('inRange')}</SectionRule>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Readout
            label={t('runs')}
            value={format.number(usage.runs)}
            tone="live"
            note={runBreakdown(t, usage.byStatus)}
            data-testid="usage-metric-runs"
          />
          <CostSummary cost={usage.cost} />
          <Readout
            label={t('successRate')}
            value={usage.successRate === null ? '–' : format.number(usage.successRate, PERCENT)}
            note={t('successRateNote')}
          />
          <Readout
            label={t('tokens')}
            value={`${format.number(usage.tokens.input)} / ${format.number(usage.tokens.output)}`}
            note={
              cachedShare === null
                ? undefined
                : t('cachedShare', { share: format.number(cachedShare, PERCENT) })
            }
          />
          <Readout
            label={t('duration')}
            value={formatDuration(format, usage.medianDurationMs)}
            note={t('p95', { duration: formatDuration(format, usage.p95DurationMs) })}
          />
          <Readout
            label={t('toolIterations')}
            value={format.number(usage.toolIterations)}
            note={usage.prunedRuns === 0 ? undefined : t('pruned', { count: usage.prunedRuns })}
          />
        </div>
      </section>

      <DailyChart daily={usage.daily} />

      <section className="space-y-2">
        <SectionRule>{t('byModel')}</SectionRule>
        {usage.byModel.length === 0 ? (
          <EmptyState title={t('noRunsTitle')} description={t('noRunsDescription')} />
        ) : (
          <ModelTable usage={usage} />
        )}
      </section>

      <section className="space-y-2">
        <SectionRule>{t('errors')}</SectionRule>
        {usage.byErrorCode.length === 0 ? (
          <EmptyState title={t('noErrorsTitle')} description={t('noErrorsDescription')} />
        ) : (
          <ErrorTable usage={usage} />
        )}
      </section>
    </div>
  );
}
