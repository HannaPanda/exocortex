import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import {
  pageBlockWriteTool,
  pageExtractSectionTool,
  pagePatchTool,
  pageSectionWriteTool,
} from './page-edits.js';
import { pageWriteTool } from './pages.js';

interface RecordedCall {
  path: string;
  body?: unknown;
}

const RESPONSE = {
  document: {
    id: 'newpage123',
    workspaceId: 'ws1234567',
    parentId: 'doc123456',
    type: 'PAGE' as const,
    title: 'Tumorambulanz',
    icon: null,
    iconColor: null,
    coverAttachmentId: null,
    coverPosition: 50,
    layout: 'narrow' as const,
    overviewMode: 'off' as const,
    orderKey: 'a0',
    createdById: 'user12345',
    updatedById: 'user12345',
    createdAt: '2026-09-21T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:00.000Z',
    archivedAt: null,
  },
  created: true,
  sourceDocumentId: 'doc123456',
  heading: 'Tumorambulanz',
  movedBlocks: 9,
  movedChars: 2_480,
  replacement: 'link' as const,
  snapshotId: 'snap123456',
  yjsUpdatedAt: '2026-09-21T10:00:00.000Z',
  appliedToLiveSession: false,
  warnings: [],
};

function fakeClient(response: unknown): { client: ExocortexApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ path: input.path, body: input.body });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      calls.push({ path: input.path });
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

describe('pageExtractSectionTool', () => {
  it('moves a section in one call and says where it went', async () => {
    const { client, calls } = fakeClient(RESPONSE);

    const result = await pageExtractSectionTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
    });

    expect(calls[0]?.path).toBe('/api/documents/doc123456/content/extract-section');
    expect(calls[0]?.body).toMatchObject({ blockId: 'abc12345', replacement: 'link' });
    expect(result.text).toContain('Neue Seite „Tumorambulanz“');
    expect(result.text).toContain('9 Blöcke');
    // The way back is part of the answer, not something to ask for afterwards.
    expect(result.text).toContain('snap123456');
  });

  it('says what a reader of the source page sees now', async () => {
    const { client } = fakeClient({ ...RESPONSE, replacement: 'transclusion' });

    const result = await pageExtractSectionTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
      replacement: 'transclusion',
    });

    expect(result.text).toContain('bindet den Abschnitt jetzt von dort ein');
  });

  it('names the page it appended to instead of claiming a new one', async () => {
    const { client } = fakeClient({ ...RESPONSE, created: false });

    const result = await pageExtractSectionTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
      targetDocumentId: 'newpage123',
    });

    expect(result.text).toContain('An Seite „Tumorambulanz“');
    expect(result.text).not.toContain('Neue Seite');
  });
});

/**
 * The concurrency guard, as a caller can actually reach it (issue #120).
 *
 * These are description tests, which is unusual and deliberate: the defect was
 * never in the code. `expectedYjsUpdatedAt` worked exactly as written; what
 * was wrong was the one sentence telling an agent where the value comes from,
 * and that sentence pointed at a read which did not return it. So what is
 * pinned here is that every write says the same thing, and that it names the
 * timestamp a caller must not use.
 */
describe('what the narrow writes say about expectedYjsUpdatedAt', () => {
  const writes = [
    pageBlockWriteTool,
    pagePatchTool,
    pageSectionWriteTool,
    pageExtractSectionTool,
    pageWriteTool,
  ];

  it('names the read that carries the revision, on every write that takes one', () => {
    for (const tool of writes) {
      expect(tool.description, tool.name).toContain('expectedYjsUpdatedAt');
      expect(tool.description, tool.name).toContain('Revision dieser Seite');
      expect(tool.description, tool.name).toContain('exo_page_read');
    }
  });

  it('warns off the frontmatter timestamp, which is the mistake that was made', () => {
    for (const tool of writes) {
      expect(tool.description, tool.name).toContain('Frontmatter');
    }
  });

  it('still says that leaving it out writes without the guard', () => {
    for (const tool of writes) {
      expect(tool.description, tool.name).toContain('ohne diese Sicherung');
    }
  });
});
