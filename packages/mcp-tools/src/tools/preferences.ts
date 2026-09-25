import { z } from 'zod';

import {
  LOCALE_ENDONYMS,
  updateUserPreferencesRequestSchema,
  userPreferencesSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The account's personal settings (issue #98): today the interface language.
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

export const PREFERENCE_TOOLS: readonly AnyToolDefinition[] = [
  userPreferencesTool,
  userPreferencesSetTool,
];
