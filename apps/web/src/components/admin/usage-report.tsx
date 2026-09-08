'use client';

import * as React from 'react';

import {
  type AiRunStatus,
  type AiUsageCost,
  type AiUsageDay,
  type AiUsageResponse,
} from '@exocortex/contracts';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useAdminAiUsage } from '@/lib/api/admin-queries';

const numberFormat = new Intl.NumberFormat('de-DE');
const percentFormat = new Intl.NumberFormat('de-DE', {
  style: 'percent',
  maximumFractionDigits: 1,
});

const RANGES = [
  { days: 1, label: '24 h' },
  { days: 7, label: '7 Tage' },
  { days: 30, label: '30 Tage' },
  { days: 90, label: '3 Monate' },
] as const;

/**
 * The four statuses a bar can stack, in the order they are stacked.
 *
 * `pending` and `running` are left out on purpose: a run that has not finished
 * yet has no outcome, and drawing it beside the finished ones would make the
 * most recent day look worse (or better) than it turns out to be.
 */
const STACKED_STATUSES = [
  { status: 'completed', label: 'erfolgreich', className: 'bg-success' },
  { status: 'failed', label: 'fehlgeschlagen', className: 'bg-destructive' },
  { status: 'timed_out', label: 'Zeitüberschreitung', className: 'bg-warning' },
  { status: 'cancelled', label: 'abgebrochen', className: 'bg-muted-foreground' },
] as const satisfies readonly { status: AiRunStatus; label: string; className: string }[];

/** Micro-USD to a `$X,XX` string; four decimals, because most runs cost cents. */
function formatMicroUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '–';
  return ms < 1_000 ? `${numberFormat.format(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/** `08.09.` — the axis has room for a day and a month, not a year. */
function formatDayLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}.${month}.`;
}

/**
 * Money as one line, with the estimated part named rather than folded in.
 *
 * The whole reason the API keeps the two apart (issue #10) is that a total made
 * only of reported costs counts every unreported run as free. Showing the sum
 * and then saying how much of it was calculated is the honest version.
 */
function CostSummary({ cost }: { cost: AiUsageCost }) {
  const total = cost.measuredMicroUsd + cost.estimatedMicroUsd;
  const parts: string[] = [];
  if (cost.estimatedMicroUsd > 0) {
    parts.push(`davon ${formatMicroUsd(cost.estimatedMicroUsd)} geschätzt`);
  }
  if (cost.unpricedRuns > 0) {
    parts.push(`${numberFormat.format(cost.unpricedRuns)} ohne Preis`);
  }
  return (
    <MetricCard
      label="Kosten"
      value={formatMicroUsd(total)}
      subtitle={parts.length === 0 ? 'vollständig vom Anbieter gemeldet' : parts.join(' · ')}
    />
  );
}

function MetricCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      {subtitle === undefined ? null : (
        <CardContent className="text-xs text-muted-foreground">{subtitle}</CardContent>
      )}
    </Card>
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
  const peak = Math.max(1, ...daily.map((day) => day.runs));
  // A dense range gets a label every few days; otherwise they overlap.
  const labelEvery = Math.ceil(daily.length / 12);

  return (
    <Card>
      <CardHeader>
        <CardDescription>Läufe pro Tag</CardDescription>
        <CardTitle className="text-base">Verlauf nach Ausgang</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-40 items-end gap-px" role="img" aria-label="Läufe pro Tag">
          {daily.map((day, index) => (
            <div
              key={day.date}
              className="flex h-full flex-1 flex-col justify-end gap-px"
              title={`${formatDayLabel(day.date)} ${numberFormat.format(day.runs)} Läufe, ${formatMicroUsd(day.costMicroUsd)}`}
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
        <div className="flex gap-px text-[0.625rem] text-muted-foreground">
          {daily.map((day, index) => (
            <span key={day.date} className="flex-1 truncate text-center">
              {index % labelEvery === 0 ? formatDayLabel(day.date) : ''}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {STACKED_STATUSES.map((segment) => (
            <span key={segment.status} className="flex items-center gap-1.5">
              <span className={cn('size-2 rounded-xs', segment.className)} aria-hidden />
              {segment.label}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ModelTable({ usage }: { usage: AiUsageResponse }) {
  return (
    <Table>
      <TableCaption>
        Welches Modell wie oft, was es kostet, wie zuverlässig und wie schnell es antwortet.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Modell</TableHead>
          <TableHead className="text-right">Läufe</TableHead>
          <TableHead className="text-right">Erfolg</TableHead>
          <TableHead className="text-right">Tokens rein/raus</TableHead>
          <TableHead className="text-right">Kosten</TableHead>
          <TableHead className="text-right">Median</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {usage.byModel.map((row) => {
          const finished = row.completedRuns + row.failedRuns;
          return (
            <TableRow key={`${row.provider}:${row.model}`}>
              <TableCell>
                <div className="font-medium">{row.displayName ?? row.model}</div>
                <div className="text-xs text-muted-foreground">
                  {row.model} · {row.provider}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {numberFormat.format(row.runs)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {finished === 0 ? '–' : percentFormat.format(row.completedRuns / finished)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {numberFormat.format(row.tokens.input)} / {numberFormat.format(row.tokens.output)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMicroUsd(row.cost.measuredMicroUsd + row.cost.estimatedMicroUsd)}
                {row.cost.estimatedMicroUsd > 0 ? (
                  <span className="ml-1 text-xs text-muted-foreground">geschätzt</span>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatDuration(row.medianDurationMs)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ErrorTable({ usage }: { usage: AiUsageResponse }) {
  const failed = usage.byErrorCode.reduce((sum, row) => sum + row.runs, 0);
  return (
    <Table>
      <TableCaption>
        Nur gescheiterte Läufe und Zeitüberschreitungen. Ein Abbruch durch einen Menschen ist kein
        Fehler und steht hier nicht.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Fehlercode</TableHead>
          <TableHead className="text-right">Läufe</TableHead>
          <TableHead className="text-right">Anteil</TableHead>
          <TableHead className="text-right">Zuletzt</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {usage.byErrorCode.map((row) => (
          <TableRow key={row.errorCode ?? 'ohne-code'}>
            <TableCell className="font-mono text-xs">{row.errorCode ?? 'ohne Code'}</TableCell>
            <TableCell className="text-right tabular-nums">
              {numberFormat.format(row.runs)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {failed === 0 ? '–' : percentFormat.format(row.runs / failed)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {new Date(row.lastSeenAt).toLocaleString('de-DE', {
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

  const picker = (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Zeitraum">
      {RANGES.map((range) => (
        <Button
          key={range.days}
          variant={range.days === days ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={range.days === days}
          onClick={() => setDays(range.days)}
        >
          {range.label}
        </Button>
      ))}
    </div>
  );

  if (usageQuery.isPending) {
    return (
      <div className="space-y-6">
        {picker}
        <LoadingState label="Nutzung wird ausgewertet …" variant="skeleton" rows={4} />
      </div>
    );
  }

  if (usageQuery.isError) {
    return (
      <div className="space-y-6">
        {picker}
        <ErrorState
          title="Nutzung konnte nicht geladen werden"
          onRetry={() => void usageQuery.refetch()}
        />
      </div>
    );
  }

  const usage = usageQuery.data;
  const cachedShare =
    usage.tokens.input === 0 ? null : usage.tokens.cachedInput / usage.tokens.input;

  return (
    <div className="space-y-6">
      {picker}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label="Läufe"
          value={numberFormat.format(usage.runs)}
          subtitle={`${numberFormat.format(usage.byStatus.completed)} erfolgreich, ${numberFormat.format(
            usage.byStatus.failed + usage.byStatus.timed_out,
          )} fehlgeschlagen`}
        />
        <MetricCard
          label="Erfolgsquote"
          value={usage.successRate === null ? '–' : percentFormat.format(usage.successRate)}
          subtitle="abgebrochene Läufe zählen nicht mit"
        />
        <CostSummary cost={usage.cost} />
        <MetricCard
          label="Tokens rein/raus"
          value={`${numberFormat.format(usage.tokens.input)} / ${numberFormat.format(usage.tokens.output)}`}
          subtitle={
            cachedShare === null
              ? undefined
              : `${percentFormat.format(cachedShare)} der Eingabe kam aus dem Zwischenspeicher`
          }
        />
        <MetricCard
          label="Dauer"
          value={formatDuration(usage.medianDurationMs)}
          subtitle={`95. Perzentil: ${formatDuration(usage.p95DurationMs)}`}
        />
        <MetricCard
          label="Werkzeug-Iterationen"
          value={numberFormat.format(usage.toolIterations)}
          subtitle={
            usage.prunedRuns === 0
              ? undefined
              : `${numberFormat.format(usage.prunedRuns)} Läufe ohne Texte (aufgeräumt)`
          }
        />
      </div>

      <DailyChart daily={usage.daily} />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Nach Modell</h2>
        {usage.byModel.length === 0 ? (
          <EmptyState
            title="Keine Läufe in diesem Zeitraum"
            description="Sobald die KI benutzt wird, steht hier, welches Modell was gekostet hat."
          />
        ) : (
          <ModelTable usage={usage} />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Fehler</h2>
        {usage.byErrorCode.length === 0 ? (
          <EmptyState
            title="Keine Fehler in diesem Zeitraum"
            description="Kein Lauf ist gescheitert und keiner lief in eine Zeitüberschreitung."
          />
        ) : (
          <ErrorTable usage={usage} />
        )}
      </section>
    </div>
  );
}
