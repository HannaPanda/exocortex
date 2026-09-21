import { z } from 'zod';

import {
  type AiRun,
  aiRunSchema,
  type AiUsageCost,
  type AiUsageResponse,
  aiUsageResponseSchema,
  idSchema,
} from '@exocortex/contracts';

import { truncateText } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Watching and stopping an AI run from outside the browser.
 *
 * `docs/mcp.md` keeps AI *conversations* out of the catalogue on purpose: a
 * conversation is the assistant's own session, and steering it from another
 * assistant's transcript would be steering a second, unrelated chat. A run's
 * lifecycle is a different matter, and the reason is issue #6: a run that
 * looks alive but is not, or one that hangs, must be inspectable and
 * stoppable by whoever is looking at it -- and the browser panel is not the
 * only place somebody looks.
 *
 * Both tools are offered on the `mcp` surface only. Handing the built-in AI a
 * button that cancels a run would hand it, first of all, the button that
 * cancels itself.
 */

/** German label per wire status, so a model does not have to guess at the enum. */
const STATUS_LABEL: Record<AiRun['status'], string> = {
  pending: 'wartet auf einen Worker',
  running: 'läuft',
  completed: 'abgeschlossen',
  failed: 'fehlgeschlagen',
  cancelled: 'abgebrochen',
  timed_out: 'Zeitüberschreitung',
};

/** Cap on the answer excerpt, so a long run cannot flood a tool loop. */
const MAX_RESULT_TEXT_CHARS = 2_000;

function renderRun(run: AiRun): string {
  const lines = [
    `Lauf ${run.id}: ${STATUS_LABEL[run.status]}`,
    `Modell: ${run.model} (${run.provider}), Denkstufe: ${run.reasoningLevel}`,
    `Angelegt: ${run.createdAt}`,
    `Gestartet: ${run.startedAt ?? 'noch nicht'}`,
    `Letztes Lebenszeichen: ${run.heartbeatAt ?? 'keins'}`,
    `Beendet: ${run.finishedAt ?? 'noch nicht'}`,
    `Werkzeugrunden: ${String(run.toolIterations)}`,
  ];
  if (run.errorCode !== null) lines.push(`Fehlercode: ${run.errorCode}`);
  // The diagnosis rather than only the code (issue #118): a run that ran out
  // of tool calls says here which tools it spent them on and how many of them
  // answered nothing new, which is what a caller needs to decide what to try
  // next.
  if (run.errorDetail !== null) lines.push(`Diagnose: ${run.errorDetail}`);
  if (run.usage !== null) {
    lines.push(
      `Tokens: ${String(run.usage.inputTokens)} hinein, ${String(run.usage.outputTokens)} hinaus`,
    );
  }
  if (run.resultText !== null && run.resultText.length > 0) {
    const label =
      run.status === 'pending' || run.status === 'running' ? 'Antwort bisher' : 'Antwort';
    lines.push(`${label}:\n${truncateText(run.resultText, MAX_RESULT_TEXT_CHARS).text}`);
  }
  return lines.join('\n');
}

export const aiRunGetTool: AnyToolDefinition = defineTool({
  name: 'exo_ai_run_get',
  description:
    'Liest den Zustand eines KI-Laufs: Status, Modell, Startzeit, letztes Lebenszeichen ' +
    '(heartbeatAt), Werkzeugrunden, Fehlercode und die bisher erzeugte Antwort. Damit lässt ' +
    'sich unterscheiden, ob ein Lauf noch arbeitet oder längst beendet ist.',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp'],
  mutating: false,
  async execute(client, input) {
    const run = await client.request({
      method: 'GET',
      path: `/api/ai/runs/${input.runId}`,
      responseSchema: aiRunSchema,
    });
    return { text: renderRun(run), data: run };
  },
});

export const aiRunCancelTool: AnyToolDefinition = defineTool({
  name: 'exo_ai_run_cancel',
  description:
    'Bricht einen wartenden oder laufenden KI-Lauf ab. Ein bereits beendeter Lauf wird nicht ' +
    'angetastet, der Aufruf meldet dann einen Konflikt. Der Worker merkt den Abbruch beim ' +
    'nächsten Lebenszeichen und beendet seine Arbeit.',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp'],
  mutating: true,
  target: (input) => `ai_run:${input.runId}`,
  async execute(client, input) {
    const run = await client.request({
      method: 'POST',
      path: `/api/ai/runs/${input.runId}/cancel`,
      responseSchema: aiRunSchema,
    });
    return { text: `Lauf ${run.id} abgebrochen (${STATUS_LABEL[run.status]}).`, data: run };
  },
});

/** `$1,2345`, from the micro-USD integers the API deals in. */
function formatMicroUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

/**
 * Money in one line, with the calculated part named.
 *
 * Same rule as the admin page: never silently add a reported figure to an
 * estimated one. A model reading this should be able to say "about four
 * dollars, half of it estimated" rather than quoting a total it cannot defend.
 */
