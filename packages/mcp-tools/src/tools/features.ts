import { z } from 'zod';

import { type FeatureArea, featureListResponseSchema } from '@exocortex/contracts';

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
    'Bei wenigen Treffern kommt die ausführliche Beschreibung mit (wie es funktioniert, wie man ' +
    'es benutzt, wo es aufhört); über "detailed" lässt sich das erzwingen oder unterdrücken. ' +
    'Optional auf einen Bereich, eine Suchzeichenkette oder ein Datum eingrenzen.',
  inputSchema: z.object({
    area: z.string().optional().describe('Nur diesen Bereich, z. B. "datenbanken".'),
    query: z.string().optional().describe('Nur Einträge, deren Titel oder Text das enthält.'),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Nur was an diesem Tag oder später dazukam, als YYYY-MM-DD.'),
    detailed: z
      .boolean()
      .optional()
      .describe(
        'Die ausführliche Beschreibung mitliefern (mehrere Absätze pro Eintrag). Ohne Angabe ' +
          'passiert das bei bis zu drei Treffern von selbst, damit eine gezielte Frage eine ' +
          'vollständige Antwort bekommt und eine Übersicht kurz bleibt.',
      ),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'core',
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
      return `${feature.title} ${feature.summary} ${feature.details.join(' ')}`
        .toLowerCase()
        .includes(needle);
    });

    if (matching.length === 0) {
      return { text: 'Keine Funktion passt zu dieser Einschränkung.', data: { features: [] } };
    }

    // Three is where a list stops being an answer and starts being a table of
    // contents. Below it the caller asked about something specific and wants
    // the whole entry; above it the paragraphs would be forty thousand
    // characters of context nobody asked for.
    const detailed = input.detailed ?? matching.length <= 3;

    // The headings come with the list, in the caller's language, like the rest.
    const areaInfo = new Map(result.areas.map((info) => [info.id, info]));
    const lines = [];
    let area: FeatureArea | null = null;
    for (const feature of matching) {
      if (feature.area !== area) {
        area = feature.area;
        const info = areaInfo.get(feature.area);
        lines.push('', `## ${info?.label ?? feature.area}`, '');
        if (info !== undefined) lines.push(info.description, '');
      }
      lines.push(`### ${feature.title} (seit ${feature.since})`);
      lines.push(feature.summary);
      if (detailed) for (const paragraph of feature.details) lines.push('', paragraph);
      const access: string[] = [];
      if (detailed) lines.push('');
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
