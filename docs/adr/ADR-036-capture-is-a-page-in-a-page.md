# ADR-036: a capture is an ordinary page under a page that is marked

- Status: accepted
- Date: 2026-09-18

## Context

This installation is good at structure. It files, it suggests parents, it
searches three ways, it composes overviews. All of that is about a page that
already exists, and issue #71 is about the moment before: a thought, a sentence
someone said, a link. Writing one down currently costs a decision -- which
workspace, which parent, what title -- and the decision costs more than the
thought is worth, so the thought goes to a chat window, a notes app, or nowhere.

An external brain in which remembering is more expensive than filing has the
prices the wrong way round.

Three questions had to be answered before writing any of it.

**Is a capture its own kind of content?** Every product that has built this ends
up with a second content model: a `capture` row, a `quick note`, an `item`. It
is always defensible at the time, because a capture genuinely has less than a
page does -- no place, often no title -- and always expensive later, because
every feature then has to be built twice. Search, references, permissions,
snapshots, automations, the MCP catalogue, export: each one either learns about
captures or silently does not cover them.

**How does the system find the inbox?** It has to survive being renamed, moved
and given an icon, because it is a page a human will do all three to.

**What does filing mean?** Moving a page already exists, has rules about where a
page may go, and is reached from the tree, from the API and from
`exo_page_move`.

## Decision

**A capture is an ordinary page, created by the ordinary services.**
`InboxService.capture` calls `DocumentsService.create` and then
`DocumentContentService.write` -- the same two calls the editor, the Markdown
import and the memory make. Nothing downstream knows that capture exists: the
outbox event is `document.created`, materialization derives the same fields, the
search index gets the same row, an open editor is reached through the same
bridge (ADR-016), and a capture is snapshot, exported, embedded, linked and
automated over like any other page. The cost of this decision is that a capture
carries no fields of its own; provenance is a line of Markdown under the text.

**The inbox is a page carrying a flag: `Document.isInbox`.** Not a setting, for
the same reason the memory workspace is `Workspace.isMemory` and not a settings
key (ADR-023): this is identity, not configuration, and a pointer in a settings
table survives neither a restore nor a careful reading. Not a title lookup
either -- "Eingang" is a name, and a name is the first thing someone changes. A
partial unique index keeps it to one per workspace, written by hand in the
migration because Prisma cannot describe one. The price is that the constraint
is invisible in `schema.prisma` apart from the comment, which is cheaper than
enforcing the rule in a service that two concurrent captures can both pass.

**The inbox is created on first use, not with the workspace.** A deployment that
never captures anything never grows the page, and every workspace that already
exists gains one the day it is first used rather than by a migration guessing
where it should sit. Two captures racing both try to create it; the loser reads
the winner's page instead of failing.

**Filing is `move`, and deliberately not a new endpoint.** The inbox's own
capability is one button in front of the existing pair: ask
`POST /documents/suggest-parent` where the page belongs, then
`POST /documents/:id/move` to put it there. A second way to move a page would be
a second set of rules about where a page may go, and the two would drift.

**The title is derived from the first line, which then leaves the body.** A
capture is one field; a page needs a title and a body. The first line becomes
the title, a bare URL becomes host and path, and nothing becomes the moment of
capture. The line is then dropped from the body, because a one-line note whose
page repeats it reads as a bug -- the same rule the Markdown import follows for
a leading heading.

**All three clients reach it the same way** (ADR-025): `POST
/api/workspaces/:id/capture` and `GET /api/workspaces/:id/inbox` behind
`exo_capture` and `exo_inbox`, plus the dialog on `Strg + E` in the browser.

## Consequences

- An agent that does not know where something belongs has somewhere to put it.
  That is a real risk: `exo_capture` is cheaper than thinking, and an inbox
  filled by agents instead of `exo_page_create` would be a step backwards. The
  tool description is explicit that a known destination means `exo_page_create`,
  and the inbox is visible enough that a growing one is noticed.
- The inbox can be renamed, moved, given a cover, archived or deleted like any
  page. Deleting it means the next capture creates a fresh one; nothing breaks,
  and the old entries stay where they were.
- A capture's provenance is prose, not metadata, so it cannot be queried. The
  web clipper (issue #72) will need fields, and it will have to decide whether
  those become page properties -- this ADR deliberately does not.
- `GET /inbox` counts only unarchived children, so archiving an entry empties
  the inbox as surely as moving it. That is the same gesture the trash already
  offers, and treating it as filing would have been a lie about where the page
  went.
- The inbox sits above the other top-level pages because an inbox that has to be
  scrolled to is one nobody empties. It is an ordinary order key, so moving it
  is allowed and nothing enforces the position afterwards.
