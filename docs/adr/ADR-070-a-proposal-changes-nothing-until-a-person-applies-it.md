# ADR-070: a proposal changes nothing until a person applies it, and never onto a page that moved

- Status: accepted
- Date: 2026-09-27
- Relates to: ADR-016 (writes reach the open session), ADR-022 (agent
  sessions), ADR-025 (capability parity), ADR-030 (foreign content), ADR-055
  (narrow writes), ADR-066 (work items), ADR-067 and ADR-068 (attention items
  and checkpoints), issue #120 (page revisions), issue #141

## Context

An agent could read or write. Writing was either allowed or refused, per
tool, per run, and afterwards the agent journal and the snapshots were how a
person found out what happened and took it back. That is enough for an agent
somebody trusts with a page and too much for one they do not yet: a powerful
agent that should prepare a change, not make it, had nowhere to put the
change except a page, a comment or a chat message somebody would have to copy
out by hand. Issue #141 asks for a third mode between the two: the agent
prepares a set of changes completely, a person reviews it as a diff and takes
all of it, part of it or none, and nothing ever lands on a state of the page
nobody reviewed.

## Decision

**A changeset is a list of page writes that were not made.** `changeset` holds
the title, the message, who proposed it (kind read from the credential, as for
a work item), the run and the work item it belongs to, and the proposal it
reworks. `changeset_change` holds one write each: a block, a section, a patch,
the whole page, or a new page, stored as the request the narrow write routes
take (ADR-055) without its revision. The first version is limited to pages;
moves, properties and comments are later members of the same kind column.

**A change is resolved when it is proposed, by the write's own code.** Both
write services gained `preview` beside `write`, sharing everything a write
does before it commits: access, revision, resolution of the heading or text,
parse, the edit on the stored Yjs state, the growth policy. So a heading that
is not there, a text that occurs twice or a page the proposer may not edit is
refused at once, and what is stored is the revision it was computed on and
the block diff of the page before and after. The diff is computed once and
kept; it shows what was proposed against what was there, which is what a
reviewer decides about.

**A draft is its proposer's; a handed-in set is frozen.** Only the proposer
adds or removes changes, and discards a draft. Handing it in records a sha256
over the changes, which is what a review is bound to (the changeset member of
`attentionSubjectSchema`, compared like a page revision, ADR-068).

**Applying is the ordinary write, as the person applying it, at the expected
revision.** Each chosen change is replayed through the write route it stands
for with `expectedYjsUpdatedAt` set to the revision the change expects, so
every apply takes its snapshot first, reaches the open editors (ADR-016),
records its activity and is refused by the write itself when the page moved.
A refusal that means the change no longer fits (the revision, a block or
heading or text that is gone, a page deleted for good) marks it `stale` and
ends it; any other refusal (an archived page, the growth limit, a missing
right) leaves it pending and is reported, because somebody can fix that and
apply again. Nothing in this module writes a page itself.

**A set does not go stale on its own writes.** When a change lands, the
pending changes of the same set on the same page move their expected revision
to the one it produced. A write by anybody else still makes them stale. Two
changes of one set on one page are therefore applied in order, the second
resolved against the page including the first; a second that addressed what
the first replaced is refused, never guessed.

**Every decision is on the row, once.** A change moves from `pending` to
`applied`, `rejected` or `stale` and never back; the row names who decided,
their kind, when, the note and the snapshot to restore. The set's status is
derived from its changes by one pure function (`changesetStatusOf`) and
stored: `draft`, `ready`, `partially_applied`, `applied`, `rejected`, `stale`.
A rejected or stale set is reworked as a new draft naming it (`revisesId`),
so the first one stays the record of what was proposed and decided.

**Handing in raises one attention item, and the decision carries the work
on.** A proposal nobody is told about is one nobody decides. On a work item
the default is a review: the work moves into `review` through the same path an
asked-for review takes, and the run that handed it in ends its turn
(`pausesRun`). Otherwise it is an approval that stops nothing. When the last
change is decided, the item is settled with an account of the decision (counts
and notes, in the words the run reads), and a review sends the work back to
`working`, which is what makes the resume of ADR-068 post that account into
the paused run's conversation. Whether the work is done then is the run's
call or its owner's: applying every change is not the same as finishing.

**The mode is a boundary the server enforces, not a request.** The built-in AI
has a write mode: `direct`, `propose` (report on its work and propose, never
write a page) or `read_only` (only read and report). It is the stricter of the
workspace's `ai.writeMode` (a ranked setting, so a workspace can only
tighten) and the work item's own `writeMode`, read from the database when the
run starts and recorded on the run. The loop offers and allows only what the
mode permits, and the worker signs the mode into the run's service token, so
`TokenScopeGuard` refuses the rest by route class whatever the loop decided.
An external agent gets the same boundary as a token scope, `propose`, between
`read` and `write`. The route classes (`read`, `report`, `propose`, `write`,
`admin`) are derived in one function, `requestClassFor`, for both. Loosening
a work item's mode takes a person or a token that may write, so no run lifts
the mode it is held to.

**Deciding is a person's.** Apply and reject are routes of class `write` and
tools on the MCP surface only: the built-in AI never decides on a proposal,
its own or another run's. An external agent holding a writing token is a
person's credential and may; that is the same line ADR-066 draws for who a
request came from.

**A proposal is allowed after foreign content.** ADR-030 stops a run writing
once it has read text from outside, because the text could be giving orders.
A proposal changes nothing until a person has read the diff and applied it,
which is exactly the review foreign text needs; the refusal of a page write
now names the proposal as the way out.

## Consequences

- Eight tools in a `changesets` domain: propose (which also starts a set),
  submit, remove a change, discard a draft, get and list on both surfaces;
  apply and reject on MCP only, exempt from parity with that reason. A run in
  the propose mode is offered the domain whatever its words say.
- The browser lists a workspace's proposals under "Vorschläge", opens one with
  its diffs and lets a person apply or reject a selection or everything, with
  a note. The work item shows its proposals and its mode; the attention card
  links the changeset.
- A change cannot be edited by the reviewer, only taken or left. Editing a
  proposal is proposing again, which keeps what was proposed and what landed
  apart on the record.
- A new page is created and then written; a write refused after the page was
  created leaves an empty page behind. Rare, since the growth policy is the
  only refusal a fresh page can meet, and visible.
- The strict revision means a proposal on a page somebody keeps editing goes
  stale quickly. That is the promise, not a defect: the alternative is
  applying onto a state nobody reviewed. A later version could rebase a
  change whose blocks were untouched; it would be a new decision.
- Agent profiles (#143) will carry a default mode; they set the same column
  and the same claim, nothing new.
