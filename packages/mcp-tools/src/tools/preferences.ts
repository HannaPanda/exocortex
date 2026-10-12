import { z } from 'zod';

import {
  KNOWLEDGE_MAP_POINT_COLOURS,
  KNOWLEDGE_MAP_PULSE_COLOURS,
  knowledgeMapAppearancePatchSchema,
  type KnowledgeMapAppearanceResponse,
  knowledgeMapAppearanceResponseSchema,
  LOCALE_ENDONYMS,
  updateUserPreferencesRequestSchema,
  userPreferencesSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The account's personal settings (issue #98): the interface language, and
 * how the knowledge map looks (issue #189).
 *
 * On both agent surfaces like everything a person can set in the browser
 * (ADR-025). An agent answering "stell mir die Oberfläche auf Englisch" needs
 * the setter; one asking why a mail arrived in Polish needs the reader.
 */

function describeLocale(locale: string | null): string {
  if (locale === null) return 'nicht gewählt, die Oberfläche folgt der Sprache des Browsers';
  const name = (LOCALE_ENDONYMS as Record<string, string>)[locale] ?? locale;
  return `${name} (${locale})`;
}

export const userPreferencesTool: AnyToolDefinition = defineTool({
  name: 'exo_me_preferences',
  description:
    'Zeigt die persönlichen Einstellungen dieses Kontos, die auf jedem Gerät gelten: derzeit ' +
    'die Sprache der Oberfläche. locale null heißt, dass nie eine gewählt wurde; dann richtet ' +
    'sich die Oberfläche nach dem Browser.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
  domain: 'notifications',
  mutating: false,
  async execute(client) {
    const result = await client.request({
      method: 'GET',
      path: '/api/me/preferences',
      responseSchema: userPreferencesSchema,
    });
    return { text: `Sprache der Oberfläche: ${describeLocale(result.locale)}.`, data: result };
  },
});

export const userPreferencesSetTool: AnyToolDefinition = defineTool({
  name: 'exo_me_preferences_set',
  description:
    'Stellt die Sprache der Oberfläche für dieses Konto ein, auf allen Geräten. Mögliche Werte: ' +
    'de, en, es, fr, it, nl, pl, pt-BR, oder null, um die eigene Wahl zu löschen und wieder dem ' +
    'Browser zu folgen. Übersetzt wird nur die Oberfläche, nie die Inhalte der Seiten.',
  inputSchema: updateUserPreferencesRequestSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'notifications',
  mutating: true,
  target: () => 'user-preferences:locale',
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: '/api/me/preferences',
      body: input,
      responseSchema: userPreferencesSchema,
    });
    return { text: `Sprache der Oberfläche: ${describeLocale(result.locale)}.`, data: result };
  },
});

/** The look as a few lines a person can read back and an agent can change from. */
export function renderKnowledgeMapAppearance(result: KnowledgeMapAppearanceResponse): string {
  const { appearance: a } = result;
  const n = (value: number) => String(Math.round(value * 100) / 100);
  return [
    result.isDefault
      ? 'Aussehen der Wissenskarte: Standard (nie angepasst).'
      : 'Aussehen der Wissenskarte: persönlich angepasst.',
    `Bloom: Stärke ${n(a.bloom.strength)}, Radius ${n(a.bloom.radius)}, Schwelle ${n(a.bloom.threshold)}.`,
    `Sterne: Kern ${n(a.star.core)}, Halo ${n(a.star.halo)}, Weichheit ${n(a.star.softness)}. ` +
      `Sättigung ×${n(a.saturation)}, Farbraum-Korrektur ${a.colourCorrection ? 'an' : 'aus'}.`,
    'Punktfarben (Glow/Helligkeit): ' +
      KNOWLEDGE_MAP_POINT_COLOURS.map(
        (key) => `${key} ${n(a.points[key].glow)}/${n(a.points[key].lightness)}`,
      ).join(', ') +
      '.',
    'Pulsfarben (Glow): ' +
      KNOWLEDGE_MAP_PULSE_COLOURS.map((key) => `${key} ${n(a.pulses[key].glow)}`).join(', ') +
      '.',
  ].join('\n');
}

export const knowledgeMapAppearanceTool: AnyToolDefinition = defineTool({
  name: 'exo_knowledge_map_appearance',
  description:
    'Zeigt, wie die Wissenskarte für dieses Konto aussieht: Bloom (Stärke, Radius, Schwelle), ' +
    'die Sterne (Kern, Halo, Weichheit), Sättigung, Farbraum-Korrektur und pro Farbe Glow und ' +
    'Helligkeit. Gilt persönlich, auf allen Geräten und in jedem Arbeitsbereich.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
  domain: 'notifications',
  mutating: false,
  async execute(client) {
    const result = await client.request({
      method: 'GET',
      path: '/api/me/knowledge-map-appearance',
      responseSchema: knowledgeMapAppearanceResponseSchema,
    });
    return { text: renderKnowledgeMapAppearance(result), data: result };
  },
});

export const knowledgeMapAppearanceSetTool: AnyToolDefinition = defineTool({
  name: 'exo_knowledge_map_appearance_set',
  description:
    'Ändert das Aussehen der Wissenskarte für dieses Konto. Nur was genannt ist, ändert sich, z. B. ' +
    '{"points":{"green":{"glow":0.8}}} macht die grünen Punkte leiser. Punktfarben: blue, green, ' +
    'purple, orange, pink, yellow, red, brown, gray, entity (glow 0 bis 3, lightness 0.25 bis ' +
    '0.85); Pulsfarben read, write, created, removed (glow 0 bis 3); bloom.strength 0 bis 2.5, ' +
    'bloom.radius 0 bis 1.5, bloom.threshold 0 bis 1; star.core 0.2 bis 1, star.halo 1 bis 6, ' +
    'star.softness 0.8 bis 5; saturation 0.5 bis 3; colourCorrection true/false. reset: true ' +
    'stellt alles auf den Standard zurück.',
  inputSchema: knowledgeMapAppearancePatchSchema.extend({ reset: z.boolean().optional() }),
  surfaces: ['mcp', 'ai'],
  domain: 'notifications',
  mutating: true,
  target: () => 'user-preferences:knowledge-map-appearance',
  async execute(client, input) {
    const { reset, ...patch } = input;
    // Two literal calls rather than one built request, so the catalogue gate
    // can read which routes this tool reaches.
    const result =
      reset === true
        ? await client.request({
            method: 'DELETE',
            path: '/api/me/knowledge-map-appearance',
            responseSchema: knowledgeMapAppearanceResponseSchema,
          })
        : await client.request({
            method: 'PATCH',
            path: '/api/me/knowledge-map-appearance',
            body: patch,
            responseSchema: knowledgeMapAppearanceResponseSchema,
          });
    return { text: renderKnowledgeMapAppearance(result), data: result };
  },
});

export const PREFERENCE_TOOLS: readonly AnyToolDefinition[] = [
  userPreferencesTool,
  userPreferencesSetTool,
  knowledgeMapAppearanceTool,
  knowledgeMapAppearanceSetTool,
];
