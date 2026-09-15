import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { EXOCORTEX_SCHEMA_VERSION } from './contract';
import { KITCHEN_SINK_MARKDOWN, TASK_LIST_MARKDOWN } from './fixtures';
import { parseMarkdown } from './markdown/parse';
import { serializeMarkdown } from './markdown/serialize';
import { collectBlockIds, serializePlainText } from './plain-text';
import { createEmptyDocument } from './schema';
import {
  applyProseMirrorDocumentToYDoc,
  createEmptyYjsState,
  markdownToYjsState,
  materializeYjsState,
  proseMirrorJsonToYjsState,
  trimStrayParagraphs,
  YJS_DOCUMENT_FIELD,
  YjsMaterializationError,
  yjsStateToMarkdown,
  yjsStateToProseMirrorJson,
} from './yjs';

describe('Yjs state conversion', () => {
  it('creates a valid empty state', () => {
    const state = createEmptyYjsState();
    expect(state.byteLength).toBeGreaterThan(0);
    expect(yjsStateToProseMirrorJson(state)).toEqual(createEmptyDocument());
  });

  it('round-trips ProseMirror JSON through binary Yjs state', () => {
    const { document } = parseMarkdown(KITCHEN_SINK_MARKDOWN);
    const state = proseMirrorJsonToYjsState(document);
    const derived = yjsStateToProseMirrorJson(state);
    expect(serializePlainText(derived)).toBe(serializePlainText(document));
    expect(collectBlockIds(derived).sort()).toEqual(collectBlockIds(document).sort());
  });

  it('preserves the exact binary state across encode/decode', () => {
    const state = markdownToYjsState(KITCHEN_SINK_MARKDOWN).yjsState;

    // Simulate a server restart: the stored bytes are applied to a fresh doc.
    const restored = new Y.Doc();
    Y.applyUpdate(restored, state);
    const reencoded = Y.encodeStateAsUpdate(restored);

    expect(yjsStateToProseMirrorJson(reencoded)).toEqual(yjsStateToProseMirrorJson(state));
    expect(restored.get(YJS_DOCUMENT_FIELD, Y.XmlFragment).length).toBeGreaterThan(0);
    restored.destroy();
  });

  it('rejects an invalid document instead of writing broken state', () => {
    expect(() =>
      proseMirrorJsonToYjsState({ type: 'doc', content: [{ type: 'notARealNode' }] }),
    ).toThrowError(YjsMaterializationError);
  });

  it('derives ProseMirror JSON, plain text and Markdown deterministically', () => {
    const state = markdownToYjsState(KITCHEN_SINK_MARKDOWN).yjsState;
    const first = materializeYjsState(state);
    const second = materializeYjsState(state);
    expect(second).toEqual(first);
    expect(first.plainText).toContain('Vollständiges Beispiel');
    expect(first.markdown).toContain('## Listen');
    expect(first.schemaVersion).toBe(EXOCORTEX_SCHEMA_VERSION);
  });

  it('exports Markdown straight from binary state', () => {
    const { yjsState } = markdownToYjsState(TASK_LIST_MARKDOWN);
    const markdown = yjsStateToMarkdown(yjsState);
    expect(markdown).toContain('- [x] Fertig');
  });

  it('keeps the imported title and frontmatter', () => {
    const result = markdownToYjsState(KITCHEN_SINK_MARKDOWN);
    expect(result.title).toBe('Vollständiges Beispiel');
    expect(result.frontmatter.unknown.customProperty).toBe('bleibt erhalten');
  });
});

describe('applying content to a live document', () => {
  /** The state a loaded Hocuspocus document would be in. */
  function liveDocument(markdown: string): Y.Doc {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, markdownToYjsState(markdown).yjsState);
    return doc;
  }

  function markdownOf(doc: Y.Doc): string {
    return serializeMarkdown(yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(doc)));
  }

  it('replaces the whole content', () => {
    const doc = liveDocument('# Alt\n\nAlter Absatz.\n');
    applyProseMirrorDocumentToYDoc(doc, parseMarkdown('# Neu\n\nNeuer Absatz.\n').document);

    const markdown = markdownOf(doc);
    expect(markdown).toContain('Neuer Absatz.');
    expect(markdown).not.toContain('Alter Absatz.');
    doc.destroy();
  });

  it('appends and prepends without touching what is already there', () => {
    const doc = liveDocument('Mitte.\n');
    applyProseMirrorDocumentToYDoc(doc, parseMarkdown('Ende.\n').document, 'append');
    applyProseMirrorDocumentToYDoc(doc, parseMarkdown('Anfang.\n').document, 'prepend');

    expect(serializePlainText(yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(doc)))).toBe(
      'Anfang.\nMitte.\nEnde.',
    );
    doc.destroy();
  });

  it('emits exactly one update, so clients never see an empty document', () => {
    const doc = liveDocument('# Alt\n');
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));

    applyProseMirrorDocumentToYDoc(doc, parseMarkdown(KITCHEN_SINK_MARKDOWN).document);

    expect(updates).toHaveLength(1);
    doc.destroy();
  });

  /**
   * The reason `append` inserts instead of rewriting: an agent writing to a page
   * somebody has open must not undo what that person just typed.
   */
  it('keeps a concurrent edit that arrives while the content is appended', () => {
    const editor = liveDocument('Bestehender Absatz.\n');
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(editor));

    // The human types locally; the update has not reached the server yet.
    const typed = new Y.XmlElement('paragraph');
    typed.insert(0, [new Y.XmlText('Gerade getippt.')]);
    editor.get(YJS_DOCUMENT_FIELD, Y.XmlFragment).insert(1, [typed]);

    applyProseMirrorDocumentToYDoc(server, parseMarkdown('Vom Agenten.\n').document, 'append');

    // Now both sides sync, as Hocuspocus would.
    const fromEditor = Y.encodeStateAsUpdate(editor, Y.encodeStateVector(server));
    const fromServer = Y.encodeStateAsUpdate(server, Y.encodeStateVector(editor));
    Y.applyUpdate(server, fromEditor);
    Y.applyUpdate(editor, fromServer);

    const merged = serializePlainText(yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(editor)));
    expect(merged).toContain('Bestehender Absatz.');
    expect(merged).toContain('Gerade getippt.');
    expect(merged).toContain('Vom Agenten.');
    expect(merged).toBe(
      serializePlainText(yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(server))),
    );

    editor.destroy();
    server.destroy();
  });

  it('refuses an invalid document instead of clearing the live one', () => {
    const doc = liveDocument('# Bleibt stehen\n');
    expect(() =>
      applyProseMirrorDocumentToYDoc(doc, { type: 'doc', content: [{ type: 'notARealNode' }] }),
    ).toThrowError(YjsMaterializationError);
    expect(markdownOf(doc)).toContain('Bleibt stehen');
    doc.destroy();
  });
});

