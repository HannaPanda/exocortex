import { z } from 'zod';

import {
  idSchema,
  projectPathSchema,
  projectPositionLookupResponseSchema,
  projectSourceLookupResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * The SyncTeX map of a build, as two questions (issue #53, ADR-027).
 *
 * Separate from the rest of the project tools because it is a separate kind of
 * thing: everything in `projects.ts` is about the files and the builds, and
 * these two are about the correspondence between a place in the source and a
 * place on paper. They exist for the reason ADR-025 gives -- the browser's
 * viewer reaches this through the same two routes, so an agent asking "where
 * does page 17 come from" is asking exactly what a click asks.
 */

/** Rectangles spelled out in a forward lookup. The rest stays in `data`. */
const MAX_SHOWN_AREAS = 12;

export const projectBuildSourceAtTool: AnyToolDefinition = defineTool({
  name: 'exo_project_build_source_at',
  description:
    'Rückwärts-SyncTeX: welche Quellzeile hat eine bestimmte Stelle im gebauten PDF erzeugt? ' +
    'page ist die Seitenzahl, x und y sind PDF-Punkte von der linken oberen Ecke der Seite ' +
    '(72 Punkte = 1 Zoll). Die Antwort nennt Datei und Zeile im Projekt; kam die Stelle aus ' +
    'einer Klassen- oder Paketdatei, ist file leer und inputPath sagt, woher.',
  inputSchema: z.object({
    buildId: idSchema,
    page: z.number().int().positive(),
    x: z.number(),
    y: z.number(),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path:
        `/api/project-builds/${input.buildId}/source-map/source` +
        `?page=${String(input.page)}&x=${String(input.x)}&y=${String(input.y)}`,
      responseSchema: projectSourceLookupResponseSchema,
    });
    const where = result.file ?? `${result.inputPath} (nicht im Projekt)`;
    return { text: `Seite ${String(input.page)} → ${where}:${String(result.line)}`, data: result };
  },
});

export const projectBuildPositionOfTool: AnyToolDefinition = defineTool({
  name: 'exo_project_build_position_of',
  description:
    'Vorwärts-SyncTeX: wo im gebauten PDF steht eine bestimmte Quellzeile? Antwortet mit ' +
    'Rechtecken in PDF-Punkten von der linken oberen Ecke der Seite. Zeilen, die nichts drucken ' +
    '(Kommentare, \\usepackage), haben keine eigene Stelle; dann antwortet line mit der ' +
    'nächsten Zeile, die etwas erzeugt hat.',
  inputSchema: z.object({
    buildId: idSchema,
    file: projectPathSchema,
    line: z.number().int().positive(),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path:
        `/api/project-builds/${input.buildId}/source-map/position` +
        `?file=${encodeURIComponent(input.file)}&line=${String(input.line)}`,
      responseSchema: projectPositionLookupResponseSchema,
    });
    const moved =
      result.line === result.requestedLine
        ? ''
        : ` (Zeile ${String(result.requestedLine)} druckt nichts)`;
    const pages = [...new Set(result.areas.map((area) => area.page))];
    const body = result.areas
      .slice(0, MAX_SHOWN_AREAS)
      .map(
        (area) =>
          `Seite ${String(area.page)}: ${area.left.toFixed(1)},${area.top.toFixed(1)} ` +
          `${area.width.toFixed(1)}×${area.height.toFixed(1)}`,
      )
      .join('\n');
    return {
      text: `${result.file}:${String(result.line)}${moved} steht auf Seite ${pages.join(', ')}\n${body}`,
      data: result,
    };
  },
});
