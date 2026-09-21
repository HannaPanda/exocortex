import { z } from 'zod';

import {
  documentOverviewResponseSchema,
  documentSummarySchema,
  idSchema,
  overviewModeSchema,
  refreshDocumentOverviewResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

import { formatDocumentSummary } from './page-render.js';

/**
 * Overview pages (issue #53, ADR-028).
 *
 * The composition is derived text beside the page, not its body, so it has its
 * own read rather than turning up in `exo_page_read`: a caller that wants what
 * the page itself says gets that, and a caller that wants the map of what is
 * underneath asks for the map.
 */

export const pageSetOverviewTool: AnyToolDefinition = defineTool({
  name: 'exo_page_set_overview',
  description:
    'Markiert eine Seite als Übersichtsseite oder hebt die Markierung auf. Eine Übersichtsseite ' +
    'listet ihre Unterseiten mit kurzer Beschreibung und bekommt einen Vorspann, der bei jeder ' +
    'Änderung an den Unterseiten neu geschrieben wird. ' +
    'Wenn du eine neue Sammelseite anlegst, die vor allem Unterseiten bündelt, markiere sie so ' +
    'und schreibe keinen eigenen Fließtext hinein: der veraltet, sobald jemand eine Unterseite ' +
    'anlegt oder löscht. Eigener Text ist nur sinnvoll, wenn er etwas sagt, das die Unterseiten ' +
    'nicht hergeben. Der Seitenkörper bleibt in jedem Fall unangetastet, die Übersicht steht daneben.',
  inputSchema: z.object({ documentId: idSchema, mode: overviewModeSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'appearance',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: `/api/documents/${input.documentId}`,
      body: { overviewMode: input.mode },
      responseSchema: documentSummarySchema,
    });
    const text =
      input.mode === 'auto'
        ? `Als Übersichtsseite markiert: ${formatDocumentSummary(result)}. Der Vorspann wird im Hintergrund geschrieben.`
        : `Markierung als Übersichtsseite entfernt: ${formatDocumentSummary(result)}`;
    return { text, data: result };
  },
});

export const pageOverviewReadTool: AnyToolDefinition = defineTool({
  name: 'exo_page_overview_read',
  description:
    'Liest die Übersicht einer Seite: den automatisch geschriebenen Vorspann und die Unterseiten ' +
    'mit ihren Steckbriefen. Der schnellste Weg, um zu sehen, was unter einer Sammelseite liegt, ' +
    'ohne jede Unterseite einzeln zu öffnen. Bei einer Seite, die keine Übersichtsseite ist, ' +
    'antwortet das Werkzeug genau das.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'appearance',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/overview`,
      responseSchema: documentOverviewResponseSchema,
    });
    if (result.mode === 'off') {
      return {
        text: 'Diese Seite ist keine Übersichtsseite. Mit exo_page_set_overview lässt sie sich dazu machen.',
        data: result,
      };
    }

    const lines = [
      result.intro ?? '(noch kein Vorspann)',
      result.stale ? '(veraltet: die Unterseiten haben sich seitdem geändert)' : null,
      '',
      ...result.entries.map((entry) => {
        const facts = [
          entry.isOverview ? 'Übersichtsseite' : null,
          entry.childCount > 0 ? `${entry.childCount} Unterseiten` : null,
        ].filter((fact): fact is string => fact !== null);
        const suffix = facts.length === 0 ? '' : ` [${facts.join(', ')}]`;
        return `- ${entry.title} (id: ${entry.documentId})${suffix}: ${entry.summary ?? 'noch keine Beschreibung'}`;
      }),
    ].filter((line): line is string => line !== null);

    return { text: lines.join('\n'), data: result };
  },
});

export const pageOverviewRefreshTool: AnyToolDefinition = defineTool({
  name: 'exo_page_overview_refresh',
  description:
    'Lässt den Vorspann einer Übersichtsseite sofort neu schreiben, auch wenn sich nichts ' +
    'geändert hat. Normalerweise unnötig: die Übersicht wird von selbst aktualisiert, wenn sich ' +
    'eine Unterseite ändert. Der Aufruf bestätigt nur den Auftrag, der Text entsteht im Hintergrund.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'appearance',
  mutating: true,
  target: (input) => `document:${input.documentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${input.documentId}/overview/refresh`,
      responseSchema: refreshDocumentOverviewResponseSchema,
    });
    return {
      text:
        result.status === 'pending'
          ? `Die Übersicht von Seite ${result.documentId} wird neu geschrieben.`
          : `Nicht ausgeführt: ${result.reason ?? 'unbekannter Grund'}`,
      data: result,
    };
  },
});

export const OVERVIEW_TOOLS: readonly AnyToolDefinition[] = [
  pageSetOverviewTool,
  pageOverviewReadTool,
  pageOverviewRefreshTool,
];
