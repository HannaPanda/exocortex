import { z } from 'zod';

import {
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
  if (metadata.pageCount !== null) parts.push(`${metadata.pageCount} Seiten`);
  if (metadata.tableCount !== null && metadata.tableCount > 0) {
    parts.push(`${metadata.tableCount} Tabellen`);
  }
  if (metadata.createdAt !== null) parts.push(`erstellt ${metadata.createdAt.slice(0, 10)}`);
  if (metadata.ocrUsed === true) parts.push('per Texterkennung gelesen');

  return parts.length === 0 ? '' : `[${parts.join(' | ')}]\n\n`;
}

export const attachmentReadTextTool: AnyToolDefinition = defineTool({
  name: 'exo_attachment_read_text',
  description:
    'Liest den extrahierten Text eines Anhangs (z. B. eines PDFs). Die Extraktion läuft im Hintergrund; ' +
    'status: "pending" bedeutet, dass das Werkzeug in Kürze erneut aufgerufen werden sollte.',
  inputSchema: z.object({ attachmentId: idSchema }),
  surfaces: ['mcp', 'ai'],
  mutating: false,
  async execute(client, input) {
    const result = await client.request({
      method: 'GET',
      path: `/api/attachments/${input.attachmentId}/text`,
      responseSchema: attachmentTextResponseSchema,
    });
    if (result.status === 'pending') {
      return { text: `Textextraktion für ${result.filename} läuft noch. Bitte gleich erneut versuchen.`, data: result };
    }
    if (result.status === 'failed') {
      return { text: `Textextraktion für ${result.filename} fehlgeschlagen: ${result.error ?? 'unbekannt'}`, data: result, isError: true };
    }
    if (result.status === 'not_applicable') {
      return { text: `${result.filename} hat keine extrahierbare Textebene.`, data: result };
    }
    // The metadata is prepended as a short header rather than left in `data`
    // alone: a model reading a PDF wants to know that it is looking at page 33
    // of a scan before it starts quoting from it.
    return { text: `${describeMetadata(result.metadata)}${result.text ?? ''}`, data: result };
  },
});

export const ATTACHMENT_TOOLS: readonly AnyToolDefinition[] = [attachmentUploadTool, attachmentReadTextTool];
