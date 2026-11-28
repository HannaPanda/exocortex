// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Heading from '@tiptap/extension-heading';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';

import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { buildEditorExtensions } from './extensions';
import { parseMarkdown } from './markdown/parse';
import { serializeMarkdown } from './markdown/serialize';
import { serializePlainText } from './plain-text';
import { readOutlineFromJson, TableOfContents } from './table-of-contents';

/**
 * Issue #228: the table of contents is derived from the headings on every
 * change, never stored, and indents by the levels the page really uses.
 */

function heading(level: number, text: string, blockId: string): ProseMirrorNode {
  return {
    type: 'heading',
    attrs: { level, blockId },
    content: text.length === 0 ? [] : [{ type: 'text', text }],
  };
}

function paragraph(text: string): ProseMirrorNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function doc(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

const TOC: ProseMirrorNode = { type: 'tableOfContents' };

describe('table of contents node view', () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function mount(content: ProseMirrorDocument, minimal = false): Editor {
    editor = new Editor({
      // The minimal schema matters: with the full extension set some other
      // plugin's decorations happen to touch every node, which hid the stale
      // list. The view has to update on its own.
      extensions: minimal
        ? [Document, Paragraph, Text, Heading, TableOfContents]
        : buildEditorExtensions(),
      content,
    });
    return editor;
  }

  function rows(instance: Editor): string[] {
    return [...instance.view.dom.querySelectorAll('nav[data-toc] li')].map(
      (item) => `${(item as HTMLElement).dataset.depth ?? '?'}:${item.textContent ?? ''}`,
    );
  }

  it('follows a heading renamed further down, without its own node changing', () => {
    const instance = mount(doc(TOC, paragraph('x'), heading(2, 'Alt', 'aaaaaaaaaaaa')), true);
    expect(rows(instance)).toEqual(['0:Alt']);
    instance.commands.insertContentAt(instance.state.doc.content.size - 1, 'er');
    expect(rows(instance)).toEqual(['0:Alter']);
  });

  it('follows a heading added, moved and removed', () => {
    const instance = mount(
      doc(TOC, heading(2, 'Eins', 'aaaaaaaaaaaa'), heading(3, 'Zwei', 'bbbbbbbbbbbb')),
    );
    expect(rows(instance)).toEqual(['0:Eins', '1:Zwei']);
    instance.commands.setContent(
      doc(TOC, heading(3, 'Zwei', 'bbbbbbbbbbbb'), heading(2, 'Eins', 'aaaaaaaaaaaa')),
    );
    expect(rows(instance)).toEqual(['1:Zwei', '0:Eins']);
    instance.commands.setContent(doc(TOC, paragraph('nur Text')));
    expect(instance.view.dom.querySelector('nav[data-toc] .exocortex-toc-empty')).not.toBeNull();
  });

  it('links each entry to the stable block id of its heading', () => {
    const instance = mount(doc(TOC, heading(1, 'Ziel', 'cccccccccccc')));
    const anchor = instance.view.dom.querySelector('nav[data-toc] a');
    expect(anchor?.getAttribute('href')).toBe('#cccccccccccc');
  });

  it('stops listening when the block is removed', () => {
    const instance = mount(doc(TOC, heading(2, 'Eins', 'aaaaaaaaaaaa')));
    const nav = instance.view.dom.querySelector('nav[data-toc]');
    instance.commands.setContent(doc(heading(2, 'Eins', 'aaaaaaaaaaaa')));
    instance.commands.insertContentAt(instance.state.doc.content.size - 1, 's');
    // A destroyed view that still listened would redraw its detached list.
    expect(nav?.textContent).toBe('Eins');
  });
});

describe('readOutlineFromJson', () => {
  it('indents by the levels in use and leaves out empty headings', () => {
    const outline = readOutlineFromJson(
      doc(
        heading(2, 'Zwei', 'aaaaaaaaaaaa'),
        heading(4, 'Vier', 'bbbbbbbbbbbb'),
        heading(3, '', 'cccccccccccc'),
        heading(2, 'Wieder zwei', 'dddddddddddd'),
      ),
    );
    expect(outline.map((entry) => [entry.depth, entry.text, entry.blockId])).toEqual([
      [0, 'Zwei', 'aaaaaaaaaaaa'],
      [1, 'Vier', 'bbbbbbbbbbbb'],
      [0, 'Wieder zwei', 'dddddddddddd'],
    ]);
  });

  it('finds headings inside containers', () => {
    const outline = readOutlineFromJson(
      doc({ type: 'callout', content: [heading(2, 'Innen', 'aaaaaaaaaaaa')] }),
    );
    expect(outline.map((entry) => entry.text)).toEqual(['Innen']);
  });
});

describe('table of contents in Markdown and plain text', () => {
  it('round-trips as a marker and never carries the derived list', () => {
    const source = doc(heading(2, 'Kapitel', 'aaaaaaaaaaaa'), TOC);
    const markdown = serializeMarkdown(source);
    expect(markdown).toContain(':::toc\n:::');
    // The heading appears once: the list is not written out a second time.
    expect(markdown.split('Kapitel')).toHaveLength(2);
    const parsed = parseMarkdown(markdown, { assignBlockIds: false }).document;
    expect(parsed.content?.map((node) => node.type)).toEqual(['heading', 'tableOfContents']);
    expect(serializePlainText(source).split('Kapitel')).toHaveLength(2);
  });
});
