# Collaboration

## Model

- **One Yjs document per eXocortex document.** Never one per workspace: that would
  load unrelated content into memory, leak content across permissions and make
  awareness meaningless.
- The Yjs `XmlFragment` is named `default` (`YJS_DOCUMENT_FIELD`). Client, server
  and worker import the same constant; a mismatch would silently load an empty
  document.
- The canonical state is the **binary Yjs update** in `DocumentContent.yjsState`.
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

- `fetch` returns the stored `Bytes` verbatim, or `null` for a fresh document.
- `store` refuses unknown and archived documents, writes `yjsState` plus
  `yjsUpdatedAt`, and enqueues a debounced `document-materialization` job.

Two debounce layers:

| Layer      | Setting                                           | Purpose                               |
| ---------- | ------------------------------------------------- | ------------------------------------- |
| Hocuspocus | `debounce: 2000`, `maxDebounce: 10000`            | one database write per burst of edits |
| BullMQ     | `MATERIALIZATION_DEBOUNCE_MS = 2000`, cap `15000` | one materialization job per burst     |

The job id is `materialize-<documentId>`, so a stream of keystrokes collapses into
at most one pending job per document. (BullMQ rejects custom job ids containing
`:`; `QueueRegistry.enqueueDebounced` fails fast on that to keep the mistake from
hiding inside a persistence hook.)

## Writes that do not come from an editor

`POST /api/documents/:documentId/content` (humans, MCP, the built-in AI) and a
snapshot restore write the database directly.

That database write **edits the stored state**
(`applyProseMirrorDocumentToState`); it never stores freshly built state from
the incoming Markdown. Both produce a page that reads back correctly, and only
one of them survives contact with a copy: fresh state shares no history with
what it replaced, so the old content is absent rather than deleted, and the
first copy that reconnects — a tab that still holds the document, its
`y-indexeddb` store, a session that loaded before the write — merges as an
unrelated document and Yjs keeps both halves. Pages written that way came back
carrying their content twice (2026-09-15). Editing the stored state leaves
tombstones, which is what makes a late copy converge on the write.

A snapshot restore goes the same way, and for the mirror-image reason: storing
the snapshot's bytes is the state exactly, but it moves the document
_backwards_, so everything written since is missing from that state rather than
deleted in it, and the first copy that still holds it merges it back in — the
restore undoes itself. The restore therefore applies the snapshot's content to
the stored state as a `replace`, which arrives at the same text by moving
forwards. A snapshot from an older schema, whose content may not parse into the
current one, still falls back to the bytes.

Writing the database is only the whole story while nobody has the page open — an
open session holds its own copy in memory and would autosave it back over the
change. So the API hands the same change to this process afterwards, over a
private route (ADR-016):

```
POST http://127.0.0.1:3212/internal/documents/:documentId/content
Authorization: Bearer exos_…            # purpose: collaboration-write
{ "proseMirrorJson": { … }, "mode": "replace|append|prepend", "correlationId": "…" }
```

- Loopback only, never proxied. `COLLABORATION_INTERNAL_URL` is the API's side.
- The token says _who_ writes; write access is re-checked here exactly as it is
  for a WebSocket connection, archived pages included.
- Not loaded here → `applied: false`, and nothing happens: there is no live
  state to correct.
- Loaded → the content is applied to the living document in one transaction
  (`applyProseMirrorDocumentToYDoc`), broadcast to every client, and persisted
  immediately instead of at the end of the next debounce window.
- `append` and `prepend` insert only the incoming nodes, so concurrent typing
  survives. `replace` replaces.

The plain HTTP routes (these and the health probes) are served ahead of
Hocuspocus on `server.httpServer`, not through its `onRequest` hook: that hook
can only signal "handled" by throwing, and the throw leaves Hocuspocus's request
handler as an unhandled rejection.

## Presence and awareness

Awareness carries `{ user: { name, color } }` and is **never persisted**. Colours
come from `presenceColor(userId)`, a deterministic pick from `--presence-1…6`, so a
person keeps the same colour everywhere. The header shows avatars with initials; the
editor renders remote carets via `CollaborationCaret`.

## Offline behaviour

- `y-indexeddb` persists every update locally under `exocortex:<documentId>`.
- Local edits while disconnected set `pendingSync`, which the connection badge
  shows.
- On reconnect Yjs exchanges state vectors and merges both sides; concurrent edits
  from two clients both survive
  (`packages/editor/src/yjs.test.ts` → "merges concurrent updates from two clients
  without losing content").
- Applying the same update twice is a no-op ("is idempotent when the same update is
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

Read-only is enforced in four independent places:

1. the ticket carries `access: 'read'`,
2. `connectionConfig.readOnly = true` makes Hocuspocus drop incoming updates,
3. `DocumentPersistence.store` refuses to write archived documents at all,
4. `Connection.readOnly` is set on a connection whose authorization was
   withdrawn while it was open (see below).

Tests: "refuses updates from a read-only connection" and "rejects a write ticket for
an archived document by downgrading to read-only".

## Withdrawing access from an open connection

`onAuthenticate` decides once, and a tab keeps its connection for hours, so a
removal or a demotion has to reach connections that already exist (issue #62,
ADR-029). `apps/collaboration/src/revocations.ts` does that:

- it subscribes to the Redis channel `exocortex:revocations`, which the API
  publishes to after a role change, a member removal, an account being disabled
  and an account being deleted;
- a matching connection is marked `readOnly` first, which stops the next message
  before any close can be acknowledged, and its socket is then closed, so the
  client reconnects and asks for a fresh ticket;
- every 30 seconds it re-authorizes every open connection against the database
  as well. That sweep is what carries the guarantee when a published message was
  missed; a connection that has only lost its write right is downgraded in place
  there rather than closed, because reading is still allowed.

`onAuthenticate` also refuses an account whose `disabledAt` is set: switching an
account off deletes its sessions, but the collaboration ticket in the client's
hand stays valid for its TTL.

Tests: "withdrawing access from an open connection" (3 tests), all of which act
on a connection that was open _before_ the change.

## Scaling

Hocuspocus can be scaled with `@hocuspocus/extension-redis`; the constructor in
`createCollaborationServer` is the single place to add it. Application events already
scale through the Redis event bus (ADR-008). Local development runs one instance of
each process.

## Failure modes and behaviour

| Situation                         | Behaviour                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ticket expired while connected    | the existing connection stays; a reconnect needs a fresh ticket                                                 |
| membership revoked                | the open connection is closed within a second, and the reconnect is rejected in `onAuthenticate` (ADR-029)      |
| role demoted to read-only         | the open connection loses `write` on the next message; nothing typed is lost                                    |
| account switched off              | every connection it holds is closed, and `onAuthenticate` refuses the ticket that is still within its TTL       |
| document archived while connected | further writes are dropped by `store`; the UI shows the archived banner after the query refreshes               |
| collaboration server down         | the editor keeps working on the IndexedDB copy, the badge shows "Verbindung unterbrochen", the provider retries |
| database down                     | the store hook throws, Hocuspocus keeps the document in memory and retries                                      |
