import { z } from 'zod';

import {
  deleteRenderJobResponseSchema,
  deleteRenderTemplateResponseSchema,
  idSchema,
  RENDER_MAX_TEMPLATE_CHARS,
  RENDER_MAX_VARIABLES,
  renderArtifactResponseSchema,
  rendererSchema,
  type RenderJob,
  renderJobListResponseSchema,
  renderJobLogResponseSchema,
  renderJobResponseSchema,
  renderSourceSchema,
  type RenderTemplate,
  renderTemplateListResponseSchema,
  renderTemplateResponseSchema,
  renderVariableSchema,
  startRenderResponseSchema,
} from '@exocortex/contracts';

import { renderMarkdownTable } from '../format.js';
import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * Publishing a page as a file (issue #44, ADR-026).
 *
 * The set is the whole loop and not only the button: create or pick a template,
 * start a build, read its status, read the log when it failed, fix the template,
 * build again, fetch the file. An agent handed only `exo_render_start` would be
 * able to begin something it could never finish (ADR-025), and the log is the
 * one place a broken LaTeX template explains itself.
 *
 * The artifact is an ordinary attachment, which is the other half of the answer
 * to "how does a machine inspect a visual result": the text extraction runs over
 * it like over any other PDF, so `exo_attachment_read_text` reads back what the
 * build actually produced.
 */

/** Jobs shown in one listing. */
const MAX_LISTED_JOBS = 25;

function describeTemplate(template: RenderTemplate): string {
  const variables =
    template.variables.length === 0
      ? 'keine Variablen'
      : `Variablen: ${template.variables.map((variable) => variable.name).join(', ')}`;
  const source = template.source === null ? 'eingebaute Vorlage (Eisvogel)' : 'eigene Vorlage';
  return `${template.name} [${template.renderer}] ${source}, ${variables} (id: ${template.id})`;
}

function describeJob(job: RenderJob): string {
  const artifact =
    job.attachmentId === null
      ? 'noch keine Datei'
      : `Datei: ${job.attachmentFilename ?? '?'} (attachmentId: ${job.attachmentId})`;
  const stale = job.stale ? ', VERALTET (Seite oder Vorlage haben sich geändert)' : '';
  const error = job.error === null ? '' : `\nFehler: ${job.error} (${job.errorCode ?? ''})`;
  return `Bau ${job.id}: ${job.status}${stale}\nSeite: ${job.documentTitle ?? job.documentId ?? '?'}, Vorlage: ${job.templateName ?? '(gelöscht)'}, Quelle: ${job.source}\n${artifact}${error}`;
}

const templateBodyShape = {
  name: z.string().min(1).max(200).describe('Name der Vorlage, für Menschen'),
  description: z.string().max(1_000).default(''),
  renderer: rendererSchema.default('LATEX_PDF'),
  source: z
    .string()
    .max(RENDER_MAX_TEMPLATE_CHARS)
    .nullable()
    .default(null)
    .describe(
      'Die Pandoc-Vorlage in Pandocs eigener Syntax ($title$, $body$, $for(...)$). null bedeutet: ' +
        'die eingebaute Vorlage Eisvogel benutzen, die ohne eine Zeile LaTeX auskommt.',
    ),
  variables: z
    .array(renderVariableSchema)
    .max(RENDER_MAX_VARIABLES)
    .default([])
    .describe(
      'Was die Vorlage an Werten erwartet. origin sagt, woher der Wert kommt, wenn ihn niemand ' +
        'eintippt: TITLE, PATH, AUTHOR, TODAY, PROPERTY (dann property setzen) oder MANUAL.',
    ),
};

export const renderTemplateListTool: AnyToolDefinition = defineTool({
  name: 'exo_render_template_list',
  description:
    'Listet die Vorlagen, mit denen sich Seiten dieses Arbeitsbereichs als PDF veröffentlichen ' +
    'lassen, und sagt, ob die PDF-Ausgabe hier überhaupt eingeschaltet ist.',
  inputSchema: z.object({ workspaceId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/render/templates`,
      responseSchema: renderTemplateListResponseSchema,
    });
    const header = result.enabledForWorkspace
      ? 'PDF-Ausgabe ist eingeschaltet.'
      : 'PDF-Ausgabe ist für diesen Arbeitsbereich ABGESCHALTET. Kein Bau startet.';
    if (result.templates.length === 0) {
      return { text: `${header}\n\nKeine Vorlagen.`, data: result };
    }
    const body = result.templates
      .map((template, index) => `${index + 1}. ${describeTemplate(template)}`)
      .join('\n');
    return { text: `${header}\n\n${body}`, data: result };
  },
});

export const renderTemplateReadTool: AnyToolDefinition = defineTool({
  name: 'exo_render_template_read',
  description:
    'Liest eine Vorlage samt ihrem vollständigen Quelltext. Der Weg, eine Vorlage zu ändern, ohne ' +
    'sie vorher raten zu müssen.',
  inputSchema: z.object({ templateId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/render/templates/${input.templateId}`,
      responseSchema: renderTemplateResponseSchema,
    });
    const source =
      result.template.source === null
        ? '(eingebaute Vorlage Eisvogel)'
        : `\n\n\`\`\`latex\n${result.template.source}\n\`\`\``;
    return { text: `${describeTemplate(result.template)}${source}`, data: result };
  },
});

