import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import { pageBlockReadTool } from './transclusion.js';

interface RecordedCall {
  path: string;
  query?: unknown;
}

const PAGE = {
  documentId: 'doc123456',
  title: 'Gesundheit',
  icon: null,
  iconColor: null,
  archivedAt: null,
  blockId: null,
  toBlockId: null,
  resolved: true,
  view: 'content' as const,
  chars: 12,
  map: null,
  markdown: 'Kurzer Text.',
  proseMirrorJson: { type: 'doc' as const },
  blocks: [],
  nested: 0,
};

const MAP = {
  mode: 'sections' as const,
  totalChars: 36_257,
  totalBlocks: 292,
  coarsened: false,
  entries: [
    {
      kind: 'section' as const,
      fromBlockId: 'abc12345',
      toBlockId: null,
      level: 2,
      title: 'Tumorambulanz Klinikum Dortmund',
      chars: 2_480,
      blocks: 9,
    },
  ],
};

function fakeClient(response: unknown): { client: ExocortexApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ path: input.path, query: input.query });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      calls.push({ path: input.path });
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

describe('pageBlockReadTool', () => {
  it('asks for the map when no block is named, whatever the page weighs', async () => {
    const { client, calls } = fakeClient({ ...PAGE, view: 'map', chars: 36_257, map: MAP });

    const result = await pageBlockReadTool.run(client, { documentId: 'doc123456' });

    expect(calls[0]?.query).toMatchObject({ want: 'map', maxChars: '10000' });
    expect(result.text).toContain('Karte der Seite „Gesundheit“');
    expect(result.text).toContain('^abc12345');
    expect(result.text).toContain('2.480 Zeichen');
  });

  it('maps a section that is itself too large instead of cutting it', async () => {
    // The recursion: page, section, sub-section, block window, content. A cut
    // here would put the reader back where issue #118 started.
    const { client } = fakeClient({
      ...PAGE,
      blockId: 'abc12345',
      view: 'map',
      chars: 112_000,
      map: { ...MAP, mode: 'ranges' as const, totalChars: 112_000 },
    });

    const result = await pageBlockReadTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
    });

    expect(result.text).toContain('ist groß');
    expect(result.text).toContain('toBlockId');
    expect(result.text).not.toContain('gekürzt');
  });

  it('reads a block window when both ends are named', async () => {
    const { client, calls } = fakeClient({
      ...PAGE,
      blockId: 'abc12345',
      toBlockId: 'def67890',
      markdown: 'Erster Absatz.\n\nZweiter Absatz.',
    });

    const result = await pageBlockReadTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
      toBlockId: 'def67890',
    });

    expect(calls[0]?.query).toMatchObject({ blockId: 'abc12345', toBlockId: 'def67890' });
    expect(calls[0]?.query).not.toHaveProperty('want');
    expect(result.text).toContain('Zweiter Absatz.');
  });

  it('says so when both ends were the same identifier and the answer is a bare heading', async () => {
    // What a run actually did on 2026-09-21: three reads of one section, one
    // heading line back each time, and then it moved the section unseen.
    const { client } = fakeClient({
      ...PAGE,
      blockId: 'abc12345',
      toBlockId: 'abc12345',
      markdown: '### Tumorambulanz Klinikum Dortmund\n',
    });

    const result = await pageBlockReadTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
      toBlockId: 'abc12345',
    });

    expect(result.text).toContain('nur die Überschriftszeile');
    expect(result.text).toContain('Ohne toBlockId');
  });

  it('says nothing extra when a window of one block really is the content', async () => {
    const { client } = fakeClient({
      ...PAGE,
      blockId: 'abc12345',
      toBlockId: 'abc12345',
      markdown: 'Ein einzelner Absatz, der die Antwort ist.',
    });

    const result = await pageBlockReadTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
      toBlockId: 'abc12345',
    });

    expect(result.text).not.toContain('Überschriftszeile');
  });

  it('still lists every block flatly when that is what was asked for', async () => {
    const { client, calls } = fakeClient({
      ...PAGE,
      blocks: [
        { blockId: 'abc12345', type: 'heading', level: 2, preview: 'Tumorambulanz' },
        { blockId: 'def67890', type: 'paragraph', level: null, preview: 'Die Klinik …' },
      ],
    });

    const result = await pageBlockReadTool.run(client, { documentId: 'doc123456', blocks: true });

    expect(calls[0]?.query).toMatchObject({ outline: 'true' });
    expect(result.text).toContain('abc12345 (heading2)');
    expect(result.text).toContain('def67890 (paragraph)');
  });

  it('names the map as the way back when an address is gone', async () => {
    const { client } = fakeClient({ ...PAGE, blockId: 'abc12345', resolved: false, markdown: '' });

    const result = await pageBlockReadTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
    });

    expect(result.text).toContain('keinen Block mit der Kennung abc12345 mehr');
    expect(result.text).toContain('Karte der Seite');
  });
});
