import { calloutAttributes } from './callout';
import { type DocumentMigration, type ProseMirrorDocument } from './contract';
import { mapDocumentNodes } from './document-nodes';

/**
 * Schema version 6 turns the callout's variant into a symbol and a colour
 * (issue #306).
 *
 * A callout used to be one of five variants that differed in the colour of the
 * frame alone. Version 6 stores what the box shows instead: `emoji`, `title`
 * and `color`. Every variant becomes the symbol and the colour it stood for
 * (`warning` the warning sign in yellow, `note` the memo on the plain frame,
 * see `CALLOUT_KEYWORDS`); an existing heading stays exactly as it was, and
 * none is invented where there was none, because the symbol already says what
 * the variant said and a word written into somebody's page is content.
 *
 * Two forms of the same step. The JSON migration serves `migrateDocument`, for
 * a snapshot or a diff read from an older state. The Yjs one rewrites a stored
 * state in place, attribute by attribute, so the canonical state keeps its
 * history and nothing is rebuilt from a derived form (ADR-004/005); the
 * collaboration server applies it to every page it loads, and
 * `documents:migrate` to every page at once.
 */
export const SCHEMA_V6_MIGRATION: DocumentMigration = {
  fromVersion: 5,
  toVersion: 6,
  description: 'schema 6: callouts carry a symbol, a heading and a colour instead of a variant',
  migrate: (document: ProseMirrorDocument): ProseMirrorDocument =>
    mapDocumentNodes(document, (node) => {
      if (node.type !== 'callout') return node;
      const attrs = node.attrs ?? {};
      if (!needsCalloutMigration(attrs)) return node;
      return { ...node, attrs: calloutAttributes(attrs) };
    }),
};

/** Whether a callout's attributes still have the shape from before #306. */
export function needsCalloutMigration(attrs: Readonly<Record<string, unknown>>): boolean {
  const variant = attrs.variant;
  const emoji = attrs.emoji;
  return (
    (typeof variant === 'string' && variant.length > 0) ||
    typeof emoji !== 'string' ||
    emoji.length === 0
  );
}
