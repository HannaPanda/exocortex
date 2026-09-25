import { z } from 'zod';

import {
  ATTACHMENT_TEXT_MAX_CHARS,
  attachmentTextInfoResponseSchema,
  attachmentTextResponseSchema,
  createUploadTicketRequestSchema,
  createUploadTicketResponseSchema,
  type DocumentTextMetadata,
  idSchema,
  uploadAttachmentFromUrlRequestSchema,
  uploadAttachmentResponseSchema,
  type UploadTicket,
  uploadTicketResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * `apps/api/src/attachments/attachments.controller.ts` has no
 * `GET /api/workspaces/:workspaceId/attachments` list route (checked against
 * the live controller), so `exo_attachment_list` is dropped rather than
 * guessed at. Adding that route is out of scope for this brief; see
 * `docs/mcp.md` "Known gaps".
 *
 * `GET /api/attachments/:attachmentId/download` streams the file bytes
 * directly, which does not fit the JSON tool-result model this catalogue is
 * built on, so there is no tool that fetches an attachment's content. Its
 * *address* is a different matter and is returned by both upload tools, because
 * that address is what a page needs (issue #117).
 */

/**
 * The two sentences every caller has to have read before it embeds anything.
 *
 * Repeated in both upload tools rather than written once and referenced: a
 * model reads one tool description, not the file they live in, and the whole
 * failure this text exists to prevent was an agent that had read the one
 * description that did not say it.
 */
const EMBED_RECIPE =
  'Zum Einbetten in eine Seite gilt embedUrl (/api/attachments/<id>/download), nicht downloadUrl: ' +
  'downloadUrl zeigt auf den Objektspeicher, läuft nach fünf Minuten ab und wird vom Browser ' +
  'ohnehin blockiert. Ein Bild kommt also so auf eine Seite: erst hochladen, dann ' +
  '![Beschreibung](embedUrl) über exo_page_write schreiben. Eine Bildadresse auf einem fremden ' +
  'Server funktioniert nie, egal ob sie im Browser aufrufbar ist.';

/**
 * The page a file belongs to, required on every upload tool.
 *
 * The REST routes still accept a file without one, but no screen ever makes
 * such a file and nothing ever collects it: deleting a page for good deletes
 * the files hanging off it, and a file hanging off none outlives everything.
 * An agent left the page out of its first ticket because the description
 * called it optional, and the picture it embedded became exactly that. So the
 * tools ask for the decision instead of offering a default, the same way the
 * browser always names the page it uploads into (and a project names itself).
 */
const uploadOwnerSchema = idSchema.describe(
  'Die Seite, auf der die Datei erscheinen soll, oder das Projekt, in das sie kommt. Die Datei ' +
    'gehört dann zu ihr: wird die Seite endgültig gelöscht, geht die Datei mit. Pflicht, auch ' +
    'wenn du die Datei erst später einbettest.',
);

/**
 * The declared type for the formats that carry no signature.
 *
 * Everything binary is identified from its magic bytes server-side, so an
 * upload never has to guess. Plain text does not work that way: CSV, Markdown,
 * JSON and plain text look identical to a byte reader, so the server accepts
 * them only when the upload says which one it is. Sending
 * `application/octet-stream` for all of them, as this tool used to, meant the
 * browser could upload a CSV and no agent could -- and CSV is one of the twelve
 * formats whose text is read (issue #38). The extension is the only thing the
 * caller gives us to go on, and the server still refuses anything that is not
 * valid text.
 */
const DECLARED_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  txt: 'text/plain',
};

function declaredTypeFor(filename: string): string {
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  return DECLARED_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

const attachmentUploadInputSchema = z.object({
  workspaceId: idSchema,
  documentId: uploadOwnerSchema,
  filename: z.string().min(1).max(255),
  contentBase64: z.string().max(35_000_000),
});

/** One line both upload tools answer with, so an embed can be written from it. */
function uploadedText(result: { attachment: { filename: string; id: string }; embedUrl: string }) {
  return (
    `Datei hochgeladen: ${result.attachment.filename} (id: ${result.attachment.id}).\n` +
    `Einbetten mit: ![Beschreibung](${result.embedUrl})`
  );
}

export const attachmentUploadTool: AnyToolDefinition = defineTool({
  name: 'exo_attachment_upload',
  description:
    'Lädt eine Datei (Base64-kodiert) auf eine Seite (documentId) eines Workspace hoch. ' +
    'Nur für kleine Inhalte, die du selbst erzeugt hast: du musst jedes Byte als Base64 in den ' +
    'Aufruf schreiben, für ein Foto oder ein PDF ist das zu viel. Liegt die Datei bei dir lokal, ' +
    'nimm exo_attachment_upload_ticket. ' +
    EMBED_RECIPE,
  inputSchema: attachmentUploadInputSchema,
  surfaces: ['mcp', 'ai'],
  domain: 'attachments',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const bytes = Buffer.from(input.contentBase64, 'base64');
    const result = await client.upload({
      path: `/api/workspaces/${input.workspaceId}/attachments`,
      filename: input.filename,
      // The API sniffs the real MIME type from magic bytes server-side, so
      // this is only ever a hint -- and one that matters for the formats that
      // have no magic bytes to sniff (see DECLARED_TYPE_BY_EXTENSION).
      contentType: declaredTypeFor(input.filename),
      bytes,
      fields: { documentId: input.documentId },
      responseSchema: uploadAttachmentResponseSchema,
    });
    return { text: uploadedText(result), data: result };
  },
});

/**
 * The same upload, from an address (issue #117).
 *
 * A tool of its own rather than a `sourceUrl` on the one above, and the reason
 * is `untrustedOutput`: it is declared per tool, not per call. This one fetches
 * from the open web, so a run that uses it has read something nobody here
 * wrote and must be fenced (ADR-030) -- even though the answer carries no web
 * text, exactly as `exo_clip` is fenced, because the bytes land in a workspace
 * where the same run can read them back. Folding the two together would fence
 * every Base64 upload as well, which would end a run for having attached a file
 * it produced itself.
 */
export const attachmentUploadUrlTool: AnyToolDefinition = defineTool({
  name: 'exo_attachment_upload_url',
  description:
    'Lädt die Datei unter einer Adresse auf eine Seite (documentId) eines Workspace hoch. ' +
    'Das ist der Weg für ein Bild, das schon öffentlich im Netz steht und von dem du nur die ' +
    'Adresse hast: eXocortex holt es und legt es als Anhang ab. Die Adresse muss öffentlich ' +
    'erreichbar sein (kein localhost, keine internen Netze). Eine Datei, die bei dir lokal liegt, ' +
    'nicht erst auf einem Server veröffentlichen, um sie hiermit zu holen: dafür ist ' +
    'exo_attachment_upload_ticket da. ' +
    EMBED_RECIPE,
  inputSchema: z
    .object({ workspaceId: idSchema })
    .extend(uploadAttachmentFromUrlRequestSchema.shape)
    .extend({ documentId: uploadOwnerSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'attachments',
  mutating: true,
  // The file comes from outside this deployment. See the note above.
  untrustedOutput: 'web',
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/attachments/from-url`,
      body,
      responseSchema: uploadAttachmentResponseSchema,
    });
    return { text: uploadedText(result), data: result };
  },
});

/**
 * Upload tickets (ADR-064): the way in for a file that sits on the agent's own
 * disk.
 *
 * The two tools above both failed that case. Base64 makes the model spell out
 * every byte, which is impossible for a photograph; the URL upload needs the
 * file somewhere public, and agents solved that by putting pictures on
 * whatever site they could write to, mixing unrelated projects. A ticket is an
 * address the agent's own script POSTs the file to, so the bytes go from disk
 * to here and nowhere else.
 *
 * MCP only. The built-in AI runs in the worker and holds no files and no
 * shell, so on that surface the tool would hand out an address nobody could
 * use (`SURFACE_EXEMPT` in `scripts/check-capability-parity.mjs`).
 */
export const attachmentUploadTicketTool: AnyToolDefinition = defineTool({
  name: 'exo_attachment_upload_ticket',
  description:
    'Der Weg für eine Datei, die bei dir lokal liegt (ein Foto aus einem Chat, ein PDF, ein ' +
    'Screenshot): gibt eine einmalige Upload-Adresse zurück, zehn Minuten gültig, an die dein ' +
    'Skript oder deine Shell die Datei direkt schickt, zum Beispiel mit ' +
    'curl -F "file=@/pfad/zur/datei" <uploadUrl>. Die Antwort darauf ist JSON mit embedUrl. ' +
    'Die Bytes gehen so nicht durch dein Modell und nicht über einen fremden Server: lege eine ' +
    'Datei nie auf einer anderen Website oder in einem anderen Projekt ab, um sie hierher zu ' +
    'bekommen. documentId ist Pflicht: die Seite, auf der die Datei erscheinen soll, oder das ' +
    'Projekt, in das sie kommt. Mit filename bekommt sie einen eigenen Namen. Die Adresse ist ein Geheimnis für genau einen Upload: nicht in Seiten, Commits oder ' +
    'Nachrichten schreiben. Siehst du die Ausgabe des Skripts nicht, nennt ' +
    'exo_attachment_upload_ticket_get Stand und embedUrl. ' +
    EMBED_RECIPE,
  inputSchema: z
    .object({ workspaceId: idSchema })
    .extend(createUploadTicketRequestSchema.shape)
    .extend({ documentId: uploadOwnerSchema }),
  surfaces: ['mcp'],
  domain: 'attachments',
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const { workspaceId, ...body } = input;
    const result = await client.request({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/attachments/upload-tickets`,
      body,
      responseSchema: createUploadTicketResponseSchema,
    });
    const text =
      `Upload-Ticket ${result.ticket.id} erstellt, gültig bis ${result.ticket.expiresAt}, ` +
      'für genau einen Upload.\n' +
      'Datei hochladen (eine Datei, als multipart/form-data):\n' +
      `curl -sS -F "file=@/pfad/zur/datei" '${result.uploadUrl}'\n` +
      'Die Antwort ist JSON mit embedUrl. Einbetten mit: ![Beschreibung](embedUrl) über ' +
      'exo_page_write.\n' +
      `Stand abfragen: exo_attachment_upload_ticket_get mit workspaceId ${result.ticket.workspaceId} ` +
      `und ticketId ${result.ticket.id}.\n` +
      'Die Adresse ist ein Geheimnis: nirgends hinschreiben. Schlägt der Upload fehl, gilt das ' +
      'Ticket weiter, bis es abläuft.';
    return { text, data: result };
  },
});

