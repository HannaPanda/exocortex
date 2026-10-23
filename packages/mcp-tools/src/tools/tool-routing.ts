import { z } from 'zod';

import { type ToolRoutingStatus, toolRoutingStatusSchema } from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The switch for the built-in AI's tool routing (issue #206, ADR-089).
 *
 * The deployment's settings are out of an agent's reach on purpose, and this
 * one is not, because it is the emergency stop for a model call every run of
 * the built-in AI makes and must work without a browser. It decides which
 * tools a run is told about, never which it may call (ADR-060). Both need
 * deployment administrator rights, which the API checks.
 */

function renderStatus(status: ToolRoutingStatus, prefix: string): string {
  const reasons = Object.entries(status.last24h.fallbackReasons)
    .map(([reason, count]) => `${reason} ${String(count)}`)
    .join(', ');
  return [
    `${prefix}Werkzeugauswahl mit Jev ist ${status.enabled ? 'an' : 'aus'} ` +
      `(${status.model}, Schwelle ${String(status.threshold)}, ` +
      `Rückfall auf Schlüsselwörter nach ${String(status.timeoutMs)} ms).`,
    `Letzte 24 Stunden: ${String(status.last24h.runs)} Läufe, davon Jev ${String(status.last24h.jev)}, ` +
      `Schlüsselwörter ${String(status.last24h.keywords)}, Rückfall ${String(status.last24h.fallback)}` +
      (reasons === '' ? '.' : ` (${reasons}).`),
  ].join('\n');
}

const toolRoutingGetTool = defineTool({
  name: 'exo_tool_routing',
  description:
    'Zeigt, ob die eingebaute KI ihre Werkzeugbereiche von Jev wählen lässt oder nach ' +
    'Schlüsselwörtern, und wie die Läufe der letzten 24 Stunden gewählt wurden (Jev, ' +
    'Schlüsselwörter, Rückfall mit Grund). Braucht globale Administratorrechte.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: false,
  async execute(client) {
    const status = await client.request({
      method: 'GET',
      path: '/api/admin/tool-routing',
      responseSchema: toolRoutingStatusSchema,
    });
    return { text: renderStatus(status, ''), data: status };
  },
});

const toolRoutingSetTool = defineTool({
  name: 'exo_tool_routing_set',
  description:
    'Schaltet die Werkzeugauswahl mit Jev für die ganze Installation an oder aus. Aus heißt: ' +
    'die eingebaute KI wählt ihre Werkzeugbereiche wieder nur nach Schlüsselwörtern, ab dem ' +
    'nächsten Lauf, ohne Neustart. Gedacht als Notschalter, wenn Jev ausfällt oder schlecht ' +
    'wählt. Das ist keine Berechtigung: jedes Werkzeug bleibt aufrufbar. Ein Arbeitsbereich ' +
    'kann sich in seinen Einstellungen selbst abschalten, aber nie gegen die Installation ' +
    'einschalten. Braucht globale Administratorrechte.',
  inputSchema: z.object({
    enabled: z.boolean().describe('true: Jev wählt; false: nur Schlüsselwörter'),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'admin',
  mutating: true,
  target: () => 'setting:ai.semanticToolRouting',
  async execute(client, input) {
    const status = await client.request({
      method: 'PATCH',
      path: '/api/admin/tool-routing',
      body: { enabled: input.enabled },
      responseSchema: toolRoutingStatusSchema,
    });
    return { text: renderStatus(status, 'Gespeichert. '), data: status };
  },
});

export const TOOL_ROUTING_TOOLS: readonly AnyToolDefinition[] = [
  toolRoutingGetTool,
  toolRoutingSetTool,
];
