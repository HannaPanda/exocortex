// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { type BlockCatalogEntry } from './block-catalog';
import { type ProseMirrorNode } from './contract';
import { buildBlockCatalog, buildEditorExtensions } from './extensions';

let editor: Editor | null = null;

function createEditor(): Editor {
  editor = new Editor({
    extensions: buildEditorExtensions(),
    content: '<p>Ein Absatz</p>',
  });
  return editor;
}

/** Node type names anywhere in the document. */
function nodeTypes(instance: Editor): string[] {
  const types: string[] = [];
  const walk = (node: ProseMirrorNode): void => {
    types.push(node.type);
    for (const child of node.content ?? []) walk(child);
  };
  walk(instance.getJSON() as unknown as ProseMirrorNode);
  return types;
}

function entry(id: string): BlockCatalogEntry {
  const found = buildBlockCatalog().find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no catalog entry ${id}`);
  return found;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/**
 * Every catalog entry is executed against a real editor.
 *
 * A `run` that reports success without changing the document is the failure mode
 * these cover: `setDetails()` did exactly that from an empty paragraph, so the
 * slash menu silently did nothing. Only a real editor catches it, which is why
 * this suite runs in jsdom.
 */
describe('block catalog execution', () => {
  it('inserts or converts for every entry that needs no extra value', () => {
    for (const candidate of buildBlockCatalog()) {
      if (candidate.prompt !== 'none') continue;

      const instance = createEditor();
      // A conversion into what the block already is correctly reports failure;
      // the fixture starts as a paragraph.
      if (candidate.isActive?.(instance) === true) {
        instance.destroy();
        editor = null;
        continue;
      }
      const before = instance.getHTML();
      const applied = candidate.run(instance);

      expect(applied, `${candidate.id} reported failure`).toBe(true);
      expect(instance.getHTML(), `${candidate.id} changed nothing`).not.toBe(before);
      instance.destroy();
      editor = null;
    }
  });

  it('inserts a toggle with a summary and a content child', () => {
    const instance = createEditor();
    entry('toggle').run(instance);

    const types = nodeTypes(instance);
    expect(types).toContain('details');
    expect(types).toContain('detailsSummary');
    expect(types).toContain('detailsContent');
  });

  it('inserts a column layout with two columns', () => {
    const instance = createEditor();
    entry('columns').run(instance);

    const layout = (instance.getJSON() as unknown as ProseMirrorNode).content?.find(
      (node) => node.type === 'columnList',
    );
    expect(layout?.content).toHaveLength(2);
  });

  it('inserts the derived blocks as empty atoms', () => {
    for (const id of ['table-of-contents', 'breadcrumb']) {
      const instance = createEditor();
      entry(id).run(instance);
      expect(nodeTypes(instance), `${id} was not inserted`).toContain(
        id === 'breadcrumb' ? 'breadcrumb' : 'tableOfContents',
      );
      instance.destroy();
      editor = null;
    }
  });

  it('applies every entry that takes a value', () => {
    const values: Readonly<Record<string, string>> = {
      latex: 'a^2 + b^2 = c^2',
      url: 'https://exocortex.app/bild.png',
      file: '/api/attachments/abc/download',
      page: 'Andere Seite',
      database: JSON.stringify({ documentId: 'doc123', title: 'Aufgaben' }),
    };

    for (const candidate of buildBlockCatalog()) {
      if (candidate.prompt === 'none') continue;

      const instance = createEditor();
      const before = instance.getHTML();
      const applied = candidate.run(instance, values[candidate.prompt]);

      expect(applied, `${candidate.id} reported failure`).toBe(true);
      expect(instance.getHTML(), `${candidate.id} changed nothing`).not.toBe(before);
      instance.destroy();
      editor = null;
    }
  });

  it('refuses an entry that needs a value when none is given', () => {
    for (const candidate of buildBlockCatalog()) {
      if (candidate.prompt === 'none') continue;
      const instance = createEditor();
      expect(candidate.run(instance), `${candidate.id} accepted an empty value`).toBe(false);
      instance.destroy();
      editor = null;
    }
  });
});
