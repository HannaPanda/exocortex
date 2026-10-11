import { z } from 'zod';

import {
  type AiRunInspection,
  aiRunInspectionSchema,
  type AiRunTimelineEntry,
  idSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

import { formatMicroUsd, STATUS_LABEL } from './ai-runs.js';

/** German name of each part of a prompt, in the order a run assembles them. */
const SECTION_LABEL: Record<string, string> = {
  base_prompt: 'Grund-Prompt',
  formatting: 'Antwortformat',
  trust_rules: 'Vertrauensregeln',
  always_rules: 'Regelseiten (immer)',
  on_demand_rules: 'Regeln auf Anfrage',
  open_page: 'Geöffnete Seite',
  pinned_sources: 'Angeheftete Quellen',
  closing: 'Arbeitsbereich und Datum',
  agent_role: 'Agentenrolle',
  write_mode: 'Schreibmodus',
  images: 'Bildbeschreibungen',
  conversation_summary: 'Zusammenfassung früherer Nachrichten',
  conversation_user: 'Nachrichten der Person',
  conversation_assistant: 'Frühere Antworten',
  conversation_tool: 'Frühere Werkzeugergebnisse',
  tool_schemas: 'Werkzeugbeschreibungen',
};

function seconds(ms: number | null): string {
  return ms === null ? '' : ` (${(ms / 1000).toFixed(1)} s)`;
}

type TimelineEntryOf<K extends AiRunTimelineEntry['kind']> = Extract<
  AiRunTimelineEntry,
  { kind: K }
>;

function renderTurn(entry: TimelineEntryOf<'turn'>): string {
  const servedBy = entry.servedBy === null ? '' : ` über ${entry.servedBy}`;
  const failure = entry.failureCode === null ? '' : `, Fehler ${entry.failureCode}`;
  return (
    `Modellrunde ${String(entry.index)}: ${entry.model}${servedBy}, ` +
    `${String(entry.inputTokens ?? '?')} Tokens hinein, ${String(entry.outputTokens ?? '?')} hinaus, ` +
    `Ende ${entry.finishReason}${failure}`
  );
}

function renderToolCall(entry: TimelineEntryOf<'tool_call'>): string {
  const notes = [
    `${String(entry.resultChars)} Zeichen`,
    ...(entry.untrustedOrigin === null ? [] : [`Fremdinhalt (${entry.untrustedOrigin})`]),
    ...(entry.resultTruncated ? ['gekürzt'] : []),
    ...(entry.repeated ? ['Wiederholung'] : []),
    ...(entry.pausedRun ? ['pausiert den Lauf'] : []),
  ];
  const target = entry.target === null ? '' : ` → ${entry.targetTitle ?? entry.target}`;
  return `${entry.toolName} ${entry.status}${target}, ${notes.join(', ')}`;
}

/** One line per step, relative to the run's creation. */
function renderEntry(entry: AiRunTimelineEntry, origin: number): string {
  const offset = `+${((Date.parse(entry.at) - origin) / 1000).toFixed(1)} s`;
  const took = seconds(entry.durationMs);
  switch (entry.kind) {
    case 'created':
      return `${offset} angelegt`;
    case 'started':
      return `${offset} gestartet`;
    case 'context':
      return `${offset} Kontext zusammengestellt: ${String(entry.chars)} Zeichen, ~${String(entry.estimatedTokens)} Tokens`;
    case 'compaction':
      return `${offset} Verlauf verdichtet: ${String(entry.summarizedMessages)} Nachrichten${took}`;
    case 'turn':
      return `${offset} ${renderTurn(entry)}${took}`;
    case 'tool_call':
      return `${offset} ${renderToolCall(entry)}${took}`;
    case 'truncation_retry':
      return `${offset} am Ausgabelimit abgeschnitten, Versuch ${String(entry.attempt)}`;
    case 'attention_raised':
      return `${offset} Rückfrage gestellt: ${entry.title}${entry.blocking ? ' (blockierend)' : ''}`;
    case 'attention_settled':
      return `${offset} Rückfrage erledigt (${entry.status})`;
    case 'changeset':
      return `${offset} Änderungsvorschlag: ${entry.title} (${entry.status})`;
    case 'work_checkpoint':
      return `${offset} Arbeitsstand festgehalten (${entry.trigger})`;
    case 'resumed_from':
      return `${offset} setzt Lauf ${entry.runId} fort`;
    case 'resumed_as':
      return `${offset} fortgesetzt in Lauf ${entry.runId}`;
    case 'finished':
      return `${offset} beendet: ${STATUS_LABEL[entry.status]}${entry.errorCode === null ? '' : ` (${entry.errorCode})`}${took}`;
  }
}

function renderInspection(inspection: AiRunInspection): string {
  const { run, summary } = inspection;
  const origin = Date.parse(run.createdAt);
  const cost =
    summary.providerCostMicroUsd !== null
      ? formatMicroUsd(summary.providerCostMicroUsd)
      : summary.estimatedCostMicroUsd !== null
        ? `${formatMicroUsd(summary.estimatedCostMicroUsd)} (geschätzt)`
        : 'unbekannt';
  const sections: string[] = [
    [
      `Lauf ${run.id}: ${STATUS_LABEL[run.status]}, Modell ${run.model}`,
      `Dauer: ${summary.durationMs === null ? 'unbekannt' : `${(summary.durationMs / 1000).toFixed(1)} s`}, ` +
        `Modellrunden: ${String(summary.turns)}, Werkzeugaufrufe: ${String(summary.toolCalls)} ` +
        `(${String(summary.failedToolCalls)} nicht erfolgreich)`,
      `Anbieter: ${summary.providers.length === 0 ? 'nicht gemeldet' : summary.providers.join(', ')}` +
        `, Wechsel: ${String(summary.providerSwitches)}`,
      `Tokens: ${String(summary.inputTokens ?? '?')} hinein, ${String(summary.outputTokens ?? '?')} hinaus, Kosten: ${cost}`,
      `Korrelations-ID: ${inspection.trace.correlationId ?? 'keine'}` +
        `${inspection.trace.traceId === null ? '' : `, Trace-ID: ${inspection.trace.traceId}`}`,
    ].join('\n'),
  ];
  if (!inspection.recorded) {
    sections.push('Für diesen Lauf wurde kein Ablauf aufgezeichnet (älter als der Run Inspector).');
  }
  if (inspection.context !== null) {
    sections.push(
      [
        `Kontext vor der ersten Runde: ${String(inspection.context.chars)} Zeichen, ~${String(inspection.context.estimatedTokens)} Tokens`,
        ...inspection.context.sections.map((section) => {
          const named = section.sources
            .map((source) => source.title ?? source.documentId ?? source.savedQueryId)
            .filter((name): name is string => name !== null);
          return (
            `- ${SECTION_LABEL[section.key] ?? section.key}: ${String(section.chars)} Zeichen` +
            `${section.truncated ? ', gekürzt' : ''}${named.length === 0 ? '' : ` (${named.join(', ')})`}`
          );
        }),
      ].join('\n'),
    );
  }
  if (inspection.toolResults.length > 0) {
    sections.push(
      [
        'Werkzeugergebnisse im Lauf:',
        ...inspection.toolResults.map(
          (entry) =>
            `- ${entry.origin === 'internal' ? 'aus diesem Arbeitsbereich' : `Fremdinhalt (${entry.origin})`}: ` +
            `${String(entry.calls)} Aufrufe, ${String(entry.chars)} Zeichen`,
        ),
      ].join('\n'),
    );
  }
  sections.push(
    ['Ablauf:', ...inspection.timeline.map((entry) => renderEntry(entry, origin))].join('\n'),
  );
  if (inspection.eventsCapped) sections.push('Hinweis: Die Aufzeichnung hat ihr Limit erreicht.');
  return sections.join('\n\n');
}

/**
 * The run inspector as a tool (issue #145, ADR-073). `mcp` only for the same
 * reason as `exo_ai_run_get`: the built-in AI is what it reads.
 */
export const aiRunInspectTool: AnyToolDefinition = defineTool({
  name: 'exo_ai_run_inspect',
  description:
    'Zeigt, was ein KI-Lauf getan hat und woraus sein Kontext bestand: Zeitleiste mit ' +
    'Modellrunden (Modell, Anbieter, Tokens, Kosten), Werkzeugaufrufen (Ziel, Dauer, Ergebnis, ' +
    'Fremdinhalt), Rückfragen, Fortsetzungen und Vorschlägen, dazu die Zusammensetzung des ' +
    'Prompts nach Teilen und Quellen sowie Korrelations- und Trace-ID. Enthält nie Prompt- ' +
    'oder Antworttext.',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp'],
  domain: 'chats',
  mutating: false,
  async execute(client, input) {
    const inspection = await client.request({
      method: 'GET',
      path: `/api/ai/runs/${input.runId}/inspection`,
      responseSchema: aiRunInspectionSchema,
    });
    return { text: renderInspection(inspection), data: inspection };
  },
});
