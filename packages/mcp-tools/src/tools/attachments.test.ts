import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import {
  attachmentCorrectTextTool,
  attachmentReadTextTool,
  attachmentReextractTextTool,
} from './attachments.js';

interface RecordedCall {
  method?: string;
  path: string;
  body?: unknown;
}

/** Hand-written fake client: records every call, answers with a fixed response. */
function createFakeClient(response: unknown): { client: ExocortexApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, body: input.body });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      calls.push({ path: input.path });
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
