import { z } from 'zod';

import {
  addProjectAssetRequestSchema,
  deleteProjectBuildResponseSchema,
  idSchema,
  type Project,
  PROJECT_MAX_TEXT_CHARS,
  projectBibliographySchema,
  type ProjectBuild,
  projectBuildArtifactsResponseSchema,
  projectBuildDiagnosticsResponseSchema,
  projectBuildListResponseSchema,
  projectBuildLogResponseSchema,
  projectBuildResponseSchema,
  projectEngineSchema,
  type ProjectFile,
  projectFileContentResponseSchema,
  projectFileListResponseSchema,
  projectListResponseSchema,
  projectMutationResponseSchema,
  projectPathSchema,
  projectResponseSchema,
  projectTypeSchema,
  startProjectBuildResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Project workspaces, whole (issue #43, ADR-027).
 *
 * The set is the loop an agent actually runs, not the buttons a person presses:
 * read the tree, read a file, change it, build, read the diagnostics, jump to
 * the file and line they name, change it again, build again, read the finished
 * PDF back. Anything missing from that chain is a loop the agent can start and
 * never close, which is the failure ADR-025 exists to prevent.
 *
 * Two things are deliberately not here. **Deleting a project** is deleting its
 * document, and `exo_page_trash` and `exo_page_delete` already do that, for all
 * three clients -- a second delete would be a second set of trash semantics.
 * **Uploading an asset's bytes** is `exo_attachment_upload`, which owns the
 * magic-byte sniff and the quota; `exo_project_add_asset` then binds the id it
 * returns to a path.
 *
 * Reading the result back is `exo_attachment_read_text` over the build's PDF.
 * That is not a workaround: the artifact is an ordinary attachment, so the PDF
 * text extraction runs over it and an agent can check what the build actually
 * printed rather than what the source said it would.
 */

/** Files listed before the answer is cut short. */
const MAX_LISTED_FILES = 200;

/** Builds shown in one listing. */
const MAX_LISTED_BUILDS = 25;

/** Diagnostics shown in one answer. The rest is in the log. */
const MAX_SHOWN_DIAGNOSTICS = 60;

function describeProject(project: Project): string {
  const ready = project.materialized ? '' : ' (wird gerade aufbereitet)';
  return [
    `${project.title} [${project.type}]${ready}`,
    `Hauptdatei: ${project.rootFile}, Engine: ${project.engine}, Literatur: ${project.bibliography}`,
    `${String(project.fileCount)} Pfade, davon ${String(project.assetCount)} Anhänge`,
    `id: ${project.id}`,
  ].join('\n');
}

function describeFile(file: ProjectFile): string {
  const kind = file.kind === 'TEXT' ? 'Text' : `Anhang ${file.mimeType ?? '?'}`;
  const broken = file.kind === 'ASSET' && file.attachmentId === null ? ' [Datei fehlt]' : '';
  return `${file.path} (${kind}, ${String(file.byteSize)} Bytes)${broken}`;
}

function describeBuild(build: ProjectBuild): string {
  const stale = build.stale ? ', VERALTET (das Projekt hat sich seitdem geändert)' : '';
  const counts =
    build.errorCount + build.warningCount === 0
      ? ''
      : `\n${String(build.errorCount)} Fehler, ${String(build.warningCount)} Warnungen (exo_project_build_diagnostics)`;
  const artifact =
    build.attachmentId === null
      ? '\nnoch kein PDF'
      : `\nPDF: attachmentId ${build.attachmentId}${build.pageCount === null ? '' : `, ${String(build.pageCount)} Seiten`}`;
  const error = build.error === null ? '' : `\nFehler: ${build.error} (${build.errorCode ?? ''})`;
  return `Bau ${build.id}: ${build.status}${stale}\nProjekt: ${build.projectTitle ?? build.projectId ?? '?'}, ${build.rootFile}, ${build.engine}${counts}${artifact}${error}`;
}

// ---------------------------------------------------------------------------
// The project itself
// ---------------------------------------------------------------------------

export const projectListTool: AnyToolDefinition = defineTool({
  name: 'exo_project_list',
  description:
    'Listet die Projekte eines Arbeitsbereichs (LaTeX und später andere Dateibaum-Typen) und ' +
    'sagt, ob hier überhaupt gebaut werden darf.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/projects`,
      responseSchema: projectListResponseSchema,
    });
    const header = result.buildEnabled
      ? 'Projekt-Bauten sind eingeschaltet.'
      : 'Projekt-Bauten sind für diesen Arbeitsbereich ABGESCHALTET. Bearbeiten geht, bauen nicht.';
    if (result.projects.length === 0) return { text: `${header}\n\nKeine Projekte.`, data: result };
    const body = result.projects.map((project) => describeProject(project)).join('\n\n');
    return { text: `${header}\n\n${body}`, data: result };
  },
});

