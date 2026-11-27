import { z } from 'zod';

import {
  AI_FILL_PRESETS,
  type AiFillRun,
  aiFillRunDetailSchema,
  aiFillRunListResponseSchema,
  aiFillRunSchema,
  type AiFillStartResponse,
  aiFillStartResponseSchema,
  databasePropertySchema,
  idSchema,
  setDatabasePropertyAiRequestSchema,
  startAiFillRequestSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * A database column a model fills in (issue #237, ADR-099), for an agent: the
 * column's instruction, and the batches that fill it, with the whole loop a
 * person has in the table: start, status, result, retry, cancel.
 */

const PRESETS =
  `Vorlagen (preset): ${AI_FILL_PRESETS.join(', ')}. summary, key_points, translate passen zu ` +
  'Text, tags zu Auswahl und Mehrfachauswahl, document_date zu Datum, sender und recipient zu ' +
  'Text, Person und E-Mail; custom zu jedem füllbaren Typ und braucht instruction.';

const propertyAiInputSchema = z
  .object({ documentId: idSchema, propertyId: idSchema })
  .extend(setDatabasePropertyAiRequestSchema.shape);

export const databasePropertyAiSetTool: AnyToolDefinition = defineTool({
  name: 'exo_database_property_ai_set',
  description:
    'Gibt einer Datenbankspalte eine KI-Anweisung oder ändert sie: Danach kann die KI die ' +
    'Zellen dieser Spalte aus dem ausfüllen, was in der Zeile steht (Seiteninhalt, andere ' +
    'Spalten, Anhänge). Füllt selbst noch nichts aus, dafür gibt es exo_database_ai_fill_start. ' +
    `${PRESETS} Bei preset custom ist instruction die ganze Anweisung, sonst ein Zusatz; ` +
    'translate braucht targetLanguage. allowNewOptions erlaubt bei Auswahlspalten neue Optionen. ' +
    'useContent, useProperties und useAttachments wählen, was gelesen wird. autoFill ' +
    '(off, on_create, on_change) lässt die Spalte sich selbst füllen; Standard ist off. ' +
    'Weggelassene Felder behalten ihren Wert. Braucht das Recht, die Spalten zu ändern.',
  inputSchema: propertyAiInputSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, propertyId, ...body } = input;
    const property = await client.request({
      method: 'PATCH',
      path: `/api/documents/${documentId}/properties/${propertyId}/ai`,
      body,
      responseSchema: databasePropertySchema,
    });
    const ai = property.ai;
    return {
      text:
        ai === null || ai === undefined
          ? `Spalte „${property.name}“ hat keine KI-Anweisung.`
          : `Spalte „${property.name}“ hat jetzt die KI-Anweisung ${ai.preset}` +
            (ai.instruction === null ? '' : `: ${ai.instruction}`) +
            ` (automatisch: ${ai.autoFill}).`,
      data: property,
    };
  },
});

