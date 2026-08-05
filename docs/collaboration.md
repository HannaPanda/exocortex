# Collaboration

## Model

* **One Yjs document per Exocortex document.** Never one per workspace: that would
  load unrelated content into memory, leak content across permissions and make
  awareness meaningless.
* The Yjs `XmlFragment` is named `default` (`YJS_DOCUMENT_FIELD`). Client, server
  and worker import the same constant; a mismatch would silently load an empty
  document.
* The canonical state is the **binary Yjs update** in `DocumentContent.yjsState`.
  It is stored and loaded byte for byte and never rebuilt from derived data during
  normal loading (ADR-005).

## Connection sequence

1. `POST /api/documents/:documentId/collaboration-ticket` — the API resolves the
   caller's role, derives the access mode with `resolveCollaborationAccess` and
   returns `{ ticket, documentName, access, expiresAt, collaborationUrl }`.
2. The client opens a `HocuspocusProvider` against `PUBLIC_COLLABORATION_URL` with
   `name = documentName` and `token = ticket`.
3. `onAuthenticate` verifies the ticket (signature, expiry, document scope),
   re-checks membership and archival state, computes
   `min(ticketAccess, policyAccess)` and sets `connectionConfig.readOnly` for read
   access.
4. `y-indexeddb` restores the local copy immediately, so the editor is usable before
   the socket is open.

## Persistence

`@hocuspocus/extension-database` with our `DocumentPersistence`:

* `fetch` returns the stored `Bytes` verbatim, or `null` for a fresh document.
* `store` refuses unknown and archived documents, writes `yjsState` plus
  `yjsUpdatedAt`, and enqueues a debounced `document-materialization` job.

Two debounce layers:

| Layer | Setting | Purpose |
| ----- | ------- | ------- |
| Hocuspocus | `debounce: 2000`, `maxDebounce: 10000` | one database write per burst of edits |
| BullMQ | `MATERIALIZATION_DEBOUNCE_MS = 2000`, cap `15000` | one materialization job per burst |

The job id is `materialize-<documentId>`, so a stream of keystrokes collapses into
at most one pending job per document. (BullMQ rejects custom job ids containing
`:`; `QueueRegistry.enqueueDebounced` fails fast on that to keep the mistake from
hiding inside a persistence hook.)

## Presence and awareness

Awareness carries `{ user: { name, color } }` and is **never persisted**. Colours
come from `presenceColor(userId)`, a deterministic pick from `--presence-1…6`, so a
person keeps the same colour everywhere. The header shows avatars with initials; the
editor renders remote carets via `CollaborationCaret`.

## Offline behaviour

* `y-indexeddb` persists every update locally under `exocortex:<documentId>`.
* Local edits while disconnected set `pendingSync`, which the connection badge
  shows.
* On reconnect Yjs exchanges state vectors and merges both sides; concurrent edits
  from two clients both survive
  (`packages/editor/src/yjs.test.ts` → "merges concurrent updates from two clients
  without losing content").
* Applying the same update twice is a no-op ("is idempotent when the same update is
  applied twice").

## Restart safety

`apps/collaboration/src/collaboration.integration.test.ts` →
**"persists the binary Yjs state and survives a full server restart"** starts a real
Hocuspocus server, edits through a real provider, waits for the debounced write,
`destroy()`s the server, starts a **second** server instance and asserts the content
is back after reconnect.

Hocuspocus keeps a document in memory when a store hook throws ("Document stays in
memory to avoid data loss"), so a transient database failure does not lose edits.

## Read-only enforcement

Read-only is enforced in three independent places:

1. the ticket carries `access: 'read'`,
2. `connectionConfig.readOnly = true` makes Hocuspocus drop incoming updates,
3. `DocumentPersistence.store` refuses to write archived documents at all.

Tests: "refuses updates from a read-only connection" and "rejects a write ticket for
an archived document by downgrading to read-only".

## Scaling

Hocuspocus can be scaled with `@hocuspocus/extension-redis`; the constructor in
`createCollaborationServer` is the single place to add it. Application events already
scale through the Redis event bus (ADR-008). Local development runs one instance of
each process.

## Failure modes and behaviour

| Situation | Behaviour |
| --------- | --------- |
| ticket expired while connected | the existing connection stays; a reconnect needs a fresh ticket |
| membership revoked | the next connection attempt is rejected in `onAuthenticate` |
| document archived while connected | further writes are dropped by `store`; the UI shows the archived banner after the query refreshes |
| collaboration server down | the editor keeps working on the IndexedDB copy, the badge shows "Verbindung unterbrochen", the provider retries |
| database down | the store hook throws, Hocuspocus keeps the document in memory and retries |
