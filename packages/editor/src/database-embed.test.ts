// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { type ProseMirrorDocument } from './contract';
import { databaseEmbedBlocks } from './database-embed';
import { buildEditorExtensions } from './extensions';
import { parseMarkdown, serializeMarkdown } from './markdown';
import { bindPageLinkIdentities, resolvePageLinkTitles } from './page-link-identity';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function insertViaCommand(): void {
  editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
  editor.commands.insertDatabaseEmbed('doc123', 'Aufgaben');
}

describe('database embed node', () => {
  it('stores the id, the frozen title, and no pinned view by default', () => {
    insertViaCommand();
    const node = editor?.getJSON().content?.find((entry) => entry.type === 'databaseEmbed');
    expect(node?.attrs).toMatchObject({ documentId: 'doc123', title: 'Aufgaben', viewId: null });
  });

  it('renders the frozen title as a static fallback before a node view mounts', () => {
    insertViaCommand();
    const fallback = editor?.view.dom.querySelector('[data-database-embed]');
    expect(fallback?.textContent).toBe('Aufgaben');
    expect(fallback?.getAttribute('data-document-id')).toBe('doc123');
  });

  it('is addressable and cannot be turned into from another block', () => {
    const entry = databaseEmbedBlocks[0];
    expect(entry?.turnInto).toBe(false);
  });
});

describe('database embed catalog entry', () => {
  it('does nothing without a picked database', () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    const entry = databaseEmbedBlocks[0];
    expect(entry?.run(editor, undefined)).toBe(false);
    expect(entry?.run(editor, '')).toBe(false);
  });

  it('inserts the node once a database is picked, decoding the JSON payload', () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    const entry = databaseEmbedBlocks[0];
    const applied = entry?.run(editor, JSON.stringify({ documentId: 'doc456', title: 'Projekte' }));
    expect(applied).toBe(true);
    const node = editor?.getJSON().content?.find((candidate) => candidate.type === 'databaseEmbed');
    expect(node?.attrs?.documentId).toBe('doc456');
    expect(node?.attrs?.title).toBe('Projekte');
  });
});

/*
 * The way an agent embeds a database (issue #226): it writes the block in
 * Markdown by the database's title, and the import binds that title to a
 * database, never to a page that happens to carry the same name.
 */
describe('database embed identity', () => {
  const embedOf = (markdown: string) =>
    parseMarkdown(markdown).document.content?.find((node) => node.type === 'databaseEmbed');

  it('binds a title to a database through the database lookup only', () => {
    const parsed = parseMarkdown(':::database-embed Aufgaben\n:::\n');
    const bound = bindPageLinkIdentities(
      parsed.document,
      () => 'page-with-the-same-title',
      (title) => (title === 'Aufgaben' ? 'db1' : null),
    );
    const node = bound.content?.find((entry) => entry.type === 'databaseEmbed');
    expect(node?.attrs).toMatchObject({ documentId: 'db1', title: 'Aufgaben', viewId: null });
  });

  it('stays unbound without a database lookup or a database of that title', () => {
    const parsed = parseMarkdown(':::database-embed Aufgaben\n:::\n');
    const withoutLookup = bindPageLinkIdentities(parsed.document, () => 'page1');
    const withoutMatch = bindPageLinkIdentities(
      parsed.document,
      () => 'page1',
      () => null,
    );
    for (const document of [withoutLookup, withoutMatch]) {
      const node = document.content?.find((entry) => entry.type === 'databaseEmbed');
      expect(node?.attrs?.documentId).toBe('');
    }
  });

  it('keeps an embed that already shows a database', () => {
    const stored: ProseMirrorDocument = {
      type: 'doc',
      content: [
        { type: 'databaseEmbed', attrs: { documentId: 'db1', title: 'Aufgaben', viewId: 'v1' } },
      ],
    };
    const bound = bindPageLinkIdentities(
      stored,
      () => 'x',
      () => 'db2',
    );
    expect(bound.content?.[0]?.attrs).toMatchObject({ documentId: 'db1', viewId: 'v1' });
  });

  it('exports the title the database carries now', () => {
    const stored: ProseMirrorDocument = {
      type: 'doc',
      content: [
        { type: 'databaseEmbed', attrs: { documentId: 'db1', title: 'Alt', viewId: null } },
      ],
    };
    const markdown = serializeMarkdown(resolvePageLinkTitles(stored, () => 'Neu'));
    expect(markdown).toContain(':::database-embed Neu');
    expect(embedOf(markdown)?.attrs?.title).toBe('Neu');
  });
});
