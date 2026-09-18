import { z } from 'zod';

import { FEATURE_AREA_LABELS, featureListResponseSchema } from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The feature registry as a tool (issue #80, ADR-040).
 *
 * Here for the same reason the help page is: an agent that has been asked
 * "can eXocortex do X" otherwise answers from whatever it remembers of the
 * repository, which is a year out of date the moment the session starts. This
 * returns what is actually built, with the door named.
 */
export const featuresTool: AnyToolDefinition = defineTool({
  name: 'exo_features',
  description:
    'Listet die Funktionen dieser eXocortex-Installation in verständlicher Form, mit Bereich, ' +
    'Zugang (Bildschirm, Tastenkürzel, Werkzeuge, Einstellungen) und dem Datum, seit wann es sie gibt. ' +
    'Nimm das, statt aus dem Gedächtnis zu beantworten, was die Installation kann. ' +
    'Optional auf einen Bereich, eine Suchzeichenkette oder ein Datum eingrenzen.',
  inputSchema: z.object({
    area: z.string().optional().describe('Nur diesen Bereich, z. B. "datenbanken".'),
    query: z.string().optional().describe('Nur Einträge, deren Titel oder Text das enthält.'),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Nur was an diesem Tag oder später dazukam, als YYYY-MM-DD.'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: '/api/features',
      responseSchema: featureListResponseSchema,
    });

    const needle = input.query?.trim().toLowerCase();
    const matching = result.features.filter((feature) => {
      if (input.area !== undefined && feature.area !== input.area) return false;
      if (input.since !== undefined && feature.since < input.since) return false;
      if (needle === undefined || needle.length === 0) return true;
      return `${feature.title} ${feature.summary}`.toLowerCase().includes(needle);
    });

    if (matching.length === 0) {
      return { text: 'Keine Funktion passt zu dieser Einschränkung.', data: { features: [] } };
    }

    const lines = [];
    let area = null;
    for (const feature of matching) {
      if (feature.area !== area) {
        area = feature.area;
        lines.push('', `## ${FEATURE_AREA_LABELS[feature.area] ?? feature.area}`, '');
      }
      lines.push(`### ${feature.title} (seit ${feature.since})`);
      lines.push(feature.summary);
      const access = [];
      if (feature.access.ui !== null) {
        const path = feature.access.ui.path;
        access.push(`Bildschirm: ${feature.access.ui.where}${path === null ? '' : ` (${path})`}`);
      }
      if (feature.access.shortcuts.length > 0) {
        access.push(`Tastenkürzel: ${feature.access.shortcuts.join(', ')}`);
      }
      if (feature.access.tools.length > 0) {
        access.push(`Werkzeuge: ${feature.access.tools.join(', ')}`);
      }
      if (feature.access.settings.length > 0) {
        access.push(`Einstellungen: ${feature.access.settings.join(', ')}`);
      }
      for (const line of access) lines.push(`- ${line}`);
      lines.push('');
    }

    return { text: lines.join('\n').trim(), data: { features: matching } };
  },
});

export const FEATURE_TOOLS: readonly AnyToolDefinition[] = [featuresTool];