/** Where a ticket stands, in one sentence the model can act on. */
function describeTicket(ticket: UploadTicket): string {
  switch (ticket.state) {
    case 'open':
      return (
        `Upload-Ticket ${ticket.id} ist offen, noch keine Datei angekommen. ` +
        `Gültig bis ${ticket.expiresAt}.`
      );
    case 'expired':
      return (
        `Upload-Ticket ${ticket.id} ist abgelaufen, ohne dass eine Datei ankam. ` +
        'Für einen neuen Versuch ein neues Ticket holen.'
      );
    case 'used':
      return ticket.embedUrl === null
        ? `Upload-Ticket ${ticket.id} wird gerade eingelöst; die Datei ist noch nicht gespeichert.`
        : `Upload-Ticket ${ticket.id} ist eingelöst: Anhang ${ticket.attachmentId ?? ''}. ` +
            `Einbetten mit: ![Beschreibung](${ticket.embedUrl})`;
  }
}

export const attachmentUploadTicketGetTool: AnyToolDefinition = defineTool({
  name: 'exo_attachment_upload_ticket_get',
  description:
    'Sagt, wo ein Upload-Ticket aus exo_attachment_upload_ticket steht: offen, eingelöst (dann ' +
    'mit embedUrl zum Einbetten) oder abgelaufen. Für den Fall, dass du die Antwort deines ' +
    'Upload-Skripts nicht gesehen hast. Nur Tickets, die du selbst geholt hast.',
  inputSchema: z.object({ workspaceId: idSchema, ticketId: idSchema }),
  surfaces: ['mcp'],
  domain: 'attachments',
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/workspaces/${input.workspaceId}/attachments/upload-tickets/${input.ticketId}`,
      responseSchema: uploadTicketResponseSchema,
    });
    return { text: describeTicket(result.ticket), data: result };
  },
});

/**
 * One-line German header describing the document, or the empty string when no
 * engine reported anything. Only fields that are actually known are listed, so
 * an engine that reports little produces a short line instead of a row of
 * "unbekannt".
 */
function describeMetadata(metadata: DocumentTextMetadata | null): string {
  if (metadata === null) return '';

  const parts: string[] = [];
  if (metadata.title !== null) parts.push(`Titel: ${metadata.title}`);
  if (metadata.author !== null) parts.push(`Autor: ${metadata.author}`);
  if (metadata.pageCount !== null) {
    parts.push(metadata.pageCount === 1 ? '1 Seite' : `${metadata.pageCount} Seiten`);
  }
  if (metadata.tableCount !== null && metadata.tableCount > 0) {
    parts.push(metadata.tableCount === 1 ? '1 Tabelle' : `${metadata.tableCount} Tabellen`);
  }
  if (metadata.createdAt !== null) parts.push(`erstellt ${metadata.createdAt.slice(0, 10)}`);
  if (metadata.ocrUsed === true) parts.push('per Texterkennung gelesen');

  return parts.length === 0 ? '' : `[${parts.join(' | ')}]\n\n`;
}

/**
 * Note prepended when a correction exists, so a model never mistakes a
 * hand-corrected text for the raw machine output, or vice versa (issue #2):
 * `text`/`AttachmentTextResponse.text` is always the corrected version once
 * one exists, and this is what tells the model so.
 */
function describeCorrection(result: {
  correction: { editedAt: string } | null;
  truncated: boolean;
}): string {
  const parts: string[] = [];
  if (result.correction !== null) parts.push('von Hand korrigiert');
  if (result.truncated) parts.push('maschinell gelesener Anteil gekürzt');
  return parts.length === 0 ? '' : `[${parts.join(', ')}]\n\n`;
}

export const attachmentReadTextTool: AnyToolDefinition = defineTool({
  name: 'exo_attachment_read_text',
  description:
    'Liest den extrahierten Text eines Anhangs (z. B. eines PDFs). Die Extraktion läuft im Hintergrund; ' +
    'status: "pending" bedeutet, dass das Werkzeug in Kürze erneut aufgerufen werden sollte. ' +
    'Mit includeText: false kommen nur Status und Metadaten (Titel, Autor, Seitenzahl, Tabellen, ' +
    'Texterkennung) zurück, und eine noch nicht gelaufene Extraktion wird dadurch auch nicht gestartet. ' +
    'Wenn ein Mensch den Text korrigiert hat, ist es immer die korrigierte Fassung, die hier zurückkommt.',
  inputSchema: z.object({
    attachmentId: idSchema,
    /**
     * The same distinction the editor's PDF block makes: drawing a header needs
     * the metadata, not 400,000 characters, and drawing must not start work.
     */
    includeText: z.boolean().default(true),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'attachments',
  mutating: false,
  // A file somebody uploaded. Whatever the extraction found is the author's
  // text, not this workspace's, and a PDF is a perfectly good place to hide a
  // paragraph addressed to a model (issue #56).
  untrustedOutput: 'attachment',
  async execute(client, input) {
    if (!input.includeText) {
      const info = await client.request({
        method: 'GET',
        path: `/api/attachments/${input.attachmentId}/text/info`,
        responseSchema: attachmentTextInfoResponseSchema,
      });
      const described = describeMetadata(info.metadata).trim();
      return {
        text: `${info.filename} (Status: ${info.status})${described.length === 0 ? '' : ` ${described}`}`,
        data: info,
      };
    }

    const result = await client.request({
      method: 'GET',
      path: `/api/attachments/${input.attachmentId}/text`,
      responseSchema: attachmentTextResponseSchema,
    });
    if (result.status === 'pending') {
      return {
        text: `Textextraktion für ${result.filename} läuft noch. Bitte gleich erneut versuchen.`,
        data: result,
      };
    }
    if (result.status === 'failed' && result.text === null) {
      return {
        text: `Textextraktion für ${result.filename} fehlgeschlagen: ${result.error ?? 'unbekannt'}`,
        data: result,
        isError: true,
      };
    }
    if (result.status === 'not_applicable' && result.text === null) {
      return { text: `${result.filename} hat keine extrahierbare Textebene.`, data: result };
    }
    // The metadata is prepended as a short header rather than left in `data`
    // alone: a model reading a PDF wants to know that it is looking at page 33
    // of a scan before it starts quoting from it -- and, if a correction
    // exists, that it is reading that correction rather than the raw scan.
    return {
      text: `${describeMetadata(result.metadata)}${describeCorrection(result)}${result.text ?? ''}`,
      data: result,
    };
  },
});

export const attachmentReextractTextTool: AnyToolDefinition = defineTool({
  name: 'exo_attachment_reextract_text',
  description:
    'Erzwingt eine erneute Textextraktion eines Anhangs, auch wenn bereits ein Ergebnis vorliegt ' +
    '(status: "ready"). Für den Fall, dass eine Extraktion zwar gelungen, aber inhaltlich falsch war ' +
    '(z. B. verlesene Texterkennung, zerfallene Tabellen). Läuft im Hintergrund; das Ergebnis kommt erst ' +
    'bei einem erneuten Aufruf von exo_attachment_read_text. Eine vorhandene Korrektur bleibt dabei ' +
    'unangetastet und bleibt die Fassung, die gelesen wird, bis sie geändert oder verworfen wird.',
  inputSchema: z.object({ attachmentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  domain: 'attachments',
  mutating: true,
  destructive: true,
  target: (input) => `attachment:${input.attachmentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'POST',
      path: `/api/attachments/${input.attachmentId}/text/reextract`,
      responseSchema: attachmentTextResponseSchema,
    });
    return {
      text: `Erneute Textextraktion für ${result.filename} gestartet.`,
      data: result,
    };
  },
});

