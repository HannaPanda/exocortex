import { z } from 'zod';

import {
  type ChatScrollMode,
  KNOWLEDGE_MAP_POINT_COLOURS,
  KNOWLEDGE_MAP_PULSE_COLOURS,
  knowledgeMapAppearancePatchSchema,
  type KnowledgeMapAppearanceResponse,
  knowledgeMapAppearanceResponseSchema,
  LOCALE_ENDONYMS,
  type OutlinePinnedMode,
  type OutlineTransparency,
  type TimeFormat,
  updateUserPreferencesRequestSchema,
  type UserPreferences,
  userPreferencesSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The account's personal settings: the interface language (issue #98), how
 * the AI chat scrolls while an answer arrives (issue #282), how a pinned page
 * outline behaves (issue #283), whether the editor marks the block the caret
 * is in (issue #238), and how the knowledge map looks (issue #189).
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

function describeChatScroll(mode: ChatScrollMode): string {
  return mode === 'answerStart'
    ? 'am Antwortanfang bleiben (answerStart): die Frage rückt beim Start einer Antwort einmal nach oben, danach bewegt sich die Ansicht nicht mehr von selbst'
    : 'mitlaufen (follow): die Ansicht folgt der wachsenden Antwort, bis man hochscrollt';
}

function describeOutlinePinned(mode: OutlinePinnedMode): string {
  return mode === 'overlay'
    ? 'über dem Text (overlay): der Text bleibt stehen, die Gliederung liegt darüber und verdeckt ihn, wo der Rand nicht reicht'
    : 'eigene Spalte (column): der Text weicht zur Seite aus und wird nie verdeckt';
}

const TIME_FORMAT_WORDS: Record<TimeFormat, string> = {
  auto: 'wie die Sprache der Oberfläche es schreibt (auto), etwa 14:30 auf Deutsch und 2:30 PM auf Englisch',
  '24h': 'immer 24 Stunden (24h), etwa 14:30',
  '12h': 'immer 12 Stunden (12h), etwa 2:30 PM',
};

const TRANSPARENCY_WORDS: Record<OutlineTransparency, string> = {
  none: 'deckend (none)',
  light: 'leicht durchscheinend (light)',
  strong: 'stark durchscheinend (strong)',
};

function renderPreferences(result: UserPreferences): string {
  return [
    `Sprache der Oberfläche: ${describeLocale(result.locale)}.`,
    `Uhrzeit: ${TIME_FORMAT_WORDS[result.timeFormat]}.`,
    `Scrollen im KI-Chat: ${describeChatScroll(result.chatScroll)}.`,
    `Angepinnte Gliederung: ${describeOutlinePinned(result.outlinePinned)}.`,
    `Transparenz der überlagernden Gliederung: ${TRANSPARENCY_WORDS[result.outlineTransparency]}` +
      (result.outlinePinned === 'overlay' ? '.' : ', wirkt nur beim Überlagern.'),
    `Ausweichen für die Schreibzeile: ${result.outlineDodge ? 'an' : 'aus'}` +
      (result.outlinePinned === 'overlay' ? '.' : ', wirkt nur beim Überlagern.'),
    `Gliederung beim Überfahren aufklappen: ${result.outlineHoverExpand ? 'an' : 'aus'}.`,
    `Markierung des Blocks mit dem Cursor am linken Rand: ${result.activeBlockMarker ? 'an' : 'aus'}.`,
  ].join('\n');
}

export const userPreferencesTool: AnyToolDefinition = defineTool({
  name: 'exo_me_preferences',
  description:
    'Zeigt die persönlichen Einstellungen dieses Kontos, die auf jedem Gerät gelten: die ' +
    'Sprache der Oberfläche, wie Uhrzeiten geschrieben werden, wie der KI-Chat scrollt, während eine Antwort entsteht, und wie ' +
    'sich die angepinnte Gliederung einer Seite verhält, und ob der Editor den Block mit dem ' +
    'Cursor am linken Rand markiert. locale null heißt, dass nie eine ' +
    'gewählt wurde; dann richtet sich die Oberfläche nach dem Browser. timeFormat ist auto ' +
    '(wie die Sprache es schreibt, Standard), 24h oder 12h. chatScroll ist follow ' +
    '(mitlaufen, Standard) oder answerStart (am Antwortanfang bleiben). outlinePinned ist ' +
    'column (eigene Spalte, der Text weicht aus, Standard) oder overlay (über dem Text), ' +
    'outlineTransparency none, light oder strong, outlineDodge, outlineHoverExpand und ' +
    'activeBlockMarker true oder false.',
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
    return { text: renderPreferences(result), data: result };
  },
});

export const userPreferencesSetTool: AnyToolDefinition = defineTool({
  name: 'exo_me_preferences_set',
  description:
    'Ändert persönliche Einstellungen dieses Kontos, auf allen Geräten. Nur was genannt ist, ' +
    'ändert sich. locale: de, en, es, fr, it, nl, pl, pt-BR, oder null, um die eigene Wahl zu ' +
    'löschen und wieder dem Browser zu folgen; übersetzt wird nur die Oberfläche, nie die ' +
    'Inhalte der Seiten. timeFormat: auto (Uhrzeiten so, wie die Sprache der Oberfläche sie ' +
    'schreibt, Standard), 24h (immer 14:30) oder 12h (immer 2:30 PM); gespeicherte Zeitpunkte ' +
    'bleiben UTC, ein Datum ohne Uhrzeit hat keine. chatScroll: follow (der KI-Chat läuft mit der wachsenden Antwort mit, ' +
    'Standard) oder answerStart (die Frage rückt beim Start einer Antwort einmal nach oben, ' +
    'danach bleibt die Ansicht stehen und die Antwort wächst nach unten weiter). ' +
    'outlinePinned: column (die angepinnte Gliederung bekommt eine eigene Spalte, der Text ' +
    'weicht aus, Standard) oder overlay (sie liegt über dem Text und verdeckt ihn, wo der Rand ' +
    'nicht reicht). outlineTransparency: none (deckend, Standard), light oder strong (der ' +
    'verdeckte Text scheint durch; unter der Maus oder mit Tastaturfokus wird die Gliederung ' +
    'wieder voll sichtbar); wirkt nur bei overlay. outlineDodge: true (Standard) lässt die ' +
    'überlagernde Gliederung nach oben oder unten ausweichen, sobald der Cursor in einer Zeile ' +
    'steht, die sie verdecken würde; false lässt sie stehen; wirkt nur bei overlay. ' +
    'outlineHoverExpand: true öffnet die Liste der Gliederung, sobald die Maus auf der Skala ' +
    'am rechten Rand ruht, false (Standard) erst beim Klick. activeBlockMarker: true ' +
    '(Standard) zeigt beim Schreiben einen feinen Strich im linken Rand neben dem Block, in ' +
    'dem der Cursor steht; false lässt ihn weg.',
  inputSchema: updateUserPreferencesRequestSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'notifications',
  mutating: true,
  target: () => 'user-preferences',
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: '/api/me/preferences',
      body: input,
      responseSchema: userPreferencesSchema,
    });
    return { text: renderPreferences(result), data: result };
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
