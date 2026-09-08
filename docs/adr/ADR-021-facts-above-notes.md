# ADR-021: the memory keeps facts above its notes, and they fade instead of expiring

- Status: accepted
- Date: 2026-09-08

## Context

ADR-019 gave the agents a memory: a workspace of their own, a note per finished
session, `recall` at the start of the next one. It has worked, and the way it
fails is the way every append-only log fails.

Measured on this deployment before the change: the same standing fact appears in
five separate session notes, worded five ways, because five sessions each
rediscovered it. `recall` returns all five, and the character budget it must
stay inside is then spent on redundancy. Worse, when something changes, the old
note and the new one sit side by side in the index with equal weight, and the
only thing separating "was true in March" from "is true now" is a date the
reading model has to notice and reason about. It regularly does not.

`memory.retentionDays` is the only pressure valve, and it measures the wrong
thing. It deletes by age, so a note confirmed ten times dies on the same day as
one nobody ever needed again. Turning it on loses knowledge; leaving it off (the
default) lets the noise grow without limit. Neither is a memory.

What was missing is a distinction the notes cannot make on their own:

- a **note** records that something happened once, and is true for ever after,
- a **fact** claims something about the present, and can stop being true.

## Decision

**A fact is a page with a sidecar row.** The wording of a fact lives in an
ordinary `Document` under a `Fakten` page in the project's subtree, so it is
searchable, embeddable, versioned, commentable and readable by a human without
one line of new rendering, and every write to it goes through the ordinary
document services (ADR-016 applies unchanged). `MemoryFact` beside it carries
only what a page cannot: `confidence`, `confirmations`, `lastConfirmedAt`,
`status` and `supersededById`.

**It is not an ADR-011 database.** A `COLLECTION` is something a person designs
and rearranges. This schema is fixed, written only by a background job, and read
on the hot path of every recall; a typed table is the honest shape.

**A nightly job judges notes against facts, and the API applies the judgement.**
`consolidate-memories` fans out one `memory-consolidate` job per project with
unread notes; that job asks a model, per note, whether it confirms, replaces or
contradicts something already held, or says nothing worth keeping. The verdicts
go back through `POST /api/memory/facts`. The split is the one capture already
uses: the worker decides what a note *means*, the API decides what that does to
the memory (ADR-014).

**A note is read exactly once.** `MemoryConsolidation` is one row per note,
written whether or not the note produced anything. Without that row the
unremarkable notes, which are the majority, would be re-read and re-paid for
every night.

**Facts fade; they do not expire.** `decay-memory-facts` multiplies the
confidence of every current, unconfirmed fact once a night, sized so that
`memory.factHalfLifeDays` of silence halves it exactly once. A confirmation
raises it back, closing a fixed share of the gap to certainty and therefore
never reaching it. Below `memory.factConfidenceFloor` the fact's page is
archived, which is to say it goes to the trash like everything else here.

**A contradiction is a third state, not a decision.** When two notes disagree
and nothing says which wins, the fact is marked `CONFLICTED` and stays that way
until a person resolves it. Resolving it by weight would produce a memory that
is confidently wrong, which is worse than one that admits it does not know.

**Promotion into the curated brain stays a human act.** `POST
/api/memory/facts/:id/promote` copies a fact into a workspace somebody names.
Nothing does it automatically: the memory workspace may be swept, the brain may
not, and crossing that line is a decision (ADR-019).

**Applying verdicts is not a tool.** `exo_memory_facts` reads and
`exo_memory_fact_promote` promotes, but the endpoint that rewrites what the
memory believes is reachable only by the job that has just read the notes it is
judging. A model able to call it directly could rewrite its own past without any
note saying so.

## Consequences

`recall` now answers in two parts: what is held to be true for this project,
then the hits. The facts get at most a third of the character budget, because
they are the better answer but the thinner one, and an agent still works from
detail.

The note prune had to learn two exceptions. A page carrying a fact survives its
own evidence, which is the entire point of distilling it; and a page with
children survives, which protects the `Fakten` page and anything else somebody
has built structure under.

Consolidation is off by default (`memory.consolidationEnabled`). It is a paid
model call per project per night, and switching it on is a deployment's
decision, not an upgrade's.

The obvious next step is per-block evidence: a fact currently points at the
notes it came from, but a note is up to two thousand characters and the sentence
that actually said it is one of them. Issue #36 (chunking) is what would make
the citation a passage.
