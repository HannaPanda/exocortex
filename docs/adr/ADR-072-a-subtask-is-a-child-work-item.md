# ADR-072: a subtask is a child work item, and its parent waits by ending its run

- Status: accepted
- Date: 2026-10-10
- Relates to: ADR-066 (work items), ADR-067 (attention), ADR-068 (a checkpoint
  pauses the run), ADR-069 (working states), ADR-070 (write modes), ADR-071
  (agent profiles), issue #144, issue #42

## Context

Issue #42 names sub-agents as a later capability, and the usual way to build
them is inside the agent loop: a run spawns a second loop, waits for it in
memory and pastes its transcript back. That is a mechanism nobody else can
see, budget, interrupt, answer or hand to a person. Work items (ADR-066)
already have a parent, a budget, a profile, runs, a status, a result and
questions; what was missing is a way for the work to be split by the agent
doing it, a way for the parts to come back, and rules that keep a part from
being a way around the limits of the whole.

## Decision

**A subtask is a child work item.** `POST /api/work-items/:id/delegate`
creates it through the ordinary create, with its own context, profile,
budget, runs, status, result and questions, assigned to the built-in AI by
default and started at once when the AI holds it. It can as well go to an
agent account or a person: delegation is not a multi-agent feature, it is the
work item model used from inside a run. The parent's history says `delegated`
in the same transaction.

**A budget holds for the subtree.** What every run below an item cost counts
against it, and a run anywhere is refused once any item above it has spent
what it was given; the detail names the ancestor whose budget is the tight
one. A child's own budget is carved out of what is left and can never exceed
it. Without this, handing everything on would be a way never to touch the
parent's budget at all.

**A child never writes more freely than its parent or the one who handed it
on.** Its write mode is the stricter of the request, the parent's own and the
caller's ceiling (a proposing token proposes, a run is held to the mode in
its service token). Delegating and waiting are `report` requests, so a run in
the proposal mode can split its work and every part stays proposing.

**A profile for a child may narrow, never loosen.** Choosing a profile is
loosening as far as anybody can tell (ADR-071), except when every limit the
candidate sets is at least as strict as the parent's effective profile:
tool domains a subset, write mode, approval policy, budgets, turns, run time
and confinement. That is compared field by field (`profileNoLooser`), and a
parent under no profile allows every profile, because a profile only narrows.
Anything else still takes a person or a writing token.

**Proposing parts run together, writing parts one after another.** A child
held to `read_only` or `propose` changes no page, so any number run at once.
A child that writes directly (inheriting counts as direct) is refused a run
while a directly writing sibling has one in flight; the refusal names it, and
the child exists either way, so the parent can start it later or hand the
part on as a proposal.

**A parent waits by ending its run.** `await-children` records the children,
the run from the signed claim of its token and the moment, and the tool tells
the loop to end after the turn, exactly as a blocking question does
(ADR-068). A child has come back when it is in review or closed, which is
somebody's decision, never derived from its run (ADR-066). Every path that
moves a child there calls one listener after its transaction; the listener
claims the wait with a conditional update on `awaitingSince`, so two children
returning at once carry the parent on once, and posts the children's results
into the paused run's own conversation. Without a conversation a new run
starts from the newest working state (ADR-069). A failed resume is written
into the parent's history and the work stays where it was.

**What comes back is the distilled result, never the transcript.** Each
child's status, its result in words cut to a share of a fixed budget, its
result pages, criteria and cost. The full result is one read away; how the
child got there stays on the child. A parent with ten children must not
receive ten conversations.

**A parent is not done while a part is open.** `done` is refused while a
child is open or in review; cancelling and failing stay possible, because
ending the whole is a decision about the parts too.

## Consequences

- There is no sub-agent mechanism in the worker. A child's run is an ordinary
  run of an ordinary work item, with its own profile snapshot, its own
  attention items and its own checkpoints; everything that already shows,
  limits or audits work items shows, limits and audits subtasks.
- A child in review raises a review item for the person who asked for the
  parent, like any work in review. When the parent's run accepts it first,
  the item settles itself; when the person does, the parent sees `done`.
- Waiting has an in-process retry for the moment between the waiting call and
  the end of the run's turn. A restart in that minute leaves the wait recorded
  and the children back; the next child change or a manual start carries on.
- Waiting is a run's move; a person waiting for parts reads them on the
  parent's page. The browser shows the progress, the wait and each child's
  result through the same read the run uses.