export const projectCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_project_create',
  description:
    'Legt ein Projekt an. Ein Projekt ist eine Seite im Baum mit einem eigenen Dateibaum darin, ' +
    'keine Sammlung normaler Seiten. Mit scaffold: true (Vorgabe) entsteht eine übersetzbare ' +
    'Hauptdatei, sodass der erste Bau sofort gelingt.',
  inputSchema: z.object({
    workspaceId: idSchema,
    title: z.string().min(1).max(200),
    parentId: idSchema.nullable().default(null).describe('Elternseite im Baum, null für oben'),
    type: projectTypeSchema.default('LATEX'),
    engine: projectEngineSchema.default('PDFLATEX'),
    bibliography: projectBibliographySchema
      .default('AUTO')
      .describe('AUTO lässt latexmk entscheiden und ist fast immer richtig'),
    rootFile: projectPathSchema.default('main.tex'),
    scaffold: z.boolean().default(true),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/projects`,
      body,
      responseSchema: projectResponseSchema,
    });
    return { text: `Projekt angelegt.\n${describeProject(result.project)}`, data: result };
  },
});

export const projectReadTool: AnyToolDefinition = defineTool({
  name: 'exo_project_read',
  description:
    'Liest die Einstellungen eines Projekts: Hauptdatei, Engine, Literaturmodus und wie viele ' +
    'Pfade es hält. Für den Dateibaum selbst exo_project_list_files.',
  inputSchema: z.object({ projectId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/projects/${input.projectId}`,
      responseSchema: projectResponseSchema,
    });
    return { text: describeProject(result.project), data: result };
  },
});

export const projectUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_project_update',
  description:
    'Ändert Titel, Hauptdatei, Engine oder Literaturmodus eines Projekts. Nur die angegebenen ' +
    'Felder werden angefasst. Eine Hauptdatei, die es im Projekt nicht gibt, wird abgelehnt.',
  inputSchema: z.object({
    projectId: idSchema,
    title: z.string().min(1).max(200).optional(),
    rootFile: projectPathSchema.optional(),
    engine: projectEngineSchema.optional(),
    bibliography: projectBibliographySchema.optional(),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `project:${input.projectId}`,
  async execute(client, input) {
    const { projectId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/projects/${projectId}`,
      body,
      responseSchema: projectResponseSchema,
    });
    return { text: `Projekt geändert.\n${describeProject(result.project)}`, data: result };
  },
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const projectListFilesTool: AnyToolDefinition = defineTool({
  name: 'exo_project_list_files',
  description:
    'Der Dateibaum eines Projekts: jeder Pfad mit Art und Größe. Ordner sind keine eigenen ' +
    'Einträge, sie sind das Präfix der Pfade darunter.',
  inputSchema: z.object({ projectId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/projects/${input.projectId}/files`,
      responseSchema: projectFileListResponseSchema,
    });
    if (result.files.length === 0) return { text: 'Das Projekt ist leer.', data: result };
    const shown = result.files.slice(0, MAX_LISTED_FILES);
    const rest =
      result.files.length > shown.length
        ? `\n… und ${String(result.files.length - shown.length)} weitere`
        : '';
    const stale = result.stale ? '\n(Der Baum wird gerade neu aufbereitet.)' : '';
    return {
      text: `${shown.map((file) => describeFile(file)).join('\n')}${rest}${stale}`,
      data: result,
    };
  },
});

