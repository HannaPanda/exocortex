import { z } from 'zod';

import {
  notificationPreferencesResponseSchema,
  updateNotificationPreferenceRequestSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The account-wide side of being notified (issue #105, ADR-052).
 *
 * Two tools, and the split is the model rather than an accident: what an
 * account wants by mail is one answer per occasion and lives here, what a
 * browser wants by push is one answer per device and lives in
 * `exo_push_device_update` next door. A single tool covering both would have
 * to pick a winner whenever the two disagreed, and there is no right winner --
 * the phone and the desktop are allowed to differ.
 */

const MODE_WORDS: Record<string, string> = {
  OFF: 'nichts',
  IMMEDIATE: 'sofort',
  DAILY_DIGEST: 'einmal täglich gesammelt',
};

export const notificationPreferencesTool: AnyToolDefinition = defineTool({
  name: 'exo_notification_preferences',
  description:
    'Zeigt, worüber dieses Konto benachrichtigt werden will, und zwar für die Kanäle, die am ' +
    'Konto hängen statt an einem Gerät: derzeit E-Mail. Je Anlass steht dabei, welche ' +
    'Zustellarten möglich sind (OFF, IMMEDIATE), was ohne eigene Entscheidung gilt und was ' +
    'gerade eingestellt ist. Push gehört nicht hierher: was ein einzelner Browser hören soll, ' +
    'steht in exo_push_devices, weil das Handy in der Tasche und der Rechner auf der Arbeit ' +
    'unterschiedliche Antworten geben dürfen.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client) {
    const result = await client.request({
      method: 'GET',
      path: '/api/me/notification-preferences',
      responseSchema: notificationPreferencesResponseSchema,
    });

    const lines = result.preferences.map((preference) => {
      const word = MODE_WORDS[preference.mode] ?? preference.mode;
      const suffix = preference.mode === preference.defaultMode ? ' (Voreinstellung)' : '';
      return `- ${preference.label} über ${preference.channel}: ${word}${suffix}`;
    });

    return {
      text:
        lines.length === 0
          ? 'Für dieses Konto gibt es keine kontoweiten Benachrichtigungen einzustellen.'
          : `Kontoweite Benachrichtigungen:\n${lines.join('\n')}`,
      data: result,
    };
  },
});

export const notificationPreferenceSetTool: AnyToolDefinition = defineTool({
  name: 'exo_notification_preference_set',
  description:
    'Stellt für einen Anlass und einen kontoweiten Kanal ein, wie zugestellt werden soll. ' +
    'Mögliche Anlässe und Zustellarten nennt exo_notification_preferences; eine Kombination, ' +
    'die diese Installation nicht zustellt, wird abgelehnt statt still gespeichert. Zurück auf ' +
    'die Voreinstellung zu stellen löscht die eigene Entscheidung wieder. Für Push ist das hier ' +
    'der falsche Ort, dafür gibt es exo_push_device_update pro Gerät.',
  inputSchema: updateNotificationPreferenceRequestSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `notification-preference:${input.kind}/${input.channel}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: '/api/me/notification-preferences',
      body: input,
      responseSchema: notificationPreferencesResponseSchema,
    });

    const changed = result.preferences.find(
      (preference) => preference.kind === input.kind && preference.channel === input.channel,
    );
    const word = changed === undefined ? input.mode : (MODE_WORDS[changed.mode] ?? changed.mode);
    return {
      text: `${changed?.label ?? input.kind} über ${input.channel}: ${word}.`,
      data: result,
    };
  },
});

export const NOTIFICATION_TOOLS: readonly AnyToolDefinition[] = [
  notificationPreferencesTool,
  notificationPreferenceSetTool,
];
