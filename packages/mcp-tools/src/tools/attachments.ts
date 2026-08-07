import { z } from 'zod';

import {
  ATTACHMENT_TEXT_MAX_CHARS,
  attachmentTextInfoResponseSchema,
  attachmentTextResponseSchema,
  idSchema,
  type PdfMetadata,
  uploadAttachmentResponseSchema,
} from '@exocortex/contracts';

import { type AnyToolDefinition, defineTool } from '../tool.js';

/**
 * `apps/api/src/attachments/attachments.controller.ts` has no
 * `GET /api/workspaces/:workspaceId/attachments` list route (checked against
 * the live controller), so `exo_attachment_list` is dropped rather than
 * guessed at. Adding that route is out of scope for this brief; see
 * `docs/mcp.md` "Known gaps".
 *
 * Likewise `GET /api/attachments/:attachmentId/download` streams the file
 * bytes directly (it is not a JSON response with a presigned URL), which does
 * not fit the JSON tool-result model this catalogue is built on, so
 * `exo_attachment_download_url` is dropped too. The presigned URL is still
 * reachable through `exo_attachment_upload`'s response at upload time.
 */

const attachmentUploadInputSchema = z.object({
  workspaceId: idSchema,
  documentId: idSchema.nullable().default(null),
  filename: z.string().min(1).max(255),
  contentBase64: z.string().max(35_000_000),
});

export const attachmentUploadTool: AnyToolDefinition = defineTool({
  name: 'exo_attachment_upload',
  description:
    'Lädt eine Datei (Base64-kodiert) in einen Workspace hoch, optional an eine Seite angehängt.',
  inputSchema: attachmentUploadInputSchema,
  surfaces: ['mcp', 'ai'],
  mutating: true,
  target: (input) => `workspace:${input.workspaceId}`,
  async execute(client, input) {
    const bytes = Buffer.from(input.contentBase64, 'base64');
    const result = await client.upload({
      path: `/api/workspaces/${input.workspaceId}/attachments`,
      filename: input.filename,
      // The API sniffs the real MIME type from magic bytes server-side, so
      // the upload never guesses it client-side.
      contentType: 'application/octet-stream',
      bytes,
      fields: input.documentId !== null ? { documentId: input.documentId } : undefined,
      responseSchema: uploadAttachmentResponseSchema,
    });
    return {
      text: `Datei hochgeladen: ${result.attachment.filename} (id: ${result.attachment.id})`,
      data: result,
    };
  },
});

/**
 * One-line German header describing the document, or the empty string when no
 * engine reported anything. Only fields that are actually known are listed, so
 * an engine that reports little produces a short line instead of a row of
 * "unbekannt".
 */
function describeMetadata(metadata: PdfMetadata | null): string {
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
  mutating: false,
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
      return { text: `Textextraktion für ${result.filename} läuft noch. Bitte gleich erneut versuchen.`, data: result };
    }
    if (result.status === 'failed' && result.text === null) {
      return { text: `Textextraktion für ${result.filename} fehlgeschlagen: ${result.error ?? 'unbekannt'}`, data: result, isError: true };
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
  mutating: true,
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
  mutating: true,
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
  attachmentReadTextTool,
  attachmentReextractTextTool,
  attachmentCorrectTextTool,
];
