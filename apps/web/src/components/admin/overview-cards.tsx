import { type AdminOverviewResponse } from '@exocortex/contracts';
import { Readout, SectionRule } from '@exocortex/ui';

/**
 * What this deployment holds, what it did in the last day, and what is set up.
 *
 * This screen used to be eight identical cards in a three-column grid, each a
 * caption over a `text-2xl` number. `PRODUCT.md` names "dashboard grids of
 * identical tiles" as an anti-reference in so many words, and the workspace
 * overview four hundred lines away answers the same "how is it going" question
 * with sections, rules and leaders. Two overviews, two philosophies, and the
 * generic one was what a new administrator met first.
 *
 * So it is the same vocabulary now, and the grid's missing half is put back:
 * a ranking. The live figures come first because they are the ones that change
 * and can surprise -- a deployment's user count does not move overnight, its
 * AI bill can. Stock comes second because it is what somebody looks up. The
 * configuration comes last because it only matters when something else was
 * already wrong.
 */

const numberFormat = new Intl.NumberFormat('de-DE');
const currencyFormat = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD' });

function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** `aiCostLast24hMicroUsd` is micro-USD; convert to USD before formatting. */
function formatMicroUsd(microUsd: number): string {
  return currencyFormat.format(microUsd / 1_000_000);
}

/**
 * A group of readouts under one rule.
 *
 * Two columns from `sm` up, because a leader needs a run of space to be a
 * leader and a 68ch column would make each row a desert. One column on a phone,
 * where the width is the constraint rather than the emptiness.
 */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionRule>{title}</SectionRule>
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function OverviewCards({ overview }: { overview: AdminOverviewResponse }) {
  return (
    // `gap-10` between groups against `gap-4` inside them, the same rhythm the
    // workspace overview uses: the space is what groups a section here, since
    // nothing is boxed.
    <div className="flex flex-col gap-10">
      <Group title="Letzte 24 Stunden">
        <Readout
          label="KI-Anfragen"
          value={formatNumber(overview.aiRunsLast24h)}
          tone="live"
          data-testid="admin-metric-ai-runs"
        />
        <Readout
          label="KI-Kosten"
          value={formatMicroUsd(overview.aiCostLast24hMicroUsd)}
          tone="live"
          data-testid="admin-metric-ai-cost"
        />
      </Group>

      <Group title="Bestand">
        <Readout
          label="Nutzer"
          value={formatNumber(overview.userCount)}
          note={
            overview.adminCount === 1
              ? 'davon eine Person mit Administrationsrechten'
              : `davon ${formatNumber(overview.adminCount)} mit Administrationsrechten`
          }
          data-testid="admin-metric-users"
        />
        <Readout label="Arbeitsbereiche" value={formatNumber(overview.workspaceCount)} />
        <Readout label="Seiten" value={formatNumber(overview.documentCount)} />
        <Readout label="Dateien" value={formatNumber(overview.attachmentCount)} />
      </Group>

      <Group title="Konfiguration">
        <Readout
          label="KI-Modelle"
          value={formatNumber(overview.aiModelCount)}
          note={`${formatNumber(overview.enabledAiModelCount)} davon aktiv`}
          data-testid="admin-metric-models"
        />
        <Readout label="API-Token" value={formatNumber(overview.apiTokenCount)} />
      </Group>
    </div>
  );
}
