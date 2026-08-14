# ADR-007: Markdown is a derived interchange format

- Status: accepted
- Date: 2026-08-04

## Context

Markdown matters for import, export, backups, future filesystem synchronization and
external CLI agents. It is tempting to store it as the primary format because it is
human-readable and diffable.

## Decision

Markdown is derived, never canonical. There is exactly one editable representation:
the Yjs state (ADR-005).

- export: `serializeMarkdown(proseMirrorJson)` — deterministic, same input always
  produces the same bytes
- import: `markdownToYjsState(markdown)` — parses to ProseMirror JSON, validates it
  against the canonical schema and builds Yjs state, which becomes the new document's
  canonical state
- frontmatter: eXocortex keys in a fixed order, unknown keys preserved verbatim and
  written back
- raw HTML is rejected on import

## Consequences

- No merge problem between two editable formats, and no ambiguity about which one
  wins.
- Exact whitespace is not preserved on a round trip; semantic content is. This is
  asserted by 26 tests over seven fixtures, including a second round trip that must
  be byte-identical to the first.
- Markdown export is a read of derived data, so it is only as fresh as the last
  materialization. The export endpoint therefore derives from `yjsState` directly
  rather than reading the cached `markdown` column.
- Block identifiers survive a round trip only with `includeBlockIds: true`, because
  Markdown has no attribute syntax. The default export stays clean.
