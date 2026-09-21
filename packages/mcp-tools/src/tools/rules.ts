import { z } from 'zod';

import {
  aiRuleListResponseSchema,
  idSchema,
  markdownExportResponseSchema,
} from '@exocortex/contracts';

import { ExocortexApiError } from '../client.js';
import { truncateText } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

const MAX_RULE_CHARS = 60_000;

/**
 * How long an identifier in this deployment is (`@default(cuid(2))`).
 *
 * Only ever used to describe a miss, never to validate one: a shorter string is
 * refused by the API for being unknown, not for its length, and hardcoding a
 * check here would refuse a perfectly good identifier the day the generator
 * changes.
 */
const ID_CHARS = 24;

/**
 * The answer to an identifier that leads nowhere.
 *
 * `exo_rules_load` is the one tool whose argument is always copied verbatim out
 * of the system prompt, 24 random characters of it, and a model that drops one
 * gets "Document does not exist" -- true, unhelpful, and indistinguishable from
 * a rule page that was deleted. Two runs on 2026-09-21 lost a call each to
 * exactly that, one character short both times. So the miss says what is most
 * likely wrong with the identifier and names the tool that lists the real ones.
 */
function missedRule(documentId: string): string {
  const length =
    documentId.length === ID_CHARS
      ? ''
      : ` Die Kennung ist ${documentId.length} Zeichen lang, Kennungen in eXocortex haben ` +
        `${ID_CHARS}: vermutlich ist sie beim Abschreiben unvollständig geblieben. Im ` +
        'Systemprompt steht sie vollständig.';
  return (
    `Keine Regelseite mit der Kennung ${documentId} erreichbar.${length} ` +
    'exo_rules_list mit der workspaceId nennt alle Regelseiten mit ihren Kennungen.'
  );
}

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
      .map(
        (rule) =>
          `- ${rule.title} (id: ${rule.documentId}, ${rule.mode}): ${rule.trigger ?? '(kein Auslöser)'}`,
      )
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
    try {
      const result = await client.request({
        method: 'GET',
        path: `/api/documents/${input.documentId}/export/markdown`,
        responseSchema: markdownExportResponseSchema,
      });
      const { text } = truncateText(result.markdown, MAX_RULE_CHARS);
      return { text, data: { ...result, fullLength: result.markdown.length } };
    } catch (error) {
      // Only the two ways an identifier can lead nowhere. Everything else --
      // a broken export, an unreachable API -- is the caller's problem to see.
      const missed =
        error instanceof ExocortexApiError && (error.status === 403 || error.status === 404);
      if (!missed) throw error;
      return { text: missedRule(input.documentId), isError: true };
    }
  },
});

export const RULES_TOOLS: readonly AnyToolDefinition[] = [rulesListTool, rulesLoadTool];
