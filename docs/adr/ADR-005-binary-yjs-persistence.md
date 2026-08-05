# ADR-005: Binary Yjs state is the canonical persistence format

* Status: accepted
* Date: 2026-08-04

## Context

A collaborative document can be stored as the Yjs update log, as ProseMirror JSON,
as HTML or as Markdown. Only the Yjs state contains the CRDT metadata that makes
concurrent and offline edits mergeable.

## Decision

`DocumentContent.yjsState` (`Bytes`) is canonical. It is written and read verbatim
through the Hocuspocus `Database` extension and is **never** rebuilt from derived
data during normal loading.

ProseMirror JSON, plain text and Markdown are derived columns next to it, produced
by the `document-materialization` job and freely rebuildable. HTML is never stored.

Writes are debounced twice — in Hocuspocus (2 s, cap 10 s) and in the queue (2 s, cap
15 s) — so a burst of keystrokes produces one database write and one job.

## Consequences

* Concurrent and offline edits merge correctly, and the state survives a full server
  restart (verified by an integration test that destroys and recreates the server).
* Reconstructing state from JSON would drop the CRDT history and cause duplicated or
  lost content on the next merge; the code path does not exist.
* Derived data is eventually consistent by seconds. The UI shows this through the
  job-progress indicator and the "zuletzt verarbeitet" property.
* Snapshots store the same binary format, so restoring one is a byte-level operation
  rather than a lossy re-parse.
* `DocumentContent` carries an extra `yjsUpdatedAt` column beyond the fields in the
  brief; it is what makes materialization idempotent.