export const renderTemplateCreateTool: AnyToolDefinition = defineTool({
  name: 'exo_render_template_create',
  description:
    'Legt eine Vorlage an. Ohne eigenen Quelltext (source: null) wird die eingebaute Vorlage ' +
    'Eisvogel benutzt, die für technische Dokumentation und Berichte gedacht ist. Braucht die ' +
    'ADMIN-Rolle im Arbeitsbereich: eine Vorlage ist der Briefkopf aller, die damit bauen.',
  inputSchema: z.object({ workspaceId: idSchema, ...templateBodyShape }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/render/templates`,
      body,
      responseSchema: renderTemplateResponseSchema,
    });
    return { text: `Vorlage angelegt: ${describeTemplate(result.template)}`, data: result };
  },
});

export const renderTemplateUpdateTool: AnyToolDefinition = defineTool({
  name: 'exo_render_template_update',
  description:
    'Ändert eine Vorlage. Nur die angegebenen Felder werden angefasst. Ab dann sehen alle Seiten, ' +
    'die mit dieser Vorlage gebaut werden, anders aus; bereits erzeugte PDFs bleiben, gelten aber ' +
    'als veraltet.',
  inputSchema: z
    .object({ templateId: idSchema })
    .extend(z.object(templateBodyShape).partial().shape),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `render-template:${input.templateId}`,
  async execute(client, input) {
    const { templateId, ...body } = input;
    const result = await client.request({
      method: 'PATCH',
      path: `/api/render/templates/${templateId}`,
      body,
      responseSchema: renderTemplateResponseSchema,
    });
    return { text: `Vorlage geändert: ${describeTemplate(result.template)}`, data: result };
  },
});

export const renderTemplateDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_render_template_delete',
  description:
    'Löscht eine Vorlage. Die damit erzeugten PDFs bleiben als Anhänge erhalten, und die Bauten ' +
    'behalten den Namen der Vorlage, damit später noch nachvollziehbar ist, woraus ein PDF ' +
    'entstanden ist. Neu bauen lässt sich damit dann nichts mehr.',
  inputSchema: z.object({ templateId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `render-template:${input.templateId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/render/templates/${input.templateId}`,
      responseSchema: deleteRenderTemplateResponseSchema,
    });
    return { text: 'Vorlage gelöscht.', data: result };
  },
});

export const renderStartTool: AnyToolDefinition = defineTool({
  name: 'exo_render_start',
  description:
    'Baut aus einer bestehenden Seite ein PDF: Markdown → Pandoc → Vorlage → LaTeX → PDF, in einem ' +
    'Container im Hintergrund. Der Seiteninhalt wird dabei nicht angefasst. Antwortet sofort mit ' +
    'dem eingereihten Bau; der Stand kommt aus exo_render_status. Wurde genau diese Seite mit ' +
    'genau dieser Vorlage und denselben Werten schon gebaut, kommt das vorhandene PDF zurück ' +
    '(reused: true) statt eines zweiten Laufs.',
  inputSchema: z.object({
    documentId: idSchema.describe('Die Seite, die gebaut werden soll.'),
    templateId: idSchema,
    source: renderSourceSchema
      .default('DOCUMENT')
      .describe(
        'DOCUMENT ist die Seite allein. SUBTREE nimmt die Unterseiten mit, jede eine Ebene tiefer, ' +
          'und legt ein Inhaltsverzeichnis an.',
      ),
    variables: z
      .record(z.string(), z.string().max(2_000))
      .default({})
      .describe('Werte für die Variablen der Vorlage. Was fehlt, wird aus der Seite abgeleitet.'),
    force: z
      .boolean()
      .default(false)
      .describe('Neu bauen, auch wenn ein identisches PDF schon existiert.'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  // It really does act: a container starts and a file is written into the
  // workspace. Cheap, but not a read.
  target: (input) => `page:${input.documentId}`,
  async execute(client, input) {
    const { documentId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/render`,
      body,
      responseSchema: startRenderResponseSchema,
    });
    const prefix = result.reused
      ? 'Unverändert seit dem letzten Bau, vorhandenes PDF:'
      : 'Bau eingereiht:';
    return { text: `${prefix}\n${describeJob(result.job)}`, data: result };
  },
});

