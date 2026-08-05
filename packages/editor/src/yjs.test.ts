import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { KITCHEN_SINK_MARKDOWN, TASK_LIST_MARKDOWN } from './fixtures';
import { parseMarkdown } from './markdown/parse';
import { serializeMarkdown } from './markdown/serialize';
import { collectBlockIds, serializePlainText } from './plain-text';
import { createEmptyDocument } from './schema';
import {
  createEmptyYjsState,
  markdownToYjsState,
  materializeYjsState,
  proseMirrorJsonToYjsState,
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
    expect(first.schemaVersion).toBe(1);
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
