import { z } from 'zod';

import { attachmentTextResponseSchema, idSchema, uploadAttachmentResponseSchema } from '@exocortex/contracts';

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
    return { text: result.text ?? '', data: result };
  },
});

export const ATTACHMENT_TOOLS: readonly AnyToolDefinition[] = [attachmentUploadTool, attachmentReadTextTool];
