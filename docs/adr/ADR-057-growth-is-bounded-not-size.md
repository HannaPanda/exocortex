# ADR-057: an agent's writes are bounded by growth, not by page size

- Status: accepted
- Date: 2026-09-21

## Context

ADR-056 made a large page cheap to read: over a budget it answers with its map
rather than its text. That fixes the reader and leaves the writer exactly as it
was, and the writer is where the pages came from. An agent appends to a page it
has never seen whole -- that is the point of a budgeted read -- so nothing in
its loop ever notices that the page has become the place where everything goes.
A person in the editor sees the scrollbar. A tool call sees a success.

The pages that hurt were all written this way. "Gesundheit" reached 36,257
characters one append at a time, and the run that finally needed one section out
of it burned 1.36 million input tokens without writing anything.

Three constraints shaped the answer.

**Page size is not the defect.** A 2.9 MB web clip is a legitimate page and must
keep working (issue #118, section 10). What must not happen is a page growing
because nothing was ever in a position to notice.

**The paths that must not be bounded look exactly like the paths that must.**
The memory writes session notes through the same content service an agent's
`exo_page_write` reaches. Its SessionEnd hook fails silently on purpose, so a
limit applied there would stop the agent memory recording and nobody would find
out for weeks.

**`source` does not say what it looks like it says.** `DocumentContentService`
has carried `source: 'api' | 'ai'` since it was written, and issue #118 proposed
reading the policy off it. It is the wrong axis: every REST route passes
`'api'`, the agent route included, while `'ai'` marks the _internal_ services --
the memory and the entity layer -- that have to stay exempt. Reading the policy
off `source` would have gated the browser's route and exempted the agent's, in
that order.

## Decision

**The limit is on growth, not on size.** A write is refused only when the page
ends up over `agents.oversizedPageChars` _and_ larger than it was. Rewriting an
oversized page smaller, correcting a sentence in it and replacing one of its
sections all stay possible, because a rule that refuses by size alone leaves a
page nothing can ever repair and deletion as the only remaining operation.

**Two levels, and the lower one refuses nothing.** Above
`agents.largePageChars` the write succeeds and its answer names the page's new
size and its biggest sections, with the addresses that open them. Above
`agents.oversizedPageChars` a growing write is refused with
`document_page_oversized`, and the message names the same sections plus
`exo_page_extract_section`, which moves one of them onto its own page in a
single call (ADR-055). A refusal that only says no teaches a model to retry in
halves until it fits, which is the same page arriving in four writes.

**What is named is sections, never block windows, and never a section that is a
rounding error.** A section has to be at least a tenth of the page to be worth
offering, because the question is not how big it is but whether moving it away
would change anything. A map of a page without headings is cut into block
windows, which are addressable but nameless: "move blocks 41 to 80 onto their
own page" withholds precisely the thing the decision needs.

**Whether the policy applies is an explicit, defaulted-nowhere parameter.**
`DocumentContentService.write` takes `growth: 'guarded' | 'exempt'` beside
`source`, and it is required, so the type makes all eleven call sites decide. A
default would be wrong in both directions: `'guarded'` would let a new internal
caller stop the memory recording, `'exempt'` would let a new route out from
under the policy by omission.

**The narrow writes enforce the refusal too.** `DocumentEditService` is the door
beside the gate: a page the policy refuses one more append to could otherwise be
appended to with `exo_page_section_write` and a placement of `after`. It carries
the refusal and not the warning, because those three calls _are_ the way out the
refusal offers, and a sentence about the page's size on every targeted edit
would make the way out feel like the thing being discouraged.

**The size is the Markdown this write produces**, never the stored `markdown`
column, which the materialization job derives and which is a write or two behind
(ADR-005). A limit judged against a stale number lets one more write through
every time.

**The limits are workspace-overridable settings with the deployment value as a
ceiling** (ADR-023). How large a page may get is a fact about what a workspace
keeps rather than about what an agent is allowed to do, and lower is stricter
for both, so the clamp reads the right way round.

## Consequences

An agent that appends to a growing knowledge page is told once it passes 15,000
characters, with the sections it could move; past 50,000 it is refused and
handed the call that moves one. The editor is untouched -- the browser writes
through the collaboration server (ADR-016), not through this route -- and so are
the inbox, the web clipper, imports, the entity profiles, the conversation
archive and the agent memory, each by an `exempt` at its call site with the
reason written beside it.

The memory's exemption is held by a test rather than by a comment: its
integration suite constructs the content service with limits low enough that
every note it writes would be refused, so flipping any of those call sites to
`'guarded'` turns the file red instead of turning the recording off.

What this does not do: it does not split anything automatically, it does not
bound how big a page may be, and it does not stop a person or an import from
writing whatever they like. The failure it addresses is unattended growth, and
nothing else.
