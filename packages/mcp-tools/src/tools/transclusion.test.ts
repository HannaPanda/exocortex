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
  yjsUpdatedAt: '2026-09-21T12:00:00.000Z',
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

/**
 * Answers with `responses` in order, and repeats the last one after that.
 *
 * One call per tool run is the normal case; a heading addressed from itself to
 * itself is read twice, and the two answers have to differ or the test proves
 * nothing about the second read.
 */
function fakeClient(...responses: unknown[]): {
  client: ExocortexApiClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const answer = (): unknown => responses[Math.min(calls.length - 1, responses.length - 1)];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ path: input.path, query: input.query });
      return input.responseSchema.parse(answer());
    },
    async upload(input) {
      calls.push({ path: input.path });
      return input.responseSchema.parse(answer());
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

  it('answers with the section when both ends were the same heading, and says it widened', async () => {
    // What two runs actually did on 2026-09-21: five reads of one section, one
    // heading line back each time, and then they moved the section unseen. A
    // sentence explaining the mistake was there for the last two of them.
    const { client, calls } = fakeClient(
      {
        ...PAGE,
        blockId: 'abc12345',
        toBlockId: 'abc12345',
        markdown: '### Tumorambulanz Klinikum Dortmund\n',
      },
      {
        ...PAGE,
        blockId: 'abc12345',
        markdown: '### Tumorambulanz Klinikum Dortmund\n\nDie Ambulanz liegt im Haus 3.',
      },
    );

    const result = await pageBlockReadTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
      toBlockId: 'abc12345',
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.query).not.toHaveProperty('toBlockId');
    expect(result.text).toContain('nur die Überschriftszeile');
    expect(result.text).toContain('Die Ambulanz liegt im Haus 3.');
  });

  it('carries the same note above the map when the widened section is too large', async () => {
    const { client } = fakeClient(
      { ...PAGE, blockId: 'abc12345', toBlockId: 'abc12345', markdown: '## Behandlungen\n' },
      { ...PAGE, blockId: 'abc12345', view: 'map', chars: 112_000, map: MAP },
    );

    const result = await pageBlockReadTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
      toBlockId: 'abc12345',
    });

    expect(result.text).toContain('nur die Überschriftszeile');
    expect(result.text).toContain('ist groß');
  });

  it('reads once and says nothing extra when a window of one block really is the content', async () => {
    const { client, calls } = fakeClient({
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

    expect(calls).toHaveLength(1);
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

/**
 * The revision travels in the text, not only in `data` (issue #120).
 *
 * The worker hands the model `result.text` and drops the structured payload,
 * so a value that reaches only `data` reaches nobody. Every answer of this
 * tool carries it, including the map and the dead-address one: reading a
 * section and writing it back is one call plus one call, and it must not need
 * a whole-page read in between just to learn the revision.
 */
describe('pageBlockReadTool and the page revision', () => {
  it('ends a content answer with the revision to write back with', async () => {
    const { client } = fakeClient({ ...PAGE, markdown: '## Abschnitt\n\nEin Satz.' });

    const result = await pageBlockReadTool.run(client, {
      documentId: 'doc123456',
      blockId: 'abc12345',
    });

    expect(result.text).toContain('Revision dieser Seite: 2026-09-21T12:00:00.000Z');
    expect(result.text).toContain('expectedYjsUpdatedAt');
  });

  it('ends a map answer with it too, because that is where navigation starts', async () => {
    const { client } = fakeClient({ ...PAGE, view: 'map', map: MAP, markdown: '', chars: 36_257 });

    const result = await pageBlockReadTool.run(client, { documentId: 'doc123456' });

    expect(result.text).toContain('Revision dieser Seite: 2026-09-21T12:00:00.000Z');
  });

  it('ends even a dead address with it, so the recovery read is the last one needed', async () => {
    const { client } = fakeClient({ ...PAGE, resolved: false, blockId: 'weggefallen' });

    const result = await pageBlockReadTool.run(client, {
      documentId: 'doc123456',
      blockId: 'weggefallen',
    });

    expect(result.text).toContain('Revision dieser Seite: 2026-09-21T12:00:00.000Z');
  });
});
