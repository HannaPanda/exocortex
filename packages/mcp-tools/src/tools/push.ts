import { z } from 'zod';

import {
  idSchema,
  pushDeviceListResponseSchema,
  pushNotificationKindSchema,
  sendPushRequestSchema,
  sendPushResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Push notifications, from an agent's side (issue #30, ADR-048).
 *
 * Three tools and deliberately not four: registering a device is missing,
 * because a subscription is minted by a browser's own push service and an
 * agent has none. Everything an agent can sensibly do with somebody's devices
 * -- see them, silence one, reach them -- is here.
 */

const removedResponseSchema = z.object({ removed: z.literal(true) });

export const pushDevicesTool: AnyToolDefinition = defineTool({
  name: 'exo_push_devices',
  description:
    'Listet die Geräte, auf denen dieses Konto Push-Benachrichtigungen empfangen kann, mit dem ' +
    'Namen, dem Push-Dienst dahinter, den zugelassenen Arten (Termine, Kommentare, Agenten) und ' +
    'wann zuletzt etwas ankam. Vor exo_push_send nützlich: hört kein Gerät auf "AGENT", geht ' +
    'eine Nachricht ins Leere. Angemeldet wird ein Gerät nur im Browser, unter Einstellungen → ' +
    'Verbindungen; ein Abonnement kommt vom Push-Dienst des Browsers und lässt sich von außen ' +
    'nicht erzeugen.',
  inputSchema: z.object({}),
  surfaces: ['mcp', 'ai'],
  domain: 'notifications',
  mutating: false,
  async execute(client) {
    const result = await client.request({
      method: 'GET',
      path: '/api/me/push/devices',
      responseSchema: pushDeviceListResponseSchema,
    });

    if (!result.configured) {
      return {
        text:
          'Diese Installation verschickt keine Push-Benachrichtigungen: es ist kein ' +
          'VAPID-Schlüsselpaar konfiguriert.',
        data: result,
      };
    }
    if (result.devices.length === 0) {
      return {
        text:
          'Kein Gerät angemeldet. Im Browser unter Einstellungen → Verbindungen lässt sich das ' +
          'aktuelle Gerät anmelden.',
        data: result,
      };
    }

    const lines = result.devices.map((device) => {
      const kinds = device.kinds.length === 0 ? 'nichts' : device.kinds.join(', ');
      const last =
        device.lastDeliveredAt === null
          ? 'noch nichts zugestellt'
          : `zuletzt ${device.lastDeliveredAt}`;
      return `- ${device.label} (${device.id}, ${device.service}): ${kinds} · ${last}`;
    });
    return {
      text: `${result.devices.length} Gerät(e):\n${lines.join('\n')}`,
      data: result,
    };
  },
});

export const pushDeviceUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_push_device_update',
  description:
    'Ändert, was ein angemeldetes Gerät hören soll, oder benennt es um. "kinds" ersetzt die ' +
    'Liste vollständig; eine leere Liste lässt das Gerät angemeldet, aber still. Die möglichen ' +
    'Arten sind CALENDAR (kurz vor einem Termin), COMMENT (Kommentar an einer eigenen ' +
    'Seite oder Antwort im eigenen Gesprächsfaden) und AGENT (was exo_push_send schickt). ' +
    'Die Geräte-Kennung steht in exo_push_devices.',
  inputSchema: z.object({
    deviceId: idSchema,
    label: z.string().trim().min(1).max(120).optional(),
    kinds: z.array(pushNotificationKindSchema).optional(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'notifications',
  mutating: true,
  target: (input) => `push-device:${input.deviceId}`,
  async execute(client, input) {
    const { deviceId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/me/push/devices/${deviceId}`,
      body,
      responseSchema: z.object({
        id: idSchema,
        label: z.string(),
        kinds: z.array(pushNotificationKindSchema),
      }),
    });
    const kinds = result.kinds.length === 0 ? 'nichts mehr' : result.kinds.join(', ');
    return { text: `"${result.label}" hört jetzt auf: ${kinds}.`, data: result };
  },
});

export const pushDeviceRemoveTool: AnyToolDefinition = defineTool({
  name: 'exo_push_device_remove',
  description:
    'Meldet ein Gerät ab. Gedacht für ein Gerät, das es nicht mehr gibt: ein verlorenes Handy ' +
    'oder ein Browserprofil, das gelöscht wurde. Das Gerät selbst merkt davon nichts, es bekommt ' +
    'nur nichts mehr; anmelden kann es sich nur wieder im Browser. Willst du nur Ruhe, ist ' +
    'exo_push_device_update mit einer leeren Liste das mildere Mittel.',
  inputSchema: z.object({ deviceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'notifications',
  mutating: true,
  target: (input) => `push-device:${input.deviceId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/me/push/devices/${input.deviceId}`,
      responseSchema: removedResponseSchema,
    });
    return { text: 'Das Gerät ist abgemeldet.', data: result };
  },
});

export const pushSendTool: AnyToolDefinition = defineTool({
  name: 'exo_push_send',
  description:
    'Schickt eine Benachrichtigung auf die eigenen Geräte: ein kurzer Titel, zwei Sätze Text und ' +
    'wahlweise eine Adresse innerhalb dieser Installation, die beim Antippen aufgeht. Dafür ' +
    'gedacht, dass ein Agent von sich aus Bescheid gibt, wenn gerade niemand hinschaut: ein ' +
    'langer Lauf ist fertig, etwas ist schiefgegangen, eine Frage blockiert. Nur an die eigenen ' +
    'Geräte, nie an fremde. Die Antwort sagt, an wie viele Geräte es ging; null heißt, dass ' +
    'kein Gerät auf Agenten-Nachrichten hört, und die Nachricht ist dann niemandem aufgefallen.',
  inputSchema: sendPushRequestSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'notifications',
  mutating: true,
  target: () => 'push:self',
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: '/api/me/push/send',
      body: input,
      responseSchema: sendPushResponseSchema,
    });
    return {
      text:
        result.devices === 0
          ? 'Kein Gerät hört auf Agenten-Nachrichten, die Benachrichtigung ist nirgends angekommen. ' +
            'exo_push_devices zeigt, was angemeldet ist.'
          : `Unterwegs an ${result.devices} Gerät(e).`,
      data: result,
    };
  },
});

export const PUSH_TOOLS: readonly AnyToolDefinition[] = [
  pushDevicesTool,
  pushDeviceUpdateTool,
  pushDeviceRemoveTool,
  pushSendTool,
];