export const projectReadFileTool: AnyToolDefinition = defineTool({
  name: 'exo_project_read_file',
  description:
    'Liest eine Textdatei aus dem Projekt vollständig. Für einen Anhang kommt kein Inhalt zurück, ' +
    'sondern der Pfad zum Herunterladen; dessen Text liest exo_attachment_read_text.',
  inputSchema: z.object({ projectId: idSchema, path: projectPathSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/projects/${input.projectId}/file?path=${encodeURIComponent(input.path)}`,
      responseSchema: projectFileContentResponseSchema,
    });
    if (result.kind === 'ASSET') {
      return {
        text: `${result.path} ist ein Anhang (${String(result.byteSize)} Bytes). Download: ${result.downloadPath ?? '(Datei fehlt)'}`,
        data: result,
      };
    }
    return { text: result.content ?? '', data: result };
  },
});

export const projectWriteFileTool: AnyToolDefinition = defineTool({
  name: 'exo_project_write_file',
  description:
    'Schreibt eine Textdatei im Projekt, neu oder überschreibend. Mit createOnly: true wird eine ' +
    'schon vorhandene Datei abgelehnt statt überschrieben. Für eine kleine Änderung an einer ' +
    'großen Datei ist exo_project_patch_file richtig: das Überschreiben verwirft, was jemand ' +
    'anderes in der Zwischenzeit getippt hat.',
  inputSchema: z.object({
    projectId: idSchema,
    path: projectPathSchema,
    content: z.string().max(PROJECT_MAX_TEXT_CHARS),
    createOnly: z.boolean().default(false),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  // Overwriting a file discards what was in it, the way `exo_page_write` does.
  // Not irreversible: a project's document takes the same session snapshots a
  // page does, so the previous text is still reachable.
  destructive: true,
  target: (input) => `project:${input.projectId}:${input.path}`,
  async execute(client, input) {
    const { projectId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/projects/${projectId}/files`,
      body,
      responseSchema: projectMutationResponseSchema,
    });
    return { text: `Geschrieben: ${result.paths.join(', ')}`, data: result };
  },
});

