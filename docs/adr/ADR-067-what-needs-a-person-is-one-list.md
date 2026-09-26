# ADR-067: what needs a person is one list, and each entry moves once

- Status: accepted
- Date: 2026-09-26
- Relates to: ADR-066 (work items), ADR-024 (automations), ADR-052
  (notifications), ADR-025 (capability parity), issue #139, issue #42

## Context

With work items (ADR-066) an agent can wait on a person in many ways: a result
in `review`, a `blocked` item, a `waiting_for_human` item, a run that failed.
Each of those was a status somebody had to go and look for, in a list per
workspace, and an agent that needed a decision between two options had only a
free-text status reason to ask with. Issue #139 asks for one surface that
answers "what needs me right now", which carries only needs for action, never
information, and lets the simple answers be given in place.

## Decision

**An `AttentionItem` is one open need for a person's action.** A kind
(`decision`, `approval`, `review`, `blocked`, `budget`, `run_failed`,
`conflict`, `information`), a title and a reason, an urgency, a recipient
(null means anybody who may manage work in the workspace), who raised it, a
link to a work item and a run, the options as `[{ id, label }]`, and whether an
answer in words is required, optional or not taken. What merely happened is
not an attention item; it belongs to the work item's history, the page
activity and the notifications.

**An item moves once.** `OPEN` to `RESOLVED` (somebody acted) or `OBSOLETE`
(nobody has to any more), never back. Raising and settling each write who and
when on the row, with what settled it as facts (`optionId`, `note`, the work
item status it caused, the run a retry started, a reason for obsolescence), so
the row is its own audit trail and needs no event table. A work item's history
additionally gets `attention_raised` and `attention_resolved`, the second with
the answer as its note, because that is where the agent that asked reads it.

**A waiting state raises exactly one item, and leaving it settles that item.**
`review`, `blocked` and `waiting_for_human` each have a deduplication key per
work item; a partial unique index over open keys turns a second raise for the
same state into nothing. The functions that do this take the transaction of
the work item change (`attention-sync.ts`), so the status, its history line and
its attention item are one write. Closing the work settles everything still
open on it, as `OBSOLETE` when it was cancelled; deleting it does the same
before the row goes. Only a person's request raises a system item: an agent
that delegated work to a person reads the state itself.

**A failed run is asked about by a sweep, not a hook.** A run can fail in several
places (completion, admission, the queue worker's guard and two maintenance
reapers), so `raise-run-failure-attention` runs every minute and raises one item
for the latest failed run behind open work, deduplicated by the run's id, and
never a second one for a run that already had one. ADR-066 is untouched: the
work item's status still says what somebody decided. What changes is that
somebody is now asked to decide.

**A question is the waiting state.** An agent asks with
`exo_attention_request`. On a work item, a question kind (`decision`,
`approval`, `budget`, `information`) moves the item to `waiting_for_human`, and
because a question is already open the state raises no generic item beside it;
answering or withdrawing the last question moves the work to `queued`, ready to
be picked up again. A `key` makes a request idempotent per asker. `review`,
`blocked` and `run_failed` cannot be requested, so the list of what waits for
review is the list of items actually in review.

**Answering a system item is the change it stands for.** Its options have fixed
ids with effects: `accept` (done), `return` (working, the note is the reason),
`answer` and `unblock` (queued), `retry` (a new run), `give_up` (failed). The
attention service carries the answer into the work item service, which applies
the change and settles the item inside the same transaction; their words come
from the reader's catalogue. An agent's own options carry their labels and have
no effect beyond being recorded.

**One list across workspaces.** `GET /api/attention` reads every workspace the
caller is a member of; `for_me` is what is addressed to them plus the
unaddressed items where they may manage work. Answering is the recipient's or
any MEMBER's; withdrawing is the asker's or an admin's, and a system item
cannot be withdrawn because its work item's state is what raised it.

## Consequences

- Five tools in an `attention` domain on both agent surfaces; the page
  `/wartet` ("Wartet auf dich"), a count in the top bar only while something
  waits, and a work item's open items at the top of its page.
- The work item's run prompt tells the run to ask with `exo_attention_request`
  and end its turn, rather than set `waiting_for_human` by hand.
- Nothing pushes or mails an attention item yet. A notification kind for it is
  a separate decision (ADR-052); the realtime event `attention.changed` carries
  ids only, and the browser re-reads every minute for workspaces whose socket
  room it has not joined.
- A changeset came with #141 (ADR-070). It is linked through the item's
  `subject` rather than a third column: handing one in on a work item moves
  the work into `review` the same way, and deciding its last change settles
  that item.
- Pausing a run and resuming it after an answer came with #140 (ADR-068): an
  answer to a blocking question on work the assistant holds carries the
  paused run on in its own conversation; for everybody else it still puts the
  work back into the queue.
