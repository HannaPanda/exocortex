import { z } from 'zod';

import { aiRuleListResponseSchema, idSchema, markdownExportResponseSchema } from '@exocortex/contracts';

import { truncateText } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

const MAX_RULE_CHARS = 60_000;

export const rulesListTool: AnyToolDefinition = defineTool({
  name: 'exo_rules_list',
  description:
    'Listet die KI-Regelseiten eines Workspace. ALWAYS-Regeln stehen bereits im Systemprompt; ' +
    'ON_DEMAND-Regeln zeigen hier nur ihren Auslöser-Satz, ihr Inhalt muss mit exo_rules_load geladen werden.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/ai-rules`,
      responseSchema: aiRuleListResponseSchema,
    });
    if (result.rules.length === 0) {
      return { text: 'Keine KI-Regelseiten vorhanden.', data: result };
    }
    const text = result.rules
      .map((rule) => `- ${rule.title} (id: ${rule.documentId}, ${rule.mode}): ${rule.trigger ?? '(kein Auslöser)'}`)
      .join('\n');
    return { text, data: result };
  },
});

export const rulesLoadTool: AnyToolDefinition = defineTool({
  name: 'exo_rules_load',
  description:
    'Lädt die ausführlichen Anweisungen einer Regelseite. Wenn im Systemprompt eine ' +
    'Regel mit "Details auf Anfrage" steht, rufe dieses Werkzeug mit der genannten ' +
    'documentId auf, bevor du die Aufgabe bearbeitest.',
  inputSchema: z.object({ documentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/documents/${input.documentId}/export/markdown`,
      responseSchema: markdownExportResponseSchema,
    });
    const { text } = truncateText(result.markdown, MAX_RULE_CHARS);
    return { text, data: { ...result, fullLength: result.markdown.length } };
  },
});

export const RULES_TOOLS: readonly AnyToolDefinition[] = [rulesListTool, rulesLoadTool];
