import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import {
  attachmentCorrectTextTool,
  attachmentReadTextTool,
  attachmentReextractTextTool,
  attachmentUploadTicketGetTool,
  attachmentUploadTicketTool,
  attachmentUploadTool,
} from './attachments.js';

interface RecordedCall {
  method?: string;
  path: string;
  body?: unknown;
  contentType?: string;
}

/** Hand-written fake client: records every call, answers with a fixed response. */
function createFakeClient(response: unknown): {
  client: ExocortexApiClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, body: input.body });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      calls.push({ path: input.path, contentType: input.contentType });
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

const baseResponse = {
  attachmentId: 'attachment1',
  filename: 'bericht.pdf',
  mimeType: 'application/pdf',
  status: 'ready' as const,
  text: 'der ausgelesene Text',
  machineText: 'der ausgelesene Text',
  correction: null,
  truncated: false,
  metadata: null,
  extractedAt: '2026-05-01T00:00:00.000Z',
  error: null,
  errorCode: null,
};

describe('exo_attachment_read_text', () => {
  it('reads the effective text, unmarked when nobody has corrected it', async () => {
    const { client, calls } = createFakeClient(baseResponse);

    const result = await attachmentReadTextTool.run(client, { attachmentId: 'attachment1' });

    expect(calls).toEqual([
      { method: 'GET', path: '/api/attachments/attachment1/text', body: undefined },
    ]);
    expect(result.text).toContain('der ausgelesene Text');
    expect(result.text).not.toContain('korrigiert');
  });

  it('marks the text as corrected and cut off when the response says so', async () => {
    const { client } = createFakeClient({
      ...baseResponse,
      correction: { editedAt: '2026-05-02T00:00:00.000Z', editedById: 'user12345' },
      truncated: true,
    });

    const result = await attachmentReadTextTool.run(client, { attachmentId: 'attachment1' });

    expect(result.text).toContain('von Hand korrigiert');
    expect(result.text).toContain('gekürzt');
  });

  it('still returns a correction even when the last machine attempt failed', async () => {
    const { client } = createFakeClient({
      ...baseResponse,
      status: 'failed' as const,
      error: 'No extractable text layer',
      errorCode: 'noTextLayer',
      correction: { editedAt: '2026-05-02T00:00:00.000Z', editedById: 'user12345' },
    });

    const result = await attachmentReadTextTool.run(client, { attachmentId: 'attachment1' });

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('der ausgelesene Text');
  });
});

describe('exo_attachment_reextract_text', () => {
  it('posts to the reextract route with the attachment as its target', async () => {
    const { client, calls } = createFakeClient({
      ...baseResponse,
      status: 'pending' as const,
      text: null,
      machineText: null,
    });

    const result = await attachmentReextractTextTool.run(client, { attachmentId: 'attachment1' });

    expect(calls).toEqual([
      { method: 'POST', path: '/api/attachments/attachment1/text/reextract', body: undefined },
    ]);
    expect(attachmentReextractTextTool.mutating).toBe(true);
    expect(attachmentReextractTextTool.targetOf({ attachmentId: 'attachment1' })).toBe(
      'attachment:attachment1',
    );
    expect(result.text).toContain('gestartet');
  });
});

describe('exo_attachment_correct_text', () => {
  it('patches the text route with the correction', async () => {
    const { client, calls } = createFakeClient({
      ...baseResponse,
      correction: { editedAt: '2026-05-02T00:00:00.000Z', editedById: 'user12345' },
    });

    const result = await attachmentCorrectTextTool.run(client, {
      attachmentId: 'attachment1',
      text: 'korrigierte Fassung',
    });

    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: '/api/attachments/attachment1/text',
        body: { text: 'korrigierte Fassung' },
      },
    ]);
    expect(result.text).toContain('gespeichert');
  });

  it('clears a correction with text: null', async () => {
    const { client, calls } = createFakeClient(baseResponse);

    const result = await attachmentCorrectTextTool.run(client, {
      attachmentId: 'attachment1',
      text: null,
    });

    expect(calls).toEqual([
      { method: 'PATCH', path: '/api/attachments/attachment1/text', body: { text: null } },
    ]);
    expect(result.text).toContain('verworfen');
  });
});

