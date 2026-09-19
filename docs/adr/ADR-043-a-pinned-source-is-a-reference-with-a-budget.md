# ADR-043: A pinned source is a reference with a budget

- Status: accepted
- Date: 2026-09-19

## Context

The chat knows one thing about where the user is: `AiConversation.documentId`,
the page the panel is standing on ([ADR-015](ADR-015-page-content-in-the-prompt.md)).
It is rebound on every turn that arrives from somewhere else, which is right for
"this page here" and wrong for everything else. A question about three pages at
once cannot be asked: the user opens one, asks, walks to the next, and the
conversation quietly changes what "this page" means underneath them.

Issue #75 asks for the other half: a conversation should be able to carry
sources of its own — pages, database views, saved searches — that survive
walking around, and the user should see at all times exactly what is being
carried, including what it costs.

Two things make this more than a list of ids.

The first is that a source is not one kind of thing. A page is a text. A
database is a shape, and its rows only mean something through a view's filters.
A saved search is a question whose answer changes between turns. Treating all
three as "some text" would make the database case wrong in the way
`describeCollection` already exists to prevent.

The second is cost. The open page's text is one page, capped by
`ai.pageContextMaxChars`. Eight pinned pages are eight of those, on every single
turn, and a chip row somebody assembled in ten seconds would quietly become the
most expensive thing in the deployment.

## Decision

**A pinned source is a row on the conversation, not a copy of anything.**
`AiConversationSource` names a target (`documentId`, `databaseViewId`,
`savedQueryId`) and carries a `targetKey` — `page:<id>`, `view:<doc>:<view>`,
`query:<id>` — which is what the unique index deduplicates on, because in
PostgreSQL two NULLs are distinct and a unique over three nullable ids would
never fire. Every target cascades on delete: a reference to a deleted page is
not a source any more, and a row left behind with three null ids could not be
rendered and could not be explained in the chip row either.

**Each source is either embedded or merely named**, and named is the default.
`REFERENCE` puts the title and the id into the prompt with the tool that
fetches it; `EMBED` puts its text there on every turn. Pinning is therefore one
click that costs nothing, and paying for a source is a second, deliberate
decision made on the chip itself. The alternative — embedding by default —
is what turns a chip row into a bill nobody chose.

**The budget is shared and split into equal shares.** All embedded sources
together may contribute `ai.pinnedContextMaxChars`, divided by their number
while the prompt is built, with a floor under one share. Spending it in order
would let the first long page eat it and leave everything pinned afterwards as
an empty heading, which looks like a bug and cannot be explained in a chip. A
cut is stated in the prompt text, for the same reason ADR-015 states it: a model
that cannot tell an excerpt from a whole page answers "that is not in there"
about something that is.

**One implementation renders, and both callers use it.**
`renderConversationSources` in `@exocortex/database` turns the rows into the
characters that go out; `apps/api` calls it to answer
`GET /api/ai/conversations/:id/sources`, and the worker calls it to build the
prompt. The chip row promises a size, and a promise made by a second
measurement is a promise about a different text. `describeCollection` moved out
of the worker into the same package for this reason, and a pinned database view
is described by it rather than read as prose.

**Pinning is the person's, reading is everyone's.** `exo_chat_context` reports
the list on both agent surfaces. The three writing routes stay out of the
catalogue with a written reason: what a conversation carries is the person
saying what leaves their workspace, so a run that could pin a page would be
widening its own context from inside itself — the same argument that keeps
`ai.untrustedContentPolicy` out of a request parameter
([ADR-030](ADR-030-foreign-content-and-mutating-tools.md)).

## Consequences

- A question about several pages at once is askable, and the answer does not
  change meaning because somebody navigated.
- The chip row above the composer now answers "what does this turn cost" with a
  number per source, measured on the text that will actually be sent.
- A workspace can switch the whole thing off (`ai.maxPinnedSources: 0`) or
  narrow it, and both keys are clamped by the deployment's.
- A pinned saved query costs one query per turn while it is embedded. That is
  the price of a question whose answer moves, and it is why `REFERENCE` is the
  default there too.
- Blocks are not pinnable. A block reference needs stable identity across
  edits, which is issue #78's problem and not this one's; a selection handed
  over from the editor already covers "this passage, once".