function renderCost(cost: AiUsageCost): string {
  const total = cost.measuredMicroUsd + cost.estimatedMicroUsd;
  const notes: string[] = [];
  if (cost.estimatedMicroUsd > 0) {
    notes.push(`davon ${formatMicroUsd(cost.estimatedMicroUsd)} aus der Preisliste geschätzt`);
  }
  if (cost.unpricedRuns > 0) notes.push(`${String(cost.unpricedRuns)} Läufe ohne jeden Preis`);
  return notes.length === 0
    ? formatMicroUsd(total)
    : `${formatMicroUsd(total)} (${notes.join(', ')})`;
}

function renderUsage(usage: AiUsageResponse): string {
  const sections: string[] = [
    [
      `KI-Nutzung von ${usage.from} bis ${usage.to}`,
      `Läufe: ${String(usage.runs)} (${String(usage.byStatus.completed)} erfolgreich, ` +
        `${String(usage.byStatus.failed)} fehlgeschlagen, ` +
        `${String(usage.byStatus.timed_out)} Zeitüberschreitung, ` +
        `${String(usage.byStatus.cancelled)} abgebrochen)`,
      `Erfolgsquote: ${usage.successRate === null ? 'keine beendeten Läufe' : `${(usage.successRate * 100).toFixed(1)} %`}`,
      `Kosten: ${renderCost(usage.cost)}`,
      `Tokens: ${String(usage.tokens.input)} hinein (davon ${String(usage.tokens.cachedInput)} ` +
        `zwischengespeichert), ${String(usage.tokens.output)} hinaus`,
      `Dauer: Median ${usage.medianDurationMs === null ? 'unbekannt' : `${String(usage.medianDurationMs)} ms`}, ` +
        `95. Perzentil ${usage.p95DurationMs === null ? 'unbekannt' : `${String(usage.p95DurationMs)} ms`}`,
      `Werkzeugrunden insgesamt: ${String(usage.toolIterations)}`,
    ].join('\n'),
  ];

  if (usage.byModel.length > 0) {
    sections.push(
      ['Nach Modell:']
        .concat(
          usage.byModel.map((row) => {
            const finished = row.completedRuns + row.failedRuns;
            const rate =
              finished === 0
                ? 'keine beendeten'
                : `${((row.completedRuns / finished) * 100).toFixed(0)} % erfolgreich`;
            return (
              `- ${row.displayName ?? row.model} (${row.model}): ${String(row.runs)} Läufe, ` +
              `${rate}, ${renderCost(row.cost)}, ` +
              `Median ${row.medianDurationMs === null ? 'unbekannt' : `${String(row.medianDurationMs)} ms`}`
            );
          }),
        )
        .join('\n'),
    );
  }

  if (usage.byErrorCode.length > 0) {
    sections.push(
      ['Fehler:']
        .concat(
          usage.byErrorCode.map(
            (row) =>
              `- ${row.errorCode ?? 'ohne Code'}: ${String(row.runs)} Läufe, zuletzt ${row.lastSeenAt}`,
          ),
        )
        .join('\n'),
    );
  }

  if (usage.prunedRuns > 0) {
    sections.push(
      `Hinweis: bei ${String(usage.prunedRuns)} Läufen wurden Frage und Antwort durch die ` +
        'Aufbewahrungsfrist geleert. Die Zahlen oben sind davon unberührt.',
    );
  }

  return sections.join('\n\n');
}

/**
 * The usage report as a tool (issue #10, CLAUDE.md rule 11).
 *
 * Read-only and `mcp`-only. The built-in AI does not get it for the same
 * reason it does not get `exo_ai_run_cancel`: what this reports on is the
 * built-in AI itself, and a model that can read its own cost ledger mid-run
 * will spend tokens reasoning about the tokens it is spending.
 */
export const aiUsageTool: AnyToolDefinition = defineTool({
  name: 'exo_ai_usage',
  description:
    'Wertet die KI-Nutzung des Deployments über einen Zeitraum aus: Läufe nach Status, ' +
    'Erfolgsquote, Kosten (gemeldet und geschätzt getrennt), Tokens rein/raus, Dauer als ' +
    'Median und 95. Perzentil, Aufschlüsselung nach Modell und die Fehlercodes mit ihrer ' +
    'Häufigkeit. Ohne Angabe die letzten 30 Tage. Braucht Administratorrechte.',
  inputSchema: z.object({
    from: z.string().datetime().optional().describe('ISO-Zeitpunkt, Beginn des Zeitraums'),
    to: z.string().datetime().optional().describe('ISO-Zeitpunkt, Ende des Zeitraums (exklusiv)'),
  }),
  surfaces: ['mcp'],
  mutating: false,
  async execute(client, input) {
    const usage = await client.request({
      method: 'GET',
      path: '/api/admin/ai-usage',
      // Undefined entries are dropped by the client, so an omitted bound simply
      // lets the API apply its own default of thirty days.
      query: { from: input.from, to: input.to },
      responseSchema: aiUsageResponseSchema,
    });
    return { text: renderUsage(usage), data: usage };
  },
});

export const AI_RUN_TOOLS: readonly AnyToolDefinition[] = [
  aiRunGetTool,
  aiRunCancelTool,
  aiUsageTool,
];
