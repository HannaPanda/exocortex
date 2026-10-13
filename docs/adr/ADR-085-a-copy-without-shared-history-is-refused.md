# ADR-085: a copy without shared history is refused, not merged

- Status: accepted
- Date: 2026-10-13
- Relates to: ADR-004/005 (binary Yjs state is canonical), ADR-016 (writes reach the open session), ADR-029 (closing a connection to change what it may do)

## Context

Yjs never refuses a merge. Two documents that were built independently share
no item, so merging them keeps both: a page merged with an unrelated copy of
itself carries its content twice.

Until 2026-09-15 the API built a fresh Yjs state on every write instead of
editing the stored one. That was fixed, and the pages already doubled were
cleaned up, but the cause outlived the fix. Every browser that had read one of
those pages before its rewrite kept the old document in `y-indexeddb`, and the
first visit afterwards merges it in. On 2026-10-13 "MiniMax H3 in ComfyUI"
doubled four weeks after the write that made it vulnerable, the moment it was
opened. How many such copies are still lying in browsers cannot be known from
the server. A snapshot restored byte for byte (an older schema, or content
that does not apply) creates the same situation today.

## Decision

The collaboration server refuses an update that carries a document it has never
shared history with, in Hocuspocus's `beforeSync`, before anything is applied
(`apps/collaboration/src/foreign-history.ts`).

The test is exact. An item inserted into a list type is encoded with the
neighbours it was placed between. Only an item that met an empty list has
neither `origin` nor `rightOrigin`, and only that item names its root type. A
tombstone is a neighbour too, so an author who has seen even one deleted item
of the type writes an origin. When the stored root type has ever held an item,
a new item without both origins comes from a document that never saw this one.
Map entries are exempt: a foreign map overwrites keys and duplicates nothing.

The refusal closes the document's connection with the reason
`COLLABORATION_FOREIGN_HISTORY_REASON`. Hocuspocus transmits a per-document
close as reason text with code 1000, so the reason, not a code, is the signal.
The browser answers it by deleting its offline store and building the
connection again from an empty document, which loads the stored page.

The stored state always wins. Unsynced offline edits inside a foreign copy are
lost with it; they were made against a version of the page that the server no
longer has, and merging them is the defect this decision exists to prevent.

## Consequences

- Stale offline copies of pages rewritten before 2026-09-15 can no longer
  double a page, however long they lie in a browser. No one-off purge of the
  stores is needed.
- A byte-for-byte snapshot restore makes every open tab's copy foreign; those
  tabs are refused and reload instead of merging the old state back.
- A refusal is logged as `Refused an update without shared history` with the
  document and the user, and the browser's connection log records
  `offline.discard`.
