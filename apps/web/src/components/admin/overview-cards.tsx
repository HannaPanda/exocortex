import { type AdminOverviewResponse } from '@exocortex/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@exocortex/ui';

const numberFormat = new Intl.NumberFormat('de-DE');
const currencyFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD' });

function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** `aiCostLast24hMicroUsd` is micro-USD; convert to USD before formatting. */
function formatMicroUsd(microUsd: number): string {
  return currencyFormat.format(microUsd / 1_000_000);
}

interface MetricCardProps {
  label: string;
  value: string;
  subtitle?: string;
}

function MetricCard({ label, value, subtitle }: MetricCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      {subtitle !== undefined ? (
        <CardContent className="text-xs text-muted-foreground">{subtitle}</CardContent>
      ) : null}
    </Card>
  );
}

export function OverviewCards({ overview }: { overview: AdminOverviewResponse }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <MetricCard
        label="Nutzer"
        value={formatNumber(overview.userCount)}
        subtitle={`davon ${formatNumber(overview.adminCount)} Administratoren`}
      />
      <MetricCard label="Arbeitsbereiche" value={formatNumber(overview.workspaceCount)} />
      <MetricCard label="Seiten" value={formatNumber(overview.documentCount)} />
      <MetricCard label="Dateien" value={formatNumber(overview.attachmentCount)} />
      <MetricCard label="KI-Anfragen (24 h)" value={formatNumber(overview.aiRunsLast24h)} />
      <MetricCard label="KI-Kosten (24 h)" value={formatMicroUsd(overview.aiCostLast24hMicroUsd)} />
      <MetricCard
        label="KI-Modelle"
        value={formatNumber(overview.aiModelCount)}
        subtitle={`${formatNumber(overview.enabledAiModelCount)} aktiv`}
      />
      <MetricCard label="API-Token" value={formatNumber(overview.apiTokenCount)} />
    </div>
  );
}
