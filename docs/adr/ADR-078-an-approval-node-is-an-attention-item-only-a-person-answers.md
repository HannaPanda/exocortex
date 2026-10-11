# ADR-078: an approval node is an attention item only a person answers

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-067 (attention items), ADR-068 (human checkpoints),
  ADR-075, ADR-076 and ADR-077 (workflow graphs, runtime, agent nodes),
  issue #163 under the epic #159

## Context

ADR-075 let a graph describe conditions, fan-outs, joins, approvals and
ends, and ADR-076 executed all of them except the approval, which failed
with `workflow_node_not_executable`. A workflow that can start agents but
cannot stop and ask somebody is only safe for work nobody needs to look at.

eXocortex already had one place for everything that waits on a person: the
attention item and its inbox, "Wartet auf dich" (ADR-067), with a rule for
who may answer, a way to answer from the browser and through MCP, and an
item that moves once and never reopens. A second notification or permission
system for workflows would drift from it and leave people with two inboxes.

Four more questions were open. A condition could only read an agent node's
fields, so nothing could branch on what a person answered or on what started
the run. An end node succeeded and the run went on until nothing else was in
flight, so "end here" meant "end here once the other branches are done". A
join waiting for any input continued on the first branch, but a branch that
failed afterwards still failed the run. And an approval that was still open
when its run was cancelled would have stayed in somebody's inbox, asking
about a run that no longer existed.

## Decision

**An approval node is an ordinary attention item.** The worker raises it
through `raiseAttentionItems` with kind `approval`, the node's title and
question, the named person or nobody in particular (anybody who may manage
work in the workspace), the options `approve` and `reject` (their words come
from the reader's catalogue, like the system options), the note mode the
node asks for, and `system: true`, because the item is withdrawn only by
its run ending. The item records the attempt in
`attention_item.workflowExecutionId`, which is unique: a second delivery of
the attempt finds the item the first one raised and asks nothing twice.

**Only a person answers it.** The answer goes through the ordinary
`POST /api/attention/:id/resolve` and its rule (the recipient, or anybody who
may manage work). On top of that, an item with a workflow attempt refuses a
request that arrived as an agent or as the built-in AI
(`attention_human_only`), read from how the request arrived
(`WorkItemActor.kind`), not from the account: Johanna's token behind an
external agent is her account, and a gate the workflow's own agents could
open would be a formality.

**The node resumes from the row, never from the wake.** After the answer is
committed, the attention service tells its listeners; the workflow wake
queues a `resume` for the attempt waiting on that item. The resumed handler
reads the item: open waits on, `approve` takes the `approved` handle,
`reject` the `rejected` one, obsolete or gone fails as
`workflow_approval_gone`. The claim requires the attempt to be `WAITING`, so
an answer delivered twice, or a wake for an item still open, moves nothing.
A wake that is lost is found by the minute sweep, which looks at items
settled in the last day whose attempt still waits; an open question costs it
nothing, however many days it stays open. Waiting holds no worker and no
job, so a question can outlive any number of deployments, bounded only by
the run's lifetime.

**What a person answered is an output like an agent's.** The node's output
keeps `fields: {approved, note}`, the shape a condition and a goal
placeholder already read from an agent (`WORKFLOW_APPROVAL_FIELDS`), plus
who answered and when. A condition may also read a key of the run's input
(`source: {input}`), untyped, so a comparison of the wrong type is false.
A condition records the value it read, so the history shows why a branch was
taken.

**An end node ends the run at once.** The advance after an end node has run
finishes the run with that node's outcome and summary, cancelling whatever
is still in flight; two ends reached together resolve as failed, then
cancelled, then succeeded. The summary is stored on the run (`summary`,
`endNodeId`).

**A join for any input absorbs the branches it did not wait for.** A failed
node whose branch leads into a join with policy `any` that ran does not fail
the run; one with no such join still does.

**An ending run settles its open approvals.** Cancelling, timing out, an end
node, or any other ending marks the open approvals of its attempts obsolete
with the reason `workflow_ended`, in the transaction that ends the run, and
the inboxes are told after commit.

## Consequences

- No second notification, inbox or permission rule exists for workflows. The
  card names the workflow instead of the person the run acts as, because
  that person switched the workflow on and is not the one asking.
- An approval gate cannot be answered by any agent, including a person's own
  agent working through MCP. That is the point, and it means an unattended
  workflow with an approval needs a person to come by.
- Ending at an end node is a change from ADR-076, where the run waited for
  every branch. A graph that wants all branches done puts the end after a
  join.
- A failed branch into a join for any input is tolerated. A graph that wants
  every failure to count uses a join for all inputs.
- The item outlives the run it asked for: deleting the workflow leaves the
  settled question on record without a link to it.
