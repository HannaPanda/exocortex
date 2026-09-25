import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import { EXOCORTEX_SCHEMA_VERSION, type ProseMirrorDocument } from './contract';
import { type Frontmatter } from './markdown/frontmatter';
import { parseMarkdown } from './markdown/parse';
import { serializeMarkdown, type SerializeMarkdownOptions } from './markdown/serialize';
import { serializePlainText } from './plain-text';
import { createEmptyDocument, getExocortexSchema, validateProseMirrorDocument } from './schema';

/**
 * Name of the Yjs XmlFragment that holds the ProseMirror document.
 *
 * `y-prosemirror` and the Tiptap `Collaboration` extension must agree on this
 * value, otherwise a document loads as empty. It is exported so the client, the
 * collaboration server and the worker all use the same constant.
 */
export const YJS_DOCUMENT_FIELD = 'default';

export class YjsMaterializationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'YjsMaterializationError';
  }
}

/** Applies a binary Yjs update to a fresh document. */
export function yjsStateToDocument(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  if (state.byteLength > 0) {
    Y.applyUpdate(doc, state);
  }
  return doc;
}

/**
 * Derives ProseMirror JSON from the canonical binary Yjs state.
 *
 * This is a *derivation*: the Yjs state is never rebuilt from the JSON during
 * normal loading (ADR-005).
 */
