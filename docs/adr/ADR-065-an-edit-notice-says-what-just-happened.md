# ADR-065: an edit notice says what just happened, never what is happening

- Status: accepted
- Date: 2026-09-25
- Relates to: ADR-008 (separate sockets), ADR-016 (writes reach the open
  session), ADR-022 (agent sessions), ADR-055 (narrow writes), issue #112

## Context

Since the narrow writes of ADR-055 an agent changes a paragraph rather than a
page, and ADR-016 makes that change arrive in every open editor at once. For the
person reading the page, that is text moving under them with no explanation:
nothing says who changed it, or that anybody did.

Issue #112 asked for Google-Docs-like markers with three states: an agent is
_editing_ a block, has _changed_ it, or is in _conflict_ with the reader.

## Decision

After a write that did not come from the editor, the collaboration server tells
every connection on the document which blocks changed and who changed them. The
browser marks those blocks for a few seconds and lets the marker settle.

1. **The notice is a Hocuspocus stateless message on the document's own
   socket**, not an application event (ADR-008) and not an awareness state. The
   notice is about this document's content, so the connection that already reads
   the document is exactly the right audience and needs no further
   authorization. It travels behind the Yjs update it describes, down the same
   ordered channel, so the blocks it names are already there when it arrives.
   Awareness would have been the wrong primitive: it is a per-client state that
   lives until the client leaves, while this is an event that is over the
   moment it has been shown.
2. **The server works out the blocks by comparing, not by trusting the request.**
   It derives the live page before and after the transaction and names the
   innermost blocks that differ (`changedBlockIds` in `packages/editor`), by
   block identifier only. A whole-page `replace` rebuilds every Yjs item, and
   only the comparison can tell the reader that three paragraphs changed rather
   than forty. It is only done while somebody has the page open, and a deleted
   block is never named, because it has no place left to mark.
3. **The writer comes from the request context.** An agent session (ADR-022)
   makes the writer an agent named by its own `clientInfo`, shown without its
   version; the built-in AI names itself "eXocortex KI". Anything else is a person,
   named by the collaboration server from the account the service token was
   minted for. The label is unverified and only ever shown, never decided on.
4. **There is no "editing" state.** An agent's write is one transaction that
   lasts milliseconds. There is no stretch of time in which it is "working on" a
   block that a marker could honestly describe, and a spinner for a
   millisecond is a marker that lies about its own duration. What can be said
   truthfully is what just happened and by whom, so the states are `changed`,
   `conflict` and `failed`.
5. **A conflict is decided by the reader's browser.** Only the browser knows
   where the reader's cursor is and whether they were typing (the last five
   seconds, by their own transactions). A change inside that block is marked as
   a conflict; the text is not in danger, Yjs merges both, but the sentence may
   no longer read as it was left.
6. **A refusal is announced where it was aimed.** A narrow write the live
   document refuses (its blocks are gone) is announced as `failed` at the blocks
   it named, so nobody reads the next change as this one. A refusal the API
   gives before the collaboration server is reached (optimistic concurrency)
   changes nothing and is not announced: no change means no marker.
7. **Nothing is stored and nothing is locked.** The markers are decorations,
   like the comment markers: the document does not know them, a snapshot does
   not capture them, and every block stays editable throughout.

## Consequences

- A reader sees which paragraphs an agent just changed and which agent it was,
  with no persistent trace and no page lock.
- A reader who is offline, or whose tab reconnects, misses the notice. That
  loses a highlight, not information: the change itself arrives through Yjs.
- Each write costs two derivations of the live page while somebody watches it.
  Writes that nobody watches cost nothing extra.
- An agent cannot learn that a person was editing the same block; the conflict
  is shown to the person only. Agents already see the concurrency they need
  through `expectedYjsUpdatedAt` and the refusals of ADR-055.
