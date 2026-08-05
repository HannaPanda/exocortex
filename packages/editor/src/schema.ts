import { getSchema } from '@tiptap/core';
import { type Schema } from '@tiptap/pm/model';

import { type ProseMirrorDocument } from './contract';
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

/** An empty but valid document. */
export function createEmptyDocument(): ProseMirrorDocument {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}
