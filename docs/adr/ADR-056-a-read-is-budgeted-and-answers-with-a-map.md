# ADR-056: a read carries a budget, and a page too big for it answers with its map

- Status: accepted
- Date: 2026-09-21

## Context

A page here can grow without a bound. Every reader of one cannot: the worker
caps a tool result at 30,000 characters, the MCP tools capped a page export at
60,000, and a model's context is finite whatever those numbers say. The
workspace already holds 1,478 pages with content, 43 of them above 10,000
characters, two above 60,000, and one web clip of 2,927,438.

The failure that named this (issue #118) is small and completely
characteristic. Somebody asked the built-in AI to move a section onto its own
page. The section sat at the end of a 36,257-character page, the worker cut the
read at 30,000, and the note at the cut said `… (gekürzt)` and nothing else:
not how much was missing, not that anything addressable lay behind it. The
model concluded the text was hard to *find* rather than withheld, ran fourteen
searches with different wordings, guessed at two block identifiers, and died on
the tool-iteration limit having written nothing. It cost 1.36 million input
tokens to not move a paragraph.

Raising the cap answers none of this. It buys one page and moves the wall, and
a bigger wall costs more context to hit.

Three shapes were considered.

**A cursor.** Answer with the first N characters plus a continuation token.
Rejected: it makes reading a whole page the normal way to reach any part of it,
which is precisely the cost being removed. A 2.9 million character page is 98
sequential reads, and the agent has to hold all of them.

**A summary.** Answer with a model-written précis of the page. Rejected: a read
that calls a model is not a read. It is slow, it costs money on navigation, it
is non-deterministic, and it answers a question ("what is this about") that is
not the one being asked ("where is the part I need").

**A map.** What this ADR chooses.

## Decision

**A read carries a budget, and over that budget the answer is the page's
structure instead of its text.** `maxChars` and `maxEntries` travel on
`GET /api/documents/:id/export/markdown` and on
`GET /api/documents/:id/fragment`; `applyResponseBudget` makes the decision once
for both, and the response says which came back in `view: 'content' | 'map'`.

Four things follow, and each of them is the point of one of the three rejected
shapes coming back differently.

**Never a prefix.** Over the budget, `markdown` is empty. A prefix reads like
the beginning of something and invites reading on; that belief is what the
failure above was made of. A map invites choosing.

**The recursion has a floor.** A map is built by `buildDocumentMap` over
ProseMirror JSON, cutting at the shallowest heading level the part uses. Handing
a section back in maps that section, so the rule is one rule at every depth:

    page -> heading map -> subheading map -> block-range map -> content

The floor matters and is not hypothetical. The 2.9 million character page has
26 headings, so its sections are flat runs of about 112,000 characters. A map
that could only cut at headings would bottom out there with nothing to offer,
which would make the deepest content unreachable by exactly the page the design
is for. A part with no inner headings is therefore mapped as **block windows**,
addressed by `fromBlockId` and `toBlockId` -- the same description the write
side resolves in ADR-055, because "which blocks does this address" must have
one answer on both sides.

**A map is bounded too.** Entries past `maxEntries` are not dropped, they are
merged: neighbouring sections become one entry that says how many it covers,
and opening it maps it finer. So a page with fifteen thousand headings answers
in the same thirty lines as a page with six, and nothing in it is unreachable.

**A read never starts new work.** No summary, no keywords, no model call. An
existing `DocumentDigest.summary` (ADR-028) may ride along because it is already
there; nothing is computed to fill a map. Navigation has to stay cheaper than
the thing being navigated to, or the map is just a slower read.

A caller that names no budget is unchanged. The browser rendering a placed
transclusion, an export, an internal job: all of them still get the content,
which is what makes this a contract for agents rather than a change to what a
page *is*.

## Consequences

`exo_page_read` sends a 10,000-character budget on every call, so the 97 percent
of pages below it are answered exactly as before and the rest answer with a map
naming every part and its address. `exo_page_block_read` is the other half: no
`blockId` is the page's map, a `blockId` is that section or the map of it, and
`toBlockId` reads a window. The old flat list of every block survives as
`blocks: true`, because a block picker wants it and a reader does not.

The generic cut in the worker stays as the last resort under every other tool,
but it now states how much was shown of how much and that it has no
continuation to offer. A cut that cannot say what it hid is what turns a big
answer into a loop.

What this does not do: it does not stop a page from growing (the write-side
policy is the next step in issue #118), it does not split anything
automatically, and it does not make a search hit addressable -- a hit still
names a page rather than a section, which is the other half of the cost of that
failed run and is sequenced with #110.