export function yjsStateToProseMirrorJson(state: Uint8Array): ProseMirrorDocument {
  const doc = yjsStateToDocument(state);
  try {
    return yDocToProseMirrorJson(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * The same derivation for a `Y.Doc` that is already open, such as the living
 * document in the collaboration server. The document is read, never destroyed:
 * it belongs to whoever opened it.
 */
export function yDocToProseMirrorJson(doc: Y.Doc): ProseMirrorDocument {
  try {
    // y-prosemirror is untyped at this boundary; convert through `unknown`
    // instead of introducing `any` into Exocortex code.
    const json = yDocToProsemirrorJSON(doc, YJS_DOCUMENT_FIELD) as unknown;
    const document = json as ProseMirrorDocument;
    if (document.type !== 'doc') {
      throw new YjsMaterializationError(
        `Expected a "doc" node from the Yjs state, received "${String(document.type)}"`,
      );
    }
    if ((document.content ?? []).length === 0) return createEmptyDocument();
    return document;
  } catch (error) {
    if (error instanceof YjsMaterializationError) throw error;
    throw new YjsMaterializationError('Failed to derive ProseMirror JSON from Yjs state', {
      cause: error,
    });
  }
}

/**
 * Builds binary Yjs state from ProseMirror JSON.
 *
 * Only used when a document is *created* (Markdown import, seeding, snapshot
 * restore fallback), never on every load.
 */
export function proseMirrorJsonToYjsState(document: ProseMirrorDocument): Uint8Array {
  const validation = validateProseMirrorDocument(document);
  if (!validation.valid) {
    throw new YjsMaterializationError(
      `Refusing to build Yjs state from an invalid document: ${validation.error ?? 'unknown reason'}`,
    );
  }
  const doc = prosemirrorJSONToYDoc(getExocortexSchema(), document, YJS_DOCUMENT_FIELD);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** Binary state of an empty but valid document. */
export function createEmptyYjsState(): Uint8Array {
  return proseMirrorJsonToYjsState(createEmptyDocument());
}

/** Where content lands when it is applied to a document that already exists. */
export type YjsApplyMode = 'replace' | 'append' | 'prepend';

/**
 * Applies a ProseMirror document into an *existing, live* `Y.Doc`.
 *
 * This is the counterpart to `proseMirrorJsonToYjsState`: that one builds a
 * brand-new state and is only correct while nobody is editing, this one is a
 * regular Yjs edit on a document that may have readers and writers attached
 * right now. It is how a write that did not come from the editor (the REST
 * content endpoint, MCP, the built-in AI, a snapshot restore) reaches an open
 * collaborative session instead of racing it (ADR-016).
 *
 * `append` and `prepend` deliberately insert *only* the new nodes rather than
 * rewriting the whole fragment: everything the humans in the session typed in
 * the meantime survives, because it is never deleted in the first place.
 * `replace` is the only mode that removes existing content, which is exactly
 * what the caller asked for.
 */
export function applyProseMirrorDocumentToYDoc(
  target: Y.Doc,
  document: ProseMirrorDocument,
  mode: YjsApplyMode = 'replace',
): void {
  const validation = validateProseMirrorDocument(document);
  if (!validation.valid) {
    throw new YjsMaterializationError(
      `Refusing to apply an invalid document: ${validation.error ?? 'unknown reason'}`,
    );
  }

  const source = prosemirrorJSONToYDoc(getExocortexSchema(), document, YJS_DOCUMENT_FIELD);
  try {
    // Detached copies: `clone()` deep-copies element attributes, children and
    // text formatting, which is what makes them insertable into another
    // document. `Y.XmlHook` cannot occur here (the Exocortex schema has no hook
    // nodes and y-prosemirror never emits one), but the type says it can, so it
    // is filtered instead of cast away.
    const nodes = source
      .getXmlFragment(YJS_DOCUMENT_FIELD)
      .toArray()
      .filter(
        (node): node is Y.XmlElement | Y.XmlText =>
          node instanceof Y.XmlElement || node instanceof Y.XmlText,
      )
      .map((node) => node.clone());

    // One transaction, so connected clients receive a single update and the
    // document is never briefly empty for anyone.
    target.transact(() => {
      const fragment = target.getXmlFragment(YJS_DOCUMENT_FIELD);
      if (mode === 'replace') fragment.delete(0, fragment.length);
      fragment.insert(mode === 'prepend' ? 0 : fragment.length, nodes);
    });
  } finally {
    source.destroy();
  }
}

/** What a write leaves behind: the new state and the two views derived from it. */
export interface AppliedDocumentState {
  /** The stored state with the write applied as an edit, history intact. */
  yjsState: Uint8Array;
  /** ProseMirror JSON derived from that state, not from the input. */
  proseMirrorJson: ProseMirrorDocument;
  /** Plain text derived from the same state. */
  plainText: string;
}

/**
 * Applies a ProseMirror document to *stored* binary state and returns the new
 * state.
 *
 * This is what a write that does not come from the editor must use. Building
 * fresh state with `proseMirrorJsonToYjsState` and storing that instead looks
 * equivalent -- the page reads back exactly the same -- but it throws the
 * document's identity away: the new state shares no history with the old one,
 * so the old content is not *deleted*, it is merely absent. Any copy of the
 * previous document that shows up afterwards (a browser tab holding it in
 * memory, an `y-indexeddb` store, a collaboration session that loaded before
 * the write) merges as an unrelated document, and Yjs keeps both sides: the
 * page ends up carrying its content twice.
 *
 * Editing the stored state instead leaves tombstones for everything `replace`
 * removed, which is what makes a late-arriving copy converge on the write
 * rather than resurrect what it replaced.
 */
export function applyProseMirrorDocumentToState(
  state: Uint8Array,
  document: ProseMirrorDocument,
  mode: YjsApplyMode = 'replace',
): AppliedDocumentState {
  const doc = yjsStateToDocument(state);
  try {
    applyProseMirrorDocumentToYDoc(doc, document, mode);
    const yjsState = Y.encodeStateAsUpdate(doc);
    const proseMirrorJson = yjsStateToProseMirrorJson(yjsState);
    return { yjsState, proseMirrorJson, plainText: serializePlainText(proseMirrorJson) };
  } finally {
    doc.destroy();
  }
}

export interface TrimStrayParagraphsResult {
  /** Empty paragraphs removed from the top of the document. */
  leading: number;
  /** Empty paragraphs removed from the bottom. */
  trailing: number;
  /** The new binary state, or `null` when there was nothing to remove. */
  yjsState: Uint8Array | null;
}

/** An `XmlElement` that is a paragraph with nothing in it. */
function isEmptyParagraph(node: Y.XmlElement | Y.XmlFragment | Y.XmlText | Y.XmlHook): boolean {
  return node instanceof Y.XmlElement && node.nodeName === 'paragraph' && node.length === 0;
}

/**
 * Removes the runs of empty paragraphs at the very top and the very bottom of a
 * stored document.
 *
 * They are not something anyone typed. Until the editor waited for the stored
 * state to arrive, opening a page built Tiptap over a Yjs fragment that was
 * still empty; Tiptap pushed its own initial document into it, and Yjs merged
 * that insert with the content that landed a moment later rather than
 * discarding it. One empty paragraph per visit, above or below the text
 * depending on where the client id sorted -- which is why the pages that are
 * read most had grown the widest margins of blank lines.
 *
 * Empty paragraphs *between* two blocks are left alone: a blank line somebody
 * put between two sections is content. A document that is nothing but empty
 * paragraphs keeps exactly one, because a page needs a block to put the caret
 * in.
 */
export function trimStrayParagraphs(state: Uint8Array): TrimStrayParagraphsResult {
  const doc = yjsStateToDocument(state);
  try {
    const fragment = doc.getXmlFragment(YJS_DOCUMENT_FIELD);
    const nodes = fragment.toArray();

    let leading = 0;
    while (leading < nodes.length && isEmptyParagraph(nodes[leading] as Y.XmlElement)) leading += 1;
    let trailing = 0;
    if (leading === nodes.length) {
      // Nothing but blank paragraphs: one of them stays.
      leading = Math.max(0, leading - 1);
    } else {
      while (
        trailing < nodes.length - leading - 1 &&
        isEmptyParagraph(nodes[nodes.length - 1 - trailing] as Y.XmlElement)
      ) {
        trailing += 1;
      }
    }

    if (leading === 0 && trailing === 0) return { leading, trailing, yjsState: null };

    doc.transact(() => {
      // The tail first: deleting the head would move its indexes.
      if (trailing > 0) fragment.delete(fragment.length - trailing, trailing);
      if (leading > 0) fragment.delete(0, leading);
    });
    return { leading, trailing, yjsState: Y.encodeStateAsUpdate(doc) };
  } finally {
    doc.destroy();
  }
}

export interface MaterializedContent {
  proseMirrorJson: ProseMirrorDocument;
  plainText: string;
  markdown: string;
  schemaVersion: number;
}

/**
 * Derives every non-canonical representation from the canonical Yjs state.
 * Deterministic and side-effect free, which is what makes the materialization
 * job idempotent.
 */
export function materializeYjsState(
  state: Uint8Array,
  options: { markdown?: SerializeMarkdownOptions } = {},
): MaterializedContent {
  const proseMirrorJson = yjsStateToProseMirrorJson(state);
  return {
    proseMirrorJson,
    plainText: serializePlainText(proseMirrorJson),
    markdown: serializeMarkdown(proseMirrorJson, options.markdown),
    schemaVersion: EXOCORTEX_SCHEMA_VERSION,
  };
}

export interface MarkdownImportResult {
  yjsState: Uint8Array;
  proseMirrorJson: ProseMirrorDocument;
  plainText: string;
  title: string | null;
  frontmatter: Frontmatter;
  schemaVersion: number;
}

export interface MarkdownImportOptions {
  /**
   * Runs over the parsed document before it becomes canonical Yjs state.
   *
   * The one seam the import needs and this package cannot fill itself:
   * `[[Titel]]` carries no identity, so binding it to a document
   * (`bindPageLinkIdentities`) requires a workspace and a database. The caller
   * supplies that; the transform stays pure.
   */
  transformDocument?: (document: ProseMirrorDocument) => ProseMirrorDocument;
}

/**
 * Converts a Markdown file into a Yjs-backed document. The Yjs state produced
 * here becomes the canonical state of the new document.
 */
export function markdownToYjsState(
  markdown: string,
  options: MarkdownImportOptions = {},
): MarkdownImportResult {
  const parsed = parseMarkdown(markdown);
  const document =
    options.transformDocument === undefined
      ? parsed.document
      : options.transformDocument(parsed.document);
  const yjsState = proseMirrorJsonToYjsState(document);
  return {
    yjsState,
    proseMirrorJson: document,
    plainText: serializePlainText(document),
    title: parsed.title,
    frontmatter: parsed.frontmatter,
    schemaVersion: EXOCORTEX_SCHEMA_VERSION,
  };
}

/** Convenience wrapper used by the Markdown export endpoint. */
export function yjsStateToMarkdown(
  state: Uint8Array,
  options: SerializeMarkdownOptions = {},
): string {
  return serializeMarkdown(yjsStateToProseMirrorJson(state), options);
}