export const projectPatchFileTool: AnyToolDefinition = defineTool({
  name: 'exo_project_patch_file',
  description:
    'Ersetzt einen genau benannten Textausschnitt in einer Projektdatei. oldText muss genau ' +
    'einmal vorkommen, sonst passiert nichts und der Aufruf sagt, woran es lag: das ist Absicht, ' +
    'denn die falsche von drei gleichen Zeilen zu ändern erzeugt ein PDF, das gelingt und falsch ' +
    'ist. Mit replaceAll: true werden alle Vorkommen ersetzt.',
  inputSchema: z.object({
    projectId: idSchema,
    path: projectPathSchema,
    oldText: z.string().min(1).max(PROJECT_MAX_TEXT_CHARS),
    newText: z.string().max(PROJECT_MAX_TEXT_CHARS),
    replaceAll: z.boolean().default(false),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `project:${input.projectId}:${input.path}`,
  async execute(client, input) {
    const { projectId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/projects/${projectId}/files/patch`,
      body,
      responseSchema: projectMutationResponseSchema,
    });
    return { text: `Geändert: ${result.paths.join(', ')}`, data: result };
  },
});

export const projectMoveFileTool: AnyToolDefinition = defineTool({
  name: 'exo_project_move_file',
  description:
    'Verschiebt oder benennt einen Pfad um. Mit recursive: true wandert der ganze Ordner mit, ' +
    'also jeder Pfad, der mit diesem Präfix beginnt. Ist die Hauptdatei betroffen, zieht die ' +
    'Projekteinstellung mit um.',
  inputSchema: z.object({
    projectId: idSchema,
    from: projectPathSchema,
    to: projectPathSchema,
    recursive: z.boolean().default(false),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  // A path is an address: `\\input{kapitel/intro}` stops resolving the moment
  // the file moves, which is the same reason `exo_page_rename` is destructive.
  destructive: true,
  target: (input) => `project:${input.projectId}:${input.from}`,
  async execute(client, input) {
    const { projectId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/projects/${projectId}/files/move`,
      body,
      responseSchema: projectMutationResponseSchema,
    });
    return { text: `Verschoben nach: ${result.paths.join(', ')}`, data: result };
  },
});

export const projectDeleteFileTool: AnyToolDefinition = defineTool({
  name: 'exo_project_delete_file',
  description:
    'Entfernt einen Pfad aus dem Projekt. Mit recursive: true den ganzen Ordner. Der Inhalt einer ' +
    'Textdatei ist danach nur noch über einen Schnappschuss der Projektseite zu bekommen.',
  inputSchema: z.object({
    projectId: idSchema,
    path: projectPathSchema,
    recursive: z.boolean().default(false),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  target: (input) => `project:${input.projectId}:${input.path}`,
  async execute(client, input) {
    const { projectId, ...body } = input;
    const result = await client.request({
      method: 'DELETE',
      path: `/api/projects/${projectId}/files`,
      body,
      responseSchema: projectMutationResponseSchema,
    });
    return { text: `Entfernt: ${result.paths.join(', ')}`, data: result };
  },
});

export const projectAddAssetTool: AnyToolDefinition = defineTool({
  name: 'exo_project_add_asset',
  description:
    'Hängt eine schon hochgeladene Datei (Bild, Schrift, PDF) an einen Pfad im Projekt. Die Bytes ' +
    'kommen vorher mit exo_attachment_upload in den Arbeitsbereich; hier wird nur die id an den ' +
    'Pfad gebunden, unter dem LaTeX sie dann findet.',
  inputSchema: addProjectAssetRequestSchema.extend({ projectId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `project:${input.projectId}:${input.path}`,
  async execute(client, input) {
    const { projectId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/projects/${projectId}/assets`,
      body,
      responseSchema: projectMutationResponseSchema,
    });
    return { text: `Anhang eingebunden: ${result.paths.join(', ')}`, data: result };
  },
});

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

export const projectBuildTool: AnyToolDefinition = defineTool({
  name: 'exo_project_build',
  description:
    'Startet einen Bau des Projekts. Läuft im Hintergrund; der Zustand kommt aus ' +
    'exo_project_build_status. Ein unverändertes Projekt bekommt das vorhandene PDF zurück, ' +
    'statt es noch einmal zu bauen (force: true baut trotzdem). Engine, Hauptdatei und ' +
    'Literaturmodus lassen sich hier für einen einzelnen Bau überschreiben.',
  inputSchema: z.object({
    projectId: idSchema,
    rootFile: projectPathSchema.optional(),
    engine: projectEngineSchema.optional(),
    bibliography: projectBibliographySchema.optional(),
    force: z.boolean().default(false),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `project:${input.projectId}`,
  async execute(client, input) {
    const { projectId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/projects/${projectId}/builds`,
      body,
      responseSchema: startProjectBuildResponseSchema,
    });
    const header = result.reused
      ? 'Unverändert; der vorhandene Bau wird zurückgegeben.'
      : 'Bau eingereiht.';
    return { text: `${header}\n${describeBuild(result.build)}`, data: result };
  },
});

export const projectBuildStatusTool: AnyToolDefinition = defineTool({
  name: 'exo_project_build_status',
  description:
    'Der Zustand eines Baus: PENDING, RUNNING, COMPLETED, FAILED oder CANCELLED, mit der Zahl der ' +
    'Fehler und Warnungen und der Anhang-id des PDFs, sobald es eines gibt.',
  inputSchema: z.object({ buildId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/project-builds/${input.buildId}`,
      responseSchema: projectBuildResponseSchema,
    });
    return { text: describeBuild(result.build), data: result };
  },
});

export const projectBuildsTool: AnyToolDefinition = defineTool({
  name: 'exo_project_builds',
  description:
    'Listet die letzten Bauten eines Arbeitsbereichs, wahlweise auf ein Projekt eingeschränkt.',
  inputSchema: z.object({ workspaceId: idSchema, projectId: idSchema.optional() }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const query = input.projectId === undefined ? '' : `?projectId=${input.projectId}`;
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/projects/builds${query}`,
      responseSchema: projectBuildListResponseSchema,
    });
    if (result.builds.length === 0) return { text: 'Noch keine Bauten.', data: result };
    const body = result.builds
      .slice(0, MAX_LISTED_BUILDS)
      .map((build) => describeBuild(build))
      .join('\n\n');
    return { text: body, data: result };
  },
});

export const projectBuildDiagnosticsTool: AnyToolDefinition = defineTool({
  name: 'exo_project_build_diagnostics',
  description:
    'Die Fehler und Warnungen eines Baus als Liste mit Datei und Zeile: das, womit sich ein Fehler ' +
    'gezielt reparieren lässt. Wo LaTeX keine Datei genannt hat, steht keine, statt eine geraten ' +
    'zu werden. Für den ganzen Rest exo_project_build_log.',
  inputSchema: z.object({ buildId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/project-builds/${input.buildId}/diagnostics`,
      responseSchema: projectBuildDiagnosticsResponseSchema,
    });
    if (result.diagnostics.length === 0) {
      return { text: `Bau ${result.status}: keine Fehler oder Warnungen.`, data: result };
    }
    const body = result.diagnostics
      .slice(0, MAX_SHOWN_DIAGNOSTICS)
      .map((entry) => {
        const where =
          entry.file === null
            ? entry.line === null
              ? ''
              : ` (Zeile ${String(entry.line)})`
            : ` ${entry.file}:${String(entry.line ?? 0)}`;
        return `[${entry.severity}]${where} ${entry.message}`;
      })
      .join('\n');
    return { text: `Bau ${result.status}\n${body}`, data: result };
  },
});

export const projectBuildLogTool: AnyToolDefinition = defineTool({
  name: 'exo_project_build_log',
  description:
    'Das vollständige Protokoll eines Baus: erst das TeX-Log, dann die Ausgabe von latexmk. Lang. ' +
    'Der erste Griff ist exo_project_build_diagnostics; hierher führt der Weg, wenn dort nichts ' +
    'steht, was den Fehlschlag erklärt.',
  inputSchema: z.object({ buildId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/project-builds/${input.buildId}/log`,
      responseSchema: projectBuildLogResponseSchema,
    });
    const note = result.truncated ? '\n\n(Protokoll gekürzt; der Anfang fehlt.)' : '';
    return { text: `Bau ${result.status}\n\n${result.log}${note}`, data: result };
  },
});

export const projectBuildArtifactsTool: AnyToolDefinition = defineTool({
  name: 'exo_project_build_artifacts',
  description:
    'Was ein Bau erzeugt hat: das PDF und die SyncTeX-Karte, beide als normale Anhänge. Mit der ' +
    'attachmentId des PDFs liest exo_attachment_read_text nach, was tatsächlich auf dem Papier ' +
    'steht: der Weg, ein sichtbares Ergebnis zu prüfen, ohne es anzusehen.',
  inputSchema: z.object({ buildId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/project-builds/${input.buildId}/artifacts`,
      responseSchema: projectBuildArtifactsResponseSchema,
    });
    if (result.pdf === null) {
      return { text: `Bau ${result.status}: kein PDF vorhanden.`, data: result };
    }
    const stale = result.stale ? ' (VERALTET)' : '';
    const pages = result.pdf.pageCount === null ? '' : `, ${String(result.pdf.pageCount)} Seiten`;
    const map =
      result.sourceMap === null ? '' : `\nSyncTeX: attachmentId ${result.sourceMap.attachmentId}`;
    return {
      text:
        `PDF${stale}: ${result.pdf.filename} (attachmentId: ${result.pdf.attachmentId}${pages})\n` +
        `Text-Extraktion: ${result.pdf.textStatus}, danach mit exo_attachment_read_text lesbar\n` +
        `Download: ${result.pdf.downloadPath}${map}`,
      data: result,
    };
  },
});

export const projectBuildCancelTool: AnyToolDefinition = defineTool({
  name: 'exo_project_build_cancel',
  description:
    'Bricht einen laufenden oder wartenden Bau ab. Ein abgeschlossener Bau lässt sich nicht mehr ' +
    'abbrechen.',
  inputSchema: z.object({ buildId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `project-build:${input.buildId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/project-builds/${input.buildId}/cancel`,
      responseSchema: projectBuildResponseSchema,
    });
    return { text: `Abbruch angefordert.\n${describeBuild(result.build)}`, data: result };
  },
});

export const projectBuildDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_project_build_delete',
  description:
    'Löscht einen abgeschlossenen Bau samt PDF und SyncTeX-Datei. Ein laufender Bau muss erst ' +
    'mit exo_project_build_cancel abgebrochen werden. Die Quellen bleiben unberührt: derselbe ' +
    'Bau lässt sich mit exo_project_build erneut anfordern.',
  inputSchema: z.object({ buildId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  target: (input) => `project-build:${input.buildId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/project-builds/${input.buildId}`,
      responseSchema: deleteProjectBuildResponseSchema,
    });
    return { text: 'Bau, PDF und SyncTeX-Datei gelöscht.', data: result };
  },
});

export const PROJECT_TOOLS: readonly AnyToolDefinition[] = [
  projectListTool,
  projectCreateTool,
  projectReadTool,
  projectUpdateTool,
  projectListFilesTool,
  projectReadFileTool,
  projectWriteFileTool,
  projectPatchFileTool,
  projectMoveFileTool,
  projectDeleteFileTool,
  projectAddAssetTool,
  projectBuildTool,
  projectBuildStatusTool,
  projectBuildsTool,
  projectBuildDiagnosticsTool,
  projectBuildLogTool,
  projectBuildArtifactsTool,
  projectBuildCancelTool,
  projectBuildDeleteTool,
];