export const renderStatusTool: AnyToolDefinition = defineTool({
  name: 'exo_render_status',
  description:
    'Sagt, wie weit ein Bau ist: PENDING, RUNNING, COMPLETED, FAILED oder CANCELLED, dazu die ' +
    'erzeugte Datei, der Grund eines Fehlschlags und ob das Ergebnis inzwischen veraltet ist. ' +
    'Bei FAILED steht die ausführliche Begründung in exo_render_log.',
  inputSchema: z.object({ jobId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/render/jobs/${input.jobId}`,
      responseSchema: renderJobResponseSchema,
    });
    const tail =
      result.job.logTail === null
        ? ''
        : `\n\nLetzte Zeilen:\n\`\`\`\n${result.job.logTail}\n\`\`\``;
    return { text: `${describeJob(result.job)}${tail}`, data: result };
  },
});

export const renderJobsTool: AnyToolDefinition = defineTool({
  name: 'exo_render_jobs',
  description:
    'Listet die letzten Bauten eines Arbeitsbereichs, wahlweise nur die einer Seite. Der Weg ' +
    'herauszufinden, ob eine Seite überhaupt schon einmal als PDF veröffentlicht wurde.',
  inputSchema: z.object({
    workspaceId: idSchema,
    documentId: idSchema.optional().describe('Nur die Bauten dieser einen Seite.'),
  }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/render/jobs`,
      query: { documentId: input.documentId },
      responseSchema: renderJobListResponseSchema,
    });
    if (result.jobs.length === 0) {
      return { text: 'Keine Bauten aufgezeichnet.', data: result };
    }
    const text = renderMarkdownTable(
      ['Zeitpunkt', 'Seite', 'Vorlage', 'Quelle', 'Status', 'Dauer', 'Datei', 'id'],
      result.jobs
        .slice(0, MAX_LISTED_JOBS)
        .map((job) => [
          job.createdAt,
          job.documentTitle ?? '(gelöscht)',
          job.templateName ?? '(gelöscht)',
          job.source,
          job.stale ? `${job.status} (veraltet)` : job.status,
          job.durationMs === null ? '' : `${String(job.durationMs)} ms`,
          job.attachmentId ?? '',
          job.id,
        ]),
    );
    return { text, data: result };
  },
});

export const renderLogTool: AnyToolDefinition = defineTool({
  name: 'exo_render_log',
  description:
    'Das vollständige Bau-Protokoll: was Pandoc und LaTeX gesagt haben. Die einzige Stelle, an der ' +
    'eine kaputte Vorlage erklärt, was ihr fehlt (fehlendes Paket, Syntaxfehler, nicht gefundene ' +
    'Datei). Nach einem FAILED zuerst hier nachsehen, dann die Vorlage ändern und neu bauen.',
  inputSchema: z.object({ jobId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/render/jobs/${input.jobId}/log`,
      responseSchema: renderJobLogResponseSchema,
    });
    if (result.log.length === 0) {
      return { text: `Bau ${result.jobId} [${result.status}]: kein Protokoll.`, data: result };
    }
    const note = result.truncated ? '\n(Anfang abgeschnitten.)' : '';
    return {
      text: `Bau ${result.jobId} [${result.status}]:${note}\n\n\`\`\`\n${result.log}\n\`\`\``,
      data: result,
    };
  },
});

