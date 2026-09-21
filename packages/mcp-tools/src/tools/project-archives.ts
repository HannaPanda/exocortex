import { z } from 'zod';

import {
  exportProjectResponseSchema,
  idSchema,
  importProjectRequestSchema,
  importProjectResponseSchema,
  projectImportSkipMessage,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Getting a project in and out as a `.zip` (issue #54).
 *
 * Beside the project tools rather than among them, because the shape is
 * different: everything there is one path and one operation, and these two are
 * the whole tree at once. The bytes travel as an attachment in both directions,
 * the way `exo_project_add_asset` has them travel -- so an agent names a file it
 * already put in the workspace instead of pushing megabytes through a call.
 */

/** Skipped entries listed before the rest is counted. */
const MAX_LISTED_SKIPS = 200;

export const projectImportTool: AnyToolDefinition = defineTool({
  name: 'exo_project_import',
  description:
    'Liest ein ZIP-Archiv in ein Projekt: Textdateien kommen in den Dateibaum, alles andere wird ' +
    'als Anhang eingebunden. Das Archiv kommt vorher mit exo_attachment_upload in den ' +
    'Arbeitsbereich; hier wird nur seine id genannt. Vorhandene Dateien bleiben stehen, bis ' +
    'overwrite: true gesetzt ist, und die Antwort nennt jeden Eintrag, der nicht hineinkam, mit ' +
    'dem Grund. Ein einzelner gemeinsamer Oberordner im Archiv fällt weg, damit die Pfade dort ' +
    'landen, wo die \\input-Zeilen sie suchen.',
  inputSchema: importProjectRequestSchema.extend({ projectId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'projects',
  mutating: true,
  // With `overwrite` it replaces files. The project's document takes the same
  // snapshots a page does, so the previous text stays reachable.
  destructive: true,
  target: (input) => `project:${input.projectId}`,
  async execute(client, input) {
    const { projectId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/projects/${projectId}/import`,
      body,
      responseSchema: importProjectResponseSchema,
    });
    const root =
      result.strippedRoot === null ? '' : `\nOberordner "${result.strippedRoot}" weggelassen.`;
    const rootFile = result.rootFileChanged
      ? `\nHauptdatei ist jetzt ${result.rootFile}.`
      : `\nHauptdatei bleibt ${result.rootFile}.`;
    const skipped =
      result.skipped.length === 0
        ? ''
        : `\n\nNicht übernommen:\n${result.skipped
            .slice(0, MAX_LISTED_SKIPS)
            .map((entry) => `${entry.name}: ${projectImportSkipMessage(entry.reason)}`)
            .join('\n')}`;
    return {
      text: `${String(result.imported.length)} Dateien übernommen.${root}${rootFile}${skipped}`,
      data: result,
    };
  },
});

export const projectExportTool: AnyToolDefinition = defineTool({
  name: 'exo_project_export',
  description:
    'Packt das ganze Projekt als ZIP-Archiv und legt es als Anhang im Arbeitsbereich ab. ' +
    'Gebaute PDFs sind nicht darin: die sind abgeleitet und hängen am jeweiligen Bau. Der ' +
    'Rückgabewert nennt attachmentId und Downloadpfad; der Anhang lässt sich wie jeder andere ' +
    'wieder löschen.',
  inputSchema: z.object({ projectId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'projects',
  mutating: true,
  target: (input) => `project:${input.projectId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/projects/${input.projectId}/export`,
      responseSchema: exportProjectResponseSchema,
    });
    const stale = result.stale
      ? '\n(Der Dateibaum wurde gerade noch aufbereitet; das Archiv kann eine Sekunde alt sein.)'
      : '';
    return {
      text:
        `${result.filename}: ${String(result.fileCount)} Dateien, ${String(result.byteSize)} Bytes.\n` +
        `attachmentId ${result.attachmentId}, Download: ${result.downloadPath}${stale}`,
      data: result,
    };
  },
});

export const PROJECT_ARCHIVE_TOOLS: readonly AnyToolDefinition[] = [
  projectImportTool,
  projectExportTool,
];
