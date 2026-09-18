import { getSchema } from '@tiptap/core';
import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';

import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { buildEditorExtensions } from './extensions';

let cachedSchema: Schema | null = null;

/**
 * The canonical ProseMirror schema, derived from the extension registry.
 *
 * Available on the server too: `getSchema` works without a DOM, which is what
 * makes headless materialization and Markdown import possible.
 */
export function getExocortexSchema(): Schema {
  if (cachedSchema === null) {
    cachedSchema = getSchema(buildEditorExtensions());
  }
  return cachedSchema;
}

/** All node type names of the canonical schema. */
export function getSchemaNodeNames(): string[] {
  return Object.keys(getExocortexSchema().nodes).sort();
}

/** All mark type names of the canonical schema. */
export function getSchemaMarkNames(): string[] {
  return Object.keys(getExocortexSchema().marks).sort();
}

export interface DocumentValidationResult {
  valid: boolean;
  /** Developer-facing English error message when invalid. */
  error?: string;
}

/**
 * Validates ProseMirror JSON against the canonical schema. Used by Markdown
 * import so a malformed document is rejected before it becomes canonical Yjs
 * state.
 */
export function validateProseMirrorDocument(
  document: ProseMirrorDocument,
): DocumentValidationResult {
  try {
    const node = getExocortexSchema().nodeFromJSON(document);
    node.check();
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Rebuilds one node, inserting whatever the schema requires around its
 * children. Returns `null` when no arrangement of them is valid.
 */
function repairNode(json: ProseMirrorNode, schema: Schema): PMNode | null {
  if (json.type === 'text') {
    try {
      return schema.nodeFromJSON(json);
    } catch {
      return null;
    }
  }

  const nodeType = schema.nodes[json.type];
  if (nodeType === undefined) return null;

  const children: PMNode[] = [];
  for (const child of json.content ?? []) {
    const repaired = repairNode(child, schema);
    if (repaired !== null) children.push(repaired);
  }

  try {
    const marks = (json.marks ?? []).map((mark) => schema.markFromJSON(mark));
    // `createAndFill` is the schema answering the question itself: it inserts
    // the nodes that have to come before and after this content for the node to
    // be valid, and nothing else.
    return nodeType.createAndFill(json.attrs ?? null, Fragment.fromArray(children), marks);
  } catch {
    return null;
  }
}

/**
 * Makes a document schema-valid by inserting what the schema itself demands.
 *
 * Markdown can describe structures the canonical schema forbids, and they are
 * not exotic: a line consisting of a single `-` is a list with one empty item,
 * which in prose is a scene break or a dash that went wrong. `Node.check()`
 * refused that with `Invalid content for node listItem: <>`, and because a
 * write validates the whole document, one such character rejected an entire
 * page -- including, in `append` mode, content that had nothing to do with it
 * (issue #82).
 *
 * The repair adds; it does not rewrite. A node that cannot be made valid with
 * any filler is dropped, which loses that one node instead of the write. A
 * document that is already valid is returned untouched, which is the normal
 * case and the reason this costs one schema pass and no more.
 */
export function repairProseMirrorDocument(document: ProseMirrorDocument): ProseMirrorDocument {
  if (validateProseMirrorDocument(document).valid) return document;
  const repaired = repairNode(document, getExocortexSchema());
  if (repaired === null) return document;
  return repaired.toJSON() as ProseMirrorDocument;
}

/** An empty but valid document. */
export function createEmptyDocument(): ProseMirrorDocument {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}
