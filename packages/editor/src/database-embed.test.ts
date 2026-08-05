// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { databaseEmbedBlocks } from './database-embed';
import { buildEditorExtensions } from './extensions';

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
