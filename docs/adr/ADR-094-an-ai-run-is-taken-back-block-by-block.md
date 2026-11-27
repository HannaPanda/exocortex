# ADR-094: An AI run is taken back block by block, and a block somebody changed since is named

- Status: accepted
- Date: 2026-11-26
- Relates to: ADR-022 (agent provenance and the bulk revert), ADR-055 (blocks,
  not offsets), ADR-065 (an edit notice says what just happened), ADR-084
  (`ai.run.tool_call` carries its page as `subject`), ADR-025 (the same
  capability for the browser, the built-in AI and MCP), issue #248

## Context

The pieces for "what did the AI just do to my page, and take it back" were all
there, and none of them reached the person in the chat. Every run of the
built-in AI already writes under its own agent session (`ai-run-<id>`), so the
journal of ADR-022 knew exactly which pages a run wrote and which snapshot came
before each write. The editor marked the blocks a write changed for a few
seconds (ADR-065), the pulse under a running chat named the tool and the page
id, and a page's history could restore single blocks of a snapshot (issue #77).

What was missing is the part in between. The chat said "Werkzeug
exo_page_patch (Seite hcpq9w…)" while it worked and nothing at all afterwards;
the session revert sits in the admin area, takes back whole pages and decides
"somebody changed this since" from a timestamp with a two-minute grace window,
inside which it overwrites a person's edit without saying so. That is
defensible for an agent's afternoon. It is the wrong tool for the question a
person asks right after an answer, "nimm das zurück", where the person is very
likely still on the page and has very likely typed in it.

## Decision

**The journal records which top-level blocks a write changed, as fingerprints.**
`AgentWriteJournal.writtenBlocks` holds `[{ id, after, group }]` for every
snapshotted write that carries an agent session: `after` is a short hash of the
block as the write left it (`null` when it removed the block), computed inside
the write's own transaction from the snapshot it just took and the content it
just stored (`journalWrittenBlocks`, `written-blocks.ts`). Fingerprints, never
content: the snapshot is where the content is, as ADR-022 decided.

**Blocks that only mean something together are one change.** A narrow write
that rewords a paragraph usually removes the block and inserts a new one with a
new identifier. Putting the old one back while somebody has since reworded the
new one would leave both standing. So each write groups its changed blocks into
stretches between blocks it left alone, the groups of one run join through the
blocks they share, and a group goes back whole or not at all.

**Each group is judged against the page as it is now, and there are three
answers.** Every block as the run left it: the group is restored. Every block
as it was before the run: already back. Anything else, including a block the
open editor stored slightly differently from what the run wrote: somebody else
has been here, and the group is named and left alone. No grace window and no
timestamp: the content decides, which is the only test that cannot overwrite a
person's sentence typed a second after the run ended. Ambiguity is refused, as
ADR-055 refuses it for a write.

**The undo is the ordinary block restore.** `POST /api/ai/runs/:id/revert`
calls `DocumentDiffService.restoreBlocks` once per page with the snapshot
before the run's first write and the blocks of every revertible group, so the
open editing session is told, the restore is audited and snapshotted, and the
restore can itself be restored. Nothing new writes a page.

**Reading what a run changed is a tool, the undo is not.**
`GET /api/ai/runs/:id/changes` is `exo_ai_run_changes` on both agent surfaces,
and it names the snapshot and the block ids. Taking a whole run back in one call
stays a person's act in the browser, for ADR-022's reason: whether a run was a
mistake is the judgement of the person it ran for. An agent that has been asked
to undo one specific change can still do it with `exo_page_restore_blocks`, one
page and one decision at a time. Only the person the run worked for may take it
back; any member who may read the run may read its changes.

**What is shown while a run works names a place, not a state.** The pulse
under a running chat says "Schreibt in „Titel“" or "Liest „Titel“" for the
run's latest tool call until the next one (a read lasts milliseconds, the
thinking after it seconds), from the `target` and `subject` the worker already
publishes (ADR-084), and links to the page. There is still no "is being edited" state on
the page and nothing is locked (ADR-065): a write lands as one transaction and
the editor marks its blocks afterwards. "Auf der Seite zeigen" asks the editor
for the run's blocks once, from the run's changes, and marks them with the same
decorations for a while.

## Consequences

- An AI run's changes can be taken back from the chat without fear of losing
  what a person wrote afterwards; the price is that a group is held back as soon
  as one of its blocks moved, even when the move was harmless.
- A block restore puts content back, not order: a block the run only moved
  stays where it is. Renames, moves and pages a run created were at first
  named but not undone; the amendment below takes them back too.
- Rows written before the column existed carry `NULL` and their pages are
  reported as "not recorded"; the page's history still has the snapshot.
- Every journalled agent write now derives two states in its transaction. That
  is milliseconds for an ordinary page and nothing for a write without an agent
  session, which is every write a person makes in the editor.
- The session revert in the admin area is unchanged. It answers a different
  question, about an external agent's afternoon, and keeps its whole-page
  restore and its documented grace window.

## Amendment (2026-11-27): renames, moves, new pages, and what stands now

**A rename, a move and a new page go back by the same rule as a block.** The
journal row of a rename or a move carries `structure` (the title before and
after; the parent, workspace and order key before and after), and every
content-bearing row carries `pageAfter`, one fingerprint of the whole page as
the write left it, empty paragraphs left out because opening a page may add
one. Ids, titles and hashes, never content. The reading judges each with the
three answers a block has and a `reason` when it holds one back: a rename goes
back while the page still carries the run's title; a move while the page is
under the parent the run chose (at the same place, for a move among siblings)
and the parent it came from is still there; a page the run created while its
content and title are what the run left, none of its properties changed after
the run ended and nothing lies under it that the run did not put there. The
content decides, as for blocks; only the property values are compared by time,
against the end of the run, because they have no fingerprint.

**The undo uses the ordinary routes, in an order that takes nothing along.**
Moves first (`move`, next to the sibling that stood before the old order key),
then renames (`update`), then blocks, then new pages, topmost first, into the
trash (`archive`). A page the run moved under a page it created is out from
under it before the trash would take it along; a page somebody else put there
holds the new page back. Nothing is deleted for good: the trash is the way back
from the undo.

**Two things are named and not undone.** A move between workspaces took the
whole subtree along, and what was added to it since cannot be told apart. A
database or a project the run created holds rows, files and settings that one
fingerprint cannot vouch for.

**A change held back shows what stands now.** A block somebody rewrote under a
new identifier is gone from the page, so the preview used to show the run's
text or nothing. Each written block now records `prev`, the block before it,
and the reading names the blocks nobody had before that stand right at that
place (`standing`). A paragraph the run added and somebody rewrote is no longer
"already back" just because its identifier is gone.