export const databasePropertyAiRemoveTool: AnyToolDefinition = defineTool({
  name: 'exo_database_property_ai_remove',
  description:
    'Nimmt einer Datenbankspalte ihre KI-Anweisung. Die Werte, die die KI schon geschrieben ' +
    'hat, bleiben stehen; ein laufender Durchgang läuft mit der Anweisung zu Ende, mit der er ' +
    'begonnen hat.',
  inputSchema: z.object({ documentId: idSchema, propertyId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const property = await client.request({
      method: 'DELETE',
      path: `/api/documents/${input.documentId}/properties/${input.propertyId}/ai`,
      responseSchema: databasePropertySchema,
    });
    return { text: `KI-Anweisung von „${property.name}“ entfernt.`, data: property };
  },
});

const startInputSchema = z.object({ documentId: idSchema }).extend(startAiFillRequestSchema.shape);

export const databaseAiFillStartTool: AnyToolDefinition = defineTool({
  name: 'exo_database_ai_fill_start',
  description:
    'Lässt die KI eine Spalte mit KI-Anweisung ausfüllen, für die genannten Zeilen (rowIds) ' +
    'oder ohne rowIds für die ganze Spalte. mode: empty_only (Standard) füllt nur leere Zellen, ' +
    'replace_ai erneuert zusätzlich Werte, die die KI geschrieben hat und niemand seitdem ' +
    'geändert hat, replace_all überschreibt auch Werte von Menschen und braucht deren ' +
    'ausdrückliches Einverständnis. Ein Durchgang ist ein KI-Lauf, der Geld kostet, und hält ' +
    'höchstens ai.fillMaxRowsPerRun Zeilen; die Antwort nennt, wie viele übrig sind. dryRun ' +
    'zählt nur, was gefüllt würde. Der Durchgang läuft im Hintergrund weiter: Stand mit ' +
    'exo_database_ai_fill_status, abbrechen mit exo_database_ai_fill_cancel.',
  inputSchema: startInputSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: true,
  destructive: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/ai-fills`,
      body,
      responseSchema: aiFillStartResponseSchema,
    });
    return { text: startText(result, body.dryRun === true), data: result };
  },
});

function startText(result: AiFillStartResponse, dryRun: boolean): string {
  const left = [
    result.skippedNotEmpty > 0 ? `${result.skippedNotEmpty} haben schon einen Wert` : null,
    result.skippedForbidden > 0 ? `${result.skippedForbidden} darfst du nicht ändern` : null,
    result.skippedActive > 0 ? `${result.skippedActive} füllt schon ein anderer Durchgang` : null,
    result.remaining > 0
      ? `${result.remaining} bleiben über dem Limit von ${result.limit} für einen weiteren Durchgang`
      : null,
  ].filter((entry): entry is string => entry !== null);
  const rest = left.length === 0 ? '' : ` Ausgelassen: ${left.join(', ')}.`;
  if (dryRun) return `Würde ${result.queued} Zelle(n) füllen.${rest}`;
  if (result.run === null) return `Nichts zu füllen.${rest}`;
  return `Durchgang ${result.run.id} gestartet: ${result.queued} Zelle(n) in „${result.run.propertyName}“.${rest}`;
}

function runLine(run: AiFillRun): string {
  const counts = run.counts;
  return (
    `${run.id}: ${run.propertyName}, ${run.status} (${run.mode}, ${run.origin}), ` +
    `${counts.filled} gefüllt, ${counts.empty} ohne Ergebnis, ${counts.failed} fehlgeschlagen, ` +
    `${counts.skipped} übersprungen, ${counts.cancelled} abgebrochen, ` +
    `${counts.queued + counts.running} offen von ${counts.total}` +
    (run.errorCode === null ? '' : `; Fehler: ${run.errorCode}`)
  );
}

export const databaseAiFillsTool: AnyToolDefinition = defineTool({
  name: 'exo_database_ai_fills',
  description:
    'Listet die KI-Ausfülldurchgänge einer Datenbank, neueste zuerst (höchstens 20), mit Stand ' +
    'und Zählung der Zellen. active: true zeigt nur die, die noch laufen.',
  inputSchema: z.object({ documentId: idSchema, active: z.boolean().optional() }),
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/ai-fills`,
      query: { active: input.active === true ? 'true' : undefined },
      responseSchema: aiFillRunListResponseSchema,
    });
    return {
      text:
        result.runs.length === 0
          ? 'Keine Durchgänge.'
          : result.runs.map((run) => `- ${runLine(run)}`).join('\n'),
      data: result,
    };
  },
});

export const databaseAiFillStatusTool: AnyToolDefinition = defineTool({
  name: 'exo_database_ai_fill_status',
  description:
    'Stand eines KI-Ausfülldurchgangs: Status, Kosten und jede Zelle mit ihrem Ergebnis ' +
    '(filled, empty, skipped, failed mit Fehlercode, cancelled). Die geschriebenen Werte ' +
    'stehen in der Zeile selbst (exo_database_row_get).',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: false,
  async execute(client, input) {
    const run = await client.request({
      method: 'GET',
      path: `/api/ai-fills/${input.runId}`,
      responseSchema: aiFillRunDetailSchema,
    });
    const cells = run.cells.map(
      (cell) =>
        `- ${cell.rowTitle} (Zeile ${cell.rowId}): ${cell.status}` +
        (cell.errorCode === null ? '' : ` (${cell.errorCode})`),
    );
    return { text: [runLine(run), ...cells].join('\n'), data: run };
  },
});

export const databaseAiFillCancelTool: AnyToolDefinition = defineTool({
  name: 'exo_database_ai_fill_cancel',
  description:
    'Bricht einen laufenden KI-Ausfülldurchgang ab. Was schon geschrieben ist, bleibt; offene ' +
    'Zellen werden nicht mehr gefragt. Darf, wer ihn gestartet hat oder die Datenbank ändern darf.',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: true,
  target: (input) => `ai-fill:${input.runId}`,
  async execute(client, input) {
    const run = await client.request({
      method: 'POST',
      path: `/api/ai-fills/${input.runId}/cancel`,
      responseSchema: aiFillRunSchema,
    });
    return { text: `Abgebrochen. ${runLine(run)}`, data: run };
  },
});

export const databaseAiFillRetryTool: AnyToolDefinition = defineTool({
  name: 'exo_database_ai_fill_retry',
  description:
    'Startet einen neuen Durchgang für die Zellen eines beendeten, die fehlgeschlagen sind oder ' +
    'abgebrochen wurden, mit demselben mode und der aktuellen Anweisung der Spalte.',
  inputSchema: z.object({ runId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'databases',
  mutating: true,
  destructive: true,
  target: (input) => `ai-fill:${input.runId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/ai-fills/${input.runId}/retry`,
      responseSchema: aiFillStartResponseSchema,
    });
    return { text: startText(result, false), data: result };
  },
});

export const DATABASE_AI_FILL_TOOLS: readonly AnyToolDefinition[] = [
  databasePropertyAiSetTool,
  databasePropertyAiRemoveTool,
  databaseAiFillStartTool,
  databaseAiFillsTool,
  databaseAiFillStatusTool,
  databaseAiFillCancelTool,
  databaseAiFillRetryTool,
];