describe('concurrent Yjs updates', () => {
  /**
   * Simulates two clients editing the same document offline and syncing
   * afterwards. This is the property the collaboration server relies on: merging
   * updates never loses either side's changes.
   */
  it('merges concurrent updates from two clients without losing content', () => {
    const base = markdownToYjsState('# Basis\n\nErster Absatz.\n').yjsState;

    const clientA = new Y.Doc();
    Y.applyUpdate(clientA, base);
    const clientB = new Y.Doc();
    Y.applyUpdate(clientB, base);

    const fragmentA = clientA.get(YJS_DOCUMENT_FIELD, Y.XmlFragment);
    const paragraphA = new Y.XmlElement('paragraph');
    paragraphA.insert(0, [new Y.XmlText('Von Client A')]);
    fragmentA.insert(fragmentA.length, [paragraphA]);

    const fragmentB = clientB.get(YJS_DOCUMENT_FIELD, Y.XmlFragment);
    const paragraphB = new Y.XmlElement('paragraph');
    paragraphB.insert(0, [new Y.XmlText('Von Client B')]);
    fragmentB.insert(fragmentB.length, [paragraphB]);

    // Exchange updates in both directions, as Hocuspocus would.
    const updateA = Y.encodeStateAsUpdate(clientA, Y.encodeStateVector(clientB));
    const updateB = Y.encodeStateAsUpdate(clientB, Y.encodeStateVector(clientA));
    Y.applyUpdate(clientB, updateA);
    Y.applyUpdate(clientA, updateB);

    const mergedA = serializePlainText(yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(clientA)));
    const mergedB = serializePlainText(yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(clientB)));

    expect(mergedA).toBe(mergedB);
    expect(mergedA).toContain('Von Client A');
    expect(mergedA).toContain('Von Client B');

    clientA.destroy();
    clientB.destroy();
  });

  it('is idempotent when the same update is applied twice', () => {
    const state = markdownToYjsState('# Titel\n\nText.\n').yjsState;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const once = serializeMarkdown(yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(doc)));
    Y.applyUpdate(doc, state);
    const twice = serializeMarkdown(yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(doc)));
    expect(twice).toBe(once);
    doc.destroy();
  });
});

describe('trimStrayParagraphs', () => {
  const paragraph = (text?: string) =>
    text === undefined
      ? { type: 'paragraph' }
      : { type: 'paragraph', content: [{ type: 'text', text }] };

  it('removes the empty paragraphs above and below the content', () => {
    const state = proseMirrorJsonToYjsState({
      type: 'doc',
      content: [paragraph(), paragraph(), paragraph('Inhalt'), paragraph()],
    });

    const trimmed = trimStrayParagraphs(state);

    expect(trimmed).toMatchObject({ leading: 2, trailing: 1 });
    expect(yjsStateToProseMirrorJson(trimmed.yjsState as Uint8Array).content).toHaveLength(1);
  });

  it('keeps a blank line that sits between two blocks', () => {
    const state = proseMirrorJsonToYjsState({
      type: 'doc',
      content: [paragraph('Oben'), paragraph(), paragraph('Unten')],
    });

    expect(trimStrayParagraphs(state).yjsState).toBeNull();
  });

  it('leaves one paragraph in a document that is nothing else', () => {
    const state = proseMirrorJsonToYjsState({
      type: 'doc',
      content: [paragraph(), paragraph(), paragraph()],
    });

    const trimmed = trimStrayParagraphs(state);

    expect(trimmed).toMatchObject({ leading: 2, trailing: 0 });
    expect(yjsStateToProseMirrorJson(trimmed.yjsState as Uint8Array).content).toHaveLength(1);
  });

  it('is idempotent', () => {
    const state = proseMirrorJsonToYjsState({
      type: 'doc',
      content: [paragraph(), paragraph('Inhalt')],
    });

    const once = trimStrayParagraphs(state).yjsState as Uint8Array;
    expect(trimStrayParagraphs(once).yjsState).toBeNull();
  });
});
