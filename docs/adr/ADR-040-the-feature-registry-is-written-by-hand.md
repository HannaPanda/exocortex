# ADR-040: the feature registry is written by hand and counted by a gate

- Status: accepted
- Date: 2026-09-18
- Issue: #80

## Context

This deployment has 184 reachable routes, 138 tools, 24 screens and more
settings than anybody holds in their head. Its owner does not know all of it.
Several capabilities began as a passing idea, were built the same week, used
twice and forgotten; the cost is not embarrassment but the hour spent doing by
hand what a screen already does. A second person joining would meet the same
wall from the other side, with no history to fall back on.

The repository already enumerates itself three times over, and none of the
three helps:

- `docs/capability-matrix.md` is generated and complete, and it speaks in
  routes. `POST /api/workspaces/:x/clip` does not tell anybody that they can
  send an article from their phone's share sheet into the inbox.
- `packages/mcp-tools` has a German one-liner per tool, written for a model
  choosing between arguments. `exo_page_set_overview` names a mechanism, not a
  reason to reach for it.
- The ADRs explain why things are the way they are, at a length nobody reads to
  find out whether a feature exists.

What is missing is the sentence in between, and no generator can write it. The
question is therefore not how to produce the document but how to keep a
hand-written one from rotting, given that documentation nobody is forced to
touch reliably does.

## Decision

A registry of features lives in `packages/features`, one hand-written entry per
capability: a German title and summary, where to find it (screen, shortcut,
tools, settings), the day it went live, and what it accounts for in the
inventories. It is data with no dependencies but the wire contract, so the API
serves it and the browser renders it without either of them owning the text.
Since issue #98 the entry's words (title, summary, paragraphs, the sentence
saying where) live in the message catalogue instead, namespace `features`, and
the registry keeps the facts; see the amendment below.

It is served three ways, which is rule 12 applied to the registry itself:
`/hilfe` in the browser, `GET /api/features` for anything else, and
`exo_features` for the agents, so a session asked "can eXocortex do X" answers
from the deployment rather than from its training data.

`scripts/check-feature-coverage.mjs` is a hard gate in `build.sh`. It reads
three inventories out of the source -- the tool catalogue, every `page.tsx`
under `apps/web/src/app`, and the automation trigger and action enums -- and
fails the build when an entry in any of them is claimed by no feature, or when
a feature claims something that no longer exists.

Discovery is a per-person date. `UserFeatureSeen` holds one row per reader,
everything newer than it is marked new, and the navigation carries a dot until
they say they have read it.

## Consequences

**A capability cannot ship undescribed.** Adding a tool or a screen turns the
build red until somebody writes the sentence, at the moment they still know
what it does. That is the whole mechanism; everything else here is delivery.

**The gate counts and cannot read.** An entry that is complete, current-looking
and wrong passes. This is a real limit and not a temporary one: the alternative
is a model judging prose in a build step, which would be slow, expensive and
wrong in a different way. Review covers the text, the gate covers the omission.

**Three inventories, not five.** Editor block types and settings keys are
deliberately not counted. Block ids are partly computed in
`packages/editor/src/block-catalog.ts` and a text scan of them would be a
parser; settings would force 90 entries into a list that reads as noise. Both
are described in prose by the entries that own them, and a new block type can
therefore slip through. The three that are counted catch the shape of change
this repository actually produces.

**"At least one", not "exactly one", for screens.** The page view hosts a dozen
capabilities. Forcing one of them to own it would buy a tidier counter with a
lie. Tools are held to exactly one, but by `packages/features`'s own unit test,
where the types are real.

**An absent marker means "has seen everything".** A new account has missed
nothing, so it meets a manual rather than a changelog of sixty things it never
missed. Getting this backwards is the obvious mistake and the one that would
make the badge meaningless on first contact.

**`since` is the day it went live, not the day the entry was written.** A
backfilled entry for something that has been running for a month is not news,
and dating it today would tell every reader it is new. The marker moves to the
newest `since` in the catalogue rather than to today, so a later backfill with
an older date is still counted as seen.

**Marking the list read is not a tool.** Reading it is (`exo_features`), with
full parity. Marking it read is a statement about a human's attention, and an
agent calling it would silently clear somebody's badge; the exemption is
written next to the route in `scripts/check-mcp-catalog.mjs`.

## Amendment: the words moved into the message catalogue (2026-09-25, issue #98)

The interface got more than one language (ADR-062), and a registry written in
German inside TypeScript could only ever answer in German. So the human half of
every entry moved, verbatim, into `packages/i18n/src/messages/de/features.json`
under the entry's id: `<id>.title`, `<id>.summary`, `<id>.details.p1` onwards
(the catalogue holds no arrays) and `<id>.where`. German stays the source and
the other locales are translated from it like every other namespace.
`packages/features` keeps what a translation cannot change: id, area, `since`,
references, `ui.path`, shortcuts, settings, tools and claims, with `ui: {}`
marking a door in the browser that has no link.

`GET /api/features` puts the halves together per request in the reader's
language and orders the entries of one area and one day by the rendered title,
collated for that language; it also sends each area's heading from
`help.areas`, so `exo_features` prints headings without a catalogue of its own.
The gate grew the matching checks: every registry entry needs a title, a
summary and at least two paragraphs of more than a teaser in the German
catalogue, a `ui` needs its `where` and only a `ui` has one, and words for an
id the registry no longer has are an orphan. The rule the unit test used to
enforce about paragraph length moved into the gate with them, because the
registry package no longer sees the prose.

## Alternatives considered

**Generate the list from the catalogue and the matrix.** Zero maintenance,
always current, and it answers the wrong question: it would be an API reference
with German labels, which is what already exists and what nobody reads to
discover a feature.

**Keep the manual as pages in a workspace, maintained by an AI rule.** Pleasing,
since the product would document itself, and unenforceable: nothing goes red
when it falls behind, and an AI writing from commit messages would produce
exactly the mechanism-shaped prose the registry exists to avoid. The workspace
remains a good place to publish a copy; it is a bad place to keep the truth.

**Put the entries in `packages/mcp-tools` beside the tools.** Tempting, because
the tool list is the longest inventory. It fails on everything that is not a
tool -- screens, shortcuts, block types, triggers -- and it would tie the
person's view of a capability to whether an agent happens to have a call for
it.
