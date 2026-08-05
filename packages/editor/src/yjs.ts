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
  } finally {
    doc.destroy();
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

/**
 * Converts a Markdown file into a Yjs-backed document. The Yjs state produced
 * here becomes the canonical state of the new document.
 */
export function markdownToYjsState(markdown: string): MarkdownImportResult {
  const parsed = parseMarkdown(markdown);
  const yjsState = proseMirrorJsonToYjsState(parsed.document);
  return {
    yjsState,
    proseMirrorJson: parsed.document,
    plainText: serializePlainText(parsed.document),
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
