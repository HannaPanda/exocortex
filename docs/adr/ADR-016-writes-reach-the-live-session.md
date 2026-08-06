# ADR-016: A write that is not from the editor goes through the open session

* Status: accepted
* Date: 2026-08-06

## Context

A page has two writers that never met.

The editor writes through Hocuspocus ([ADR-004](ADR-004-yjs-and-hocuspocus.md)):
the document lives in the collaboration server's memory, every keystroke is
broadcast to the other clients, and a debounced hook stores the binary state
([ADR-005](ADR-005-binary-yjs-persistence.md)).

Everything else — `POST /api/documents/:documentId/content`, and therefore MCP's
`exo_page_write` and the built-in AI ([ADR-014](ADR-014-single-tool-catalogue.md))
— wrote `documentContent.yjsState` straight into PostgreSQL. The collaboration
server has no idea. It cannot: the process had no HTTP surface beyond its health
probes.

Two things follow from that, and the second is worse than the first.

The change is **invisible**. A page that is open keeps showing the old text
until somebody reloads. `document.content.replaced` has existed on the realtime
channel the whole time, and nothing in the web app listened to it, so not even a
hint appeared.

The change is **temporary**. The open session still holds its own copy in
memory. Its next debounced autosave writes that copy back, over the write that
just landed. `docs/mcp.md` recorded this under "Known gaps" as accepted: every
write is snapshotted first (`reason: 'API_WRITE'`), so nothing is unrecoverable
— but you have to notice the loss before you can undo it, and nothing told you.

Listening to the event and reloading the editor would make the loss visible
without removing it: between the database write and the reload there is still a
window in which the session can save over it. The real fault is that an open
document has two authorities.

## Decision

**When a document is open in the collaboration server, that server applies the
change.** The API keeps its transactional write, and then hands the same change
to the collaboration server over a private endpoint.

The collaboration server gains one route,
`POST /internal/documents/:documentId/content`
(`apps/collaboration/src/internal-content.ts`):

* Bound to loopback, like the process itself. It is never proxied.
* Authenticated with a short-lived HMAC service token
  (`packages/auth/src/service-token.ts`) minted for the new purpose
  `collaboration-write` and signed with `COLLABORATION_TICKET_SECRET`, the
  secret the API and this process already share. The purpose is part of the
  signed payload and every verifier names the one it accepts, so a worker's
  `ai-tools` token cannot be replayed here and vice versa.
* Authorization is *not* taken from the token. The token says who is writing;
  the endpoint then runs the same workspace-membership and write-access check a
  WebSocket connection runs, so an archived page or a revoked member is refused
  exactly as it would be in the editor.
* **A document that is not loaded here is left alone.** Nothing is open, so
  there is no live state to correct and no autosave to lose to: the caller's own
  database write is already the whole truth. The response says
  `applied: false`, and the API reports that as `appliedToLiveSession`.
* When it is loaded, the content is applied to the living document in one Yjs
  transaction (`applyProseMirrorDocumentToYDoc` in `packages/editor/src/yjs.ts`),
  which broadcasts to every connected client, and is then persisted immediately
  rather than at the end of the next debounce window.

The apply carries the caller's **mode**, and this is the part that removes the
data loss rather than merely making it visible:

* `replace` deletes the fragment's content and inserts the new document. That is
  what the caller asked for.
* `append` and `prepend` insert *only the incoming nodes*. Nothing existing is
  deleted, so everything the humans in the session typed in the meantime
  survives the merge — an agent appending to a page somebody is writing on no
  longer costs that person their last few sentences.

Snapshot restore (`DocumentSnapshotService.restore`) takes the same route with
`mode: 'replace'`, because a restore has exactly the same failure: the session
would autosave the version the user just replaced back into place.

## Consequences

* An MCP or AI write to an open page appears in the editor immediately, with no
  new realtime event, no reconnect and no client-side special case. It arrives
  as an ordinary collaborative update, because that is what it now is.
* The overwrite window is closed for a loaded document, and for an unloaded one
  there is nothing to close: a session that connects after the commit loads the
  new state from the database. A session that connects *during* the exchange
  either gets the new state or gets the apply.
* One window is narrowed rather than removed: if the very last editor of a page
  disconnects in the milliseconds between the API's commit and its call here,
  Hocuspocus's unload store can still write that session's copy over the fresh
  one. The endpoint waits for a pending unload before answering, so its answer
  is at least accurate, and the snapshot still makes it revertable. Closing it
  entirely would need a lock across the two processes, which costs more than the
  case is worth.
* The API depends on the collaboration server for the live half of a write. It
  is not a hard dependency: an unreachable server is logged, the write stands,
  and the response carries a German warning that open sessions must reload. The
  old failure mode is exactly this warning's content, which is the honest way to
  degrade.
* `documentContentWriteResponse.yjsUpdatedAt` is the timestamp of whichever
  write was last — the session's store when it applied, the API's own otherwise.
  A caller that feeds it back as `expectedYjsUpdatedAt` keeps working.
* For a moment the row's `yjsState` (written by the session) and its derived
  `markdown` / `plainText` (written by the API) can describe slightly different
  content, if somebody was typing at that instant. The materialization job
  settles it, and the canonical state is the binary one either way (ADR-005,
  ADR-007).
* The collaboration server now serves its HTTP routes ahead of Hocuspocus rather
  than through its `onRequest` hook. That hook can only say "handled" by
  throwing, and the throw escapes Hocuspocus's request handler as an unhandled
  rejection; the health probes had been doing that quietly all along.
* `COLLABORATION_INTERNAL_URL` (default `http://127.0.0.1:3212`) is the API's
  address for the endpoint. Deployments that split the processes across hosts
  must set it — and must keep the route off the public reverse proxy.
