# ADR-003: Tiptap and ProseMirror as the editor foundation

- Status: accepted
- Date: 2026-08-04

## Context

The editor must support a rich but _constrained_ schema, collaborative editing,
headless server-side processing (Markdown import, materialization) and stable block
identities for future per-block features (comments, backlinks, embeddings).

## Decision

ProseMirror as the document model, Tiptap 3 as the extension and command layer.
`packages/editor` owns the canonical schema through an explicit
`ExocortexEditorExtension` contract; React components consume
`buildEditorExtensions()` and never define schema-relevant extensions.

Block identity is an explicit `blockId` attribute maintained by a ProseMirror plugin.
Identity is never derived from document offsets, Markdown line numbers or array
indexes, because all three change when unrelated content changes.

## Consequences

- `getSchema()` works without a DOM, so the worker and the API can parse and
  serialize documents headlessly. This is what makes Markdown import and
  materialization possible outside the browser.
- Every schema change is a versioned change: `EXOCORTEX_SCHEMA_VERSION` is stored
  with each document and each snapshot, and migrations are registered per extension.
- Adding a node touches one file plus a fixture; the round-trip test iterates all
  fixtures automatically.
- Tiptap's own extension packages are consumed individually rather than through
  `StarterKit`, so the schema contains exactly the declared nodes and marks.
