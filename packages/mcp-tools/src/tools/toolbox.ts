import { z } from 'zod';

import { domainLabel } from '../domains.js';
import { type AnyToolDefinition, defineTool, TOOL_DOMAINS } from '../tool.js';

/**
 * The way back into the rest of the catalogue (issue #121).
 *
 * The built-in loop is offered the tools of a few domains, chosen from the
 * words of the task. That is a guess, and a guess needs a correction that
 * costs one call rather than a failed run: this names every domain that
 * exists, and opens the one that was missed. The tools of that domain are in
 * the next turn's request.
 *
 * It exists only on the `ai` surface. An MCP client is handed the whole
 * catalogue at the handshake and has nothing to open, so offering it there
 * would be a tool whose honest answer is "this does not apply to you".
 *
 * Built from the catalogue rather than importing it, so `catalog.ts` can
 * assemble this last without the two files importing each other.
 */

/** Characters of a tool's description the listing carries. The schema follows next turn. */
const MAX_DESCRIPTION_CHARS = 220;

function firstSentence(description: string): string {
  const cut = description.slice(0, MAX_DESCRIPTION_CHARS);
  return cut.length < description.length ? `${cut}…` : cut;
}

export function createToolboxTool(catalogue: readonly AnyToolDefinition[]): AnyToolDefinition {
  const listDomains = (): string =>
    TOOL_DOMAINS.map((domain) => {
      const count = catalogue.filter((tool) => tool.domain === domain).length;
      return `- ${domain} (${count}): ${domainLabel(domain)}`;
    }).join('\n');

  return defineTool({
    name: 'exo_toolbox',
    description:
      'Nennt die Werkzeugbereiche dieser Installation und schaltet einen davon frei. ' +
      'Du bekommst pro Lauf nicht den ganzen Werkzeugkatalog, sondern die Bereiche, die zur ' +
      'Aufgabe passen: Navigieren, Suchen, Lesen und das Bearbeiten von Seiten sind immer dabei. ' +
      'Fehlt dir etwas (Datenbanken, Kalender, Anhänge, Projekte, Freigaben, Automationen, ' +
      'Benachrichtigungen, Verwaltung), ruf dieses Werkzeug ohne Argument auf: es listet alle ' +
      'Bereiche. Mit domain schaltest du einen frei; seine Werkzeuge stehen dir ab dem nächsten ' +
      'Schritt zur Verfügung. Das ist keine Berechtigung, sondern nur die Auswahl dessen, was ' +
      'dir angeboten wird.',
    inputSchema: z.object({
      domain: z
        .enum(TOOL_DOMAINS)
        .optional()
        .describe('Bereich, der freigeschaltet werden soll. Ohne Angabe werden alle aufgezählt.'),
    }),
    surfaces: ['ai'],
    domain: 'core',
    mutating: false,
    execute(_client, input) {
      if (input.domain === undefined) {
        return Promise.resolve({
          text:
            'Werkzeugbereiche dieser Installation:\n\n' +
            `${listDomains()}\n\n` +
            'Ruf exo_toolbox mit domain auf, um einen davon freizuschalten.',
          data: { domains: TOOL_DOMAINS },
        });
      }

      const opened = catalogue.filter((tool) => tool.domain === input.domain);
      const lines = opened
        .map((tool) => `- ${tool.name}: ${firstSentence(tool.description)}`)
        .join('\n');
      return Promise.resolve({
        text:
          `Bereich „${input.domain}“ ist freigeschaltet (${opened.length} Werkzeuge). Ab dem ` +
          `nächsten Schritt kannst du sie aufrufen:\n\n${lines}`,
        data: { domain: input.domain, tools: opened.map((tool) => tool.name) },
      });
    },
  });
}
