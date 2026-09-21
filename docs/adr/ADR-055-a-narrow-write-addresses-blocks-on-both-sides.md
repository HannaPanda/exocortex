# ADR-055: a narrow write addresses blocks, and the same range is resolved on both sides

- Status: accepted
- Date: 2026-09-21

## Context

Until now a write that did not come from the editor had one shape: here is the
Markdown this page should have. `replace`, `append` and `prepend` all take a
whole page or a whole addition, which is the right shape for "write this page"
and the wrong shape for almost everything else an agent does.

Issue #111 names the cost, and repairing one image line on a 36,000-character
page (issue #117) showed all of it at once. A one-line change costs the page in
tokens on the way out and the page again on the way back. It regenerates every
block identifier on the page, because `applyProseMirrorDocumentToState` in
`replace` mode deletes the fragment and inserts a new one -- so every comment
anchor and every transclusion pointing into that page is repaired only by luck.
And between the read and the write there is a window in which anything anybody
else wrote is silently overwritten.

Three ways to close it were considered.

**A diff the API applies.** Send the page back and have the server work out what
changed. Rejected: it moves the token cost nowhere and makes correctness depend
on a diff heuristic agreeing with what the caller meant.

**Markdown offsets.** Address a region by character position in the exported
Markdown. Rejected for the reason ADR-003 gives: identity must never be derived
from offsets. The page moves between the read and the write, and an offset that
was right is then wrong rather than absent.

**Block identifiers.** What this ADR chooses. The page already has stable
addresses: `exo_page_block_read` lists them, comments anchor on them, a
transclusion points at one, and they survive edits elsewhere on the page.

## Decision

**A narrow write is a range of blocks plus a placement.** `BlockRangeEdit` is
`fromBlockId`, an optional `toBlockId` and `placement: replace | before |
after`. That is the whole vocabulary, and the three REST routes
(`content/block`, `content/patch`, `content/section`) are three ways of arriving
at one.

**The range is resolved against the thing that is edited.** `resolveBlockRange`
walks the live Yjs fragment and compares the `blockId` attribute, rather than
walking the derived ProseMirror JSON and carrying indexes over. A derived index
that is correct in the derivation and stale in the fragment would delete the
wrong paragraph, which is a failure nobody would find by reading the response.

**The same range description travels to the collaboration server.** The API
edits the stored state and hands the collaboration server the same
`BlockRangeEdit`, which resolves it again against the _living_ document
(ADR-016). Identifiers rather than positions are what makes that second
resolution meaningful: three paragraphs may have been typed above the edit in
the meantime, and the identifier still names the right block -- or honestly
fails, when somebody deleted it.

**Everything outside the range is not touched at all.** Not rewritten with
identical content, not re-serialized, not re-identified: the Yjs nodes are left
alone. That is what keeps the identifiers, the history and any concurrent edit,
and it is the difference between this and a `replace` that happens to produce
the same text.

**The result is validated before it is stored.** A whole-document write cannot
produce a shape the schema refuses, because what arrived was checked as a
document. A range can sit inside a list item or a table cell, where a heading
may not go, so `applyBlockRangeEditToState` derives the finished document and
validates it. A refusal has to stay a refusal rather than become a page the
editor can no longer open.

**Ambiguity is refused, never resolved.** A heading that occurs twice, a text
that occurs twice, a text that occurs nowhere: each answers with what was found,
names the candidates' block identifiers, and writes nothing.
`exo_project_patch_file` settled this for files and the argument is the same
here -- the point of a narrow edit is that the caller knows where it lands, and
a tool that picks for them has taken that away.

**`replaceAll` is the one case that falls back.** Several matches become several
ranged edits against the stored state, but the bridge carries one edit per call,
and several calls that must not interleave with somebody's typing is a worse
promise than one honest page update. So a multi-match patch hands the open
session the whole document, exactly as `exo_page_write` does today.

## Consequences

- Correcting a line on a long page is a request whose size is the line, and the
  four hundred blocks around it keep their identifiers.
- Two agents editing different parts of one page no longer overwrite each
  other, because neither ever writes the other's blocks.
- `exo_page_read` gained `includeBlockIds`, which writes `^id` after each block.
  Without it the addresses need a second read, and a feature that needs two
  calls to become usable is one agents will not reach for.
- There is now a second producer of new page state. Everything after the state
  is produced -- snapshot in the same transaction, `materializedAt` left where
  it is, outbox entry naming the snapshot, live session told after the commit,
  materialization enqueued -- lives in `DocumentWriteCommitService`, written
  once. A second copy of that sequence stays correct for about a month.
- A narrow write is deliberately not `destructive` in the confirmation gate.
  The gate exists for a call that can lose content the caller never read;
  naming one block is the opposite of that.
