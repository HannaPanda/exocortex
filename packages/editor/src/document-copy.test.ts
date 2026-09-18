import { describe, expect, it } from 'vitest';

import { type ProseMirrorDocument } from './contract';
import { copyDocumentForNewPage } from './document-copy';

function blockIdsOf(document: ProseMirrorDocument): string[] {
  const ids: string[] = [];
  const walk = (node: { attrs?: Record<string, unknown>; content?: unknown[] }): void => {
    const id = node.attrs?.blockId;
    if (typeof id === 'string') ids.push(id);
    for (const child of node.content ?? []) {
      walk(child as { attrs?: Record<string, unknown>; content?: unknown[] });
    }
  };
  walk(document);
  return ids;
}

const SOURCE: ProseMirrorDocument = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1, blockId: 'aaaaaaaaaaaa' },
      content: [{ type: 'text', text: 'Meeting' }],
    },
    {
      type: 'bulletList',
      attrs: { blockId: 'bbbbbbbbbbbb' },
      content: [
        {
          type: 'listItem',
          attrs: { blockId: 'cccccccccccc' },
          content: [
            {
              type: 'paragraph',
              attrs: { blockId: 'dddddddddddd' },
              content: [
                {
                  type: 'text',
                  text: 'Punkt',
                  marks: [{ type: 'link', attrs: { href: 'https://example.org' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('copyDocumentForNewPage', () => {
  it('gives every addressable block a new id', () => {
    const copy = copyDocumentForNewPage(SOURCE);
    const before = blockIdsOf(SOURCE);
    const after = blockIdsOf(copy.document);

    expect(after).toHaveLength(before.length);
    expect(after.every((id) => !before.includes(id))).toBe(true);
    expect(new Set(after).size).toBe(after.length);
  });

  it('leaves the source untouched', () => {
    copyDocumentForNewPage(SOURCE);
    expect(blockIdsOf(SOURCE)).toEqual([
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb',
      'cccccccccccc',
      'dddddddddddd',
    ]);
  });

  it('keeps text, structure and marks', () => {
    const copy = copyDocumentForNewPage(SOURCE);
    const heading = copy.document.content?.[0];
    expect(heading?.type).toBe('heading');
    expect(heading?.attrs?.level).toBe(1);
    expect(heading?.content?.[0]?.text).toBe('Meeting');

    const paragraph = copy.document.content?.[1]?.content?.[0]?.content?.[0];
    expect(paragraph?.content?.[0]?.marks?.[0]?.attrs?.href).toBe('https://example.org');
  });

  it('reports the attachments and databases the copy points at', () => {
    const copy = copyDocumentForNewPage({
      type: 'doc',
      content: [
        {
          type: 'pdf',
          attrs: { src: '/api/attachments/att123/download', name: 'Vertrag.pdf' },
        },
        { type: 'databaseEmbed', attrs: { documentId: 'db42', title: 'Aufgaben', viewId: null } },
      ],
    });

    expect(copy.attachmentIds).toEqual(['att123']);
    expect(copy.embeddedDatabaseIds).toEqual(['db42']);
  });

  it('gives a block without attributes an address', () => {
    const copy = copyDocumentForNewPage({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hallo' }] }],
    });
    const id = copy.document.content?.[0]?.attrs?.blockId;
    expect(typeof id).toBe('string');
    expect(copy.document.content?.[0]?.content?.[0]?.text).toBe('Hallo');
  });
});