export const attachmentCorrectTextTool: AnyToolDefinition = defineTool({
  name: 'exo_attachment_correct_text',
  description:
    'Schreibt eine von Hand korrigierte Fassung des ausgelesenen Texts eines Anhangs, oder verwirft ' +
    `sie wieder mit text: null (bis zu ${ATTACHMENT_TEXT_MAX_CHARS.toLocaleString('de-DE')} Zeichen). ` +
    'Die Korrektur ersetzt nicht das Maschinenergebnis, sondern liegt daneben, und gewinnt: eine ' +
    'spätere erneute Extraktion überschreibt sie nicht, und exo_attachment_read_text liefert danach die ' +
    'korrigierte Fassung. Nur für PDF-Anhänge mit einer Textebene verfügbar.',
  inputSchema: z.object({
    attachmentId: idSchema,
    text: z.string().max(ATTACHMENT_TEXT_MAX_CHARS).nullable(),
  }),
  surfaces: ['mcp', 'ai'],
  domain: 'attachments',
  mutating: true,
  destructive: true,
  target: (input) => `attachment:${input.attachmentId}`,
  async execute(client, input) {
    const result = await client.request({
      method: 'PATCH',
      path: `/api/attachments/${input.attachmentId}/text`,
      body: { text: input.text },
      responseSchema: attachmentTextResponseSchema,
    });
    return {
      text:
        input.text === null
          ? `Korrektur für ${result.filename} verworfen; die maschinell gelesene Fassung gilt wieder.`
          : `Korrektur für ${result.filename} gespeichert.`,
      data: result,
    };
  },
});

export const ATTACHMENT_TOOLS: readonly AnyToolDefinition[] = [
  attachmentUploadTool,
  attachmentUploadUrlTool,
  attachmentUploadTicketTool,
  attachmentUploadTicketGetTool,
  attachmentReadTextTool,
  attachmentReextractTextTool,
  attachmentCorrectTextTool,
];