describe('exo_attachment_upload', () => {
  const uploadResponse = {
    attachment: {
      id: 'attachment1',
      workspaceId: 'workspace1',
      documentId: null,
      filename: 'zahlen.csv',
      mimeType: 'text/csv',
      byteSize: 12,
      createdById: 'user12345',
      createdAt: '2026-09-20T00:00:00.000Z',
    },
    // A presigned object-storage URL, which is the one that must never end up
    // in a page; `embedUrl` beside it is the one that belongs there (issue #117).
    downloadUrl: 'https://storage.example/objects/attachment1?signature=abc',
    embedUrl: '/api/attachments/attachment1/download',
  };

  it('declares the type of a format that has no magic bytes', async () => {
    // Without this the server sees `application/octet-stream` over text and
    // refuses it, so the browser could upload a CSV and no agent could.
    const { client, calls } = createFakeClient(uploadResponse);

    await attachmentUploadTool.run(client, {
      workspaceId: 'workspace1',
      documentId: null,
      filename: 'zahlen.csv',
      contentBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
    });

    expect(calls[0]?.contentType).toBe('text/csv');
  });

  it('leaves a binary format to the magic bytes', async () => {
    const { client, calls } = createFakeClient(uploadResponse);

    await attachmentUploadTool.run(client, {
      workspaceId: 'workspace1',
      documentId: null,
      filename: 'bericht.docx',
      contentBase64: Buffer.from('PK').toString('base64'),
    });

    expect(calls[0]?.contentType).toBe('application/octet-stream');
  });
});

const ticket = {
  id: 'ticket12345',
  workspaceId: 'ws1234567',
  documentId: 'doc123456',
  filename: null,
  state: 'open' as const,
  expiresAt: '2026-09-25T12:10:00.000Z',
  usedAt: null,
  attachmentId: null,
  embedUrl: null,
  createdAt: '2026-09-25T12:00:00.000Z',
};

/**
 * Upload tickets (ADR-064). What has to survive a rewrite: the answer carries a
 * command that works as written, and the status reads out the address that
 * belongs in a page -- the model sees `text`, not `data`.
 */
describe('exo_attachment_upload_ticket', () => {
  it('mints the ticket and hands back a command that uploads to it', async () => {
    const uploadUrl = 'https://exocortex.test/api/attachments/upload/' + 'a'.repeat(43);
    const { client, calls } = createFakeClient({ ticket, uploadUrl });

    const result = await attachmentUploadTicketTool.run(client, {
      workspaceId: 'ws1234567',
      documentId: 'doc123456',
      filename: null,
    });

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/workspaces/ws1234567/attachments/upload-tickets',
        body: { documentId: 'doc123456', filename: null },
      },
    ]);
    expect(result.text).toContain(`curl -sS -F "file=@/pfad/zur/datei" '${uploadUrl}'`);
    expect(result.text).toContain('embedUrl');
    expect(result.text).toContain('ticketId ticket12345');
  });

  it('is offered to MCP clients only, never to the built-in AI', () => {
    // The built-in loop has no files and no shell to use the address with.
    expect(attachmentUploadTicketTool.surfaces).toEqual(['mcp']);
    expect(attachmentUploadTicketGetTool.surfaces).toEqual(['mcp']);
  });
});

describe('exo_attachment_upload_ticket_get', () => {
  it('reads out the embed address once the file has arrived', async () => {
    const { client, calls } = createFakeClient({
      ticket: {
        ...ticket,
        state: 'used',
        usedAt: '2026-09-25T12:01:00.000Z',
        attachmentId: 'file1234567',
        embedUrl: '/api/attachments/file1234567/download',
      },
    });

    const result = await attachmentUploadTicketGetTool.run(client, {
      workspaceId: 'ws1234567',
      ticketId: 'ticket12345',
    });

    expect(calls[0]?.path).toBe('/api/workspaces/ws1234567/attachments/upload-tickets/ticket12345');
    expect(result.text).toContain('![Beschreibung](/api/attachments/file1234567/download)');
  });

  it('says what to do about an open and an expired ticket', async () => {
    const open = await attachmentUploadTicketGetTool.run(createFakeClient({ ticket }).client, {
      workspaceId: 'ws1234567',
      ticketId: 'ticket12345',
    });
    expect(open.text).toContain('offen');

    const expired = await attachmentUploadTicketGetTool.run(
      createFakeClient({ ticket: { ...ticket, state: 'expired' } }).client,
      { workspaceId: 'ws1234567', ticketId: 'ticket12345' },
    );
    expect(expired.text).toContain('neues Ticket');
  });
});