export const renderArtifactTool: AnyToolDefinition = defineTool({
  name: 'exo_render_artifact',
  description:
    'Wo die fertige Datei liegt: Anhang-Id, Dateiname, Größe und Downloadpfad. Das PDF ist ein ' +
    'ganz normaler Anhang der Seite, deshalb lässt sich sein Text mit exo_attachment_read_text ' +
    'lesen. Genau so prüft eine Maschine nach, was der Bau wirklich produziert hat, statt es ' +
    'anzunehmen.',
  inputSchema: z.object({ jobId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/render/jobs/${input.jobId}/artifact`,
      responseSchema: renderArtifactResponseSchema,
    });
    const text = [
      `Datei: ${result.filename} (${String(result.byteSize)} Bytes)`,
      `attachmentId: ${result.attachmentId}`,
      `Download: ${result.downloadPath}`,
      result.stale ? 'Achtung: Seite oder Vorlage haben sich seitdem geändert.' : '',
      `Textauszug: ${result.textStatus}`,
    ]
      .filter((line) => line.length > 0)
      .join('\n');
    return { text, data: result };
  },
});

export const renderCancelTool: AnyToolDefinition = defineTool({
  name: 'exo_render_cancel',
  description:
    'Bricht einen laufenden oder wartenden Bau ab. Der Container wird beendet; ein bereits ' +
    'fertiges PDF bleibt unberührt.',
  inputSchema: z.object({ jobId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `render-job:${input.jobId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/render/jobs/${input.jobId}/cancel`,
      responseSchema: renderJobResponseSchema,
    });
    return { text: `Abbruch angefordert.\n${describeJob(result.job)}`, data: result };
  },
});

export const renderDeleteTool: AnyToolDefinition = defineTool({
  name: 'exo_render_delete',
  description:
    'Löscht einen abgeschlossenen Bau samt dem PDF, das er erzeugt hat. Ein laufender Bau muss ' +
    'erst mit exo_render_cancel abgebrochen werden. Rückgängig macht das nichts, aber die ' +
    'Eingaben sind unverändert: derselbe Bau lässt sich mit exo_render_start erneut anfordern.',
  inputSchema: z.object({ jobId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: true,
  destructive: true,
  target: (input) => `render-job:${input.jobId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'DELETE',
      path: `/api/render/jobs/${input.jobId}`,
      responseSchema: deleteRenderJobResponseSchema,
    });
    return { text: 'Bau und PDF gelöscht.', data: result };
  },
});

export const RENDER_TOOLS: readonly AnyToolDefinition[] = [
  renderTemplateListTool,
  renderTemplateReadTool,
  renderTemplateCreateTool,
  renderTemplateUpdateTool,
  renderTemplateDeleteTool,
  renderStartTool,
  renderStatusTool,
  renderJobsTool,
  renderLogTool,
  renderArtifactTool,
  renderCancelTool,
  renderDeleteTool,
];
