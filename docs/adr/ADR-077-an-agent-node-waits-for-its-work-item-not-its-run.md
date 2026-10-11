# ADR-077: an agent node waits for its work item, not its run

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-066 (work items), ADR-070 (write modes and proposals),
  ADR-071 (agent profiles), ADR-072 (delegation and subtree budgets),
  ADR-075 and ADR-076 (workflow graphs and runtime), issue #162 under the
  epic #159

## Context

ADR-075 let a graph describe an agent node (goal, pages, profile, write
mode, budget, output fields) and ADR-076 gave the runtime handlers, waits and
wakes, but an agent node still failed with `workflow_node_not_executable`.
eXocortex already had everything an agent step needs: work items with
profiles, write modes, proposals, review, questions, checkpoints, delegation
and a budget over the subtree. A second way to run an agent beside them
would have to re-implement each of those rules and would drift from them.

Three questions had no answer yet: which state of a work item makes the node
finish (a run ending is not the work ending, ADR-066); how a value a model
wrote becomes something a condition may branch on; and how a run's budget
holds when its agent nodes run on parallel branches.

## Decision

**An agent node is an ordinary work item and an ordinary run of the built-in
AI, started through the REST API.** The worker creates the item and starts
its run as the person the workflow run acts for, with the workflow origin
header on its service token. Every rule of a work item applies unchanged.
The header adds exactly two things, both checked against the rows
(`verifiedWorkflowNode`: the attempt is `RUNNING`, belongs to the named run,
workflow and workspace, the run acts as the caller, and the node in the run's
own version is an agent node):

- the item records the attempt in `work_item.workflowExecutionId` (unique),
  so a retried delivery gets the same item back and starts no second run;
- the item may name the agent profile its node names in the published
  version, as an automation rule may name its own (ADR-071). The node's write
  mode and fields hold whatever the request sent; the write mode is only ever
  combined by taking the stricter.

**The node waits on the item, and the item's status decides.** `done`
completes it. `review` completes it only when the node says
`completion: review` (the default), every required field is filled in, no
proposal of the item is still open, and the last run did not work under a
`review_before_done` profile; otherwise review is a person's turn and the
node waits. `failed`, `cancelled` and a deleted item fail it. Open work
waits unless nothing can move it any more (no run pending or running, no
children awaited, not waiting on a person, the last run ended three minutes
ago), which fails it as `workflow_work_item_stalled` rather than letting it
wait until the run's lifetime ends. One pure function, `agentCompletion`,
answers this for the node's resume and for the sweep.

**A structured result is declared, written, and checked twice.** The node's
`outputFields` become the item's `resultFields`; the run writes
`structuredResult` through `exo_work_item_update`. The API checks every
write (`checkStructuredResult`: no undeclared field, the right type, an
allowed enum value) and asks for the required fields when the work is handed
in or closed as done, so a model hears about a mistake while it can still
fix it. The node checks again against its own fields when it completes and
fails with `workflow_output_invalid` if they do not hold, because a value is
trusted for being checked, never for having parsed. The node's output is
`workflowAgentResultSchema`; a condition reads `output.fields`.

**Waking is a hook with a net.** After a committed status change or deletion
the work item service tells its listeners (`afterTransition`); the
workflow module queues a `resume` for any attempt whose `waitingOn` names the
item. A wake can be lost and a run ending sends none, so the minute sweep
asks `agentCompletion` about every waiting agent node and queues a resume
only for one that would move.

**The run's budget holds across branches.** Before creating its item, a node
reserves its share under the run's row lock: the stricter of its own budget
and what the run has left after its spend and the reservations of the other
agent nodes in flight. The share is the item's budget, which the subtree
accounting of ADR-072 already holds for every run and child below it. When
the node settles, the item's subtree spend replaces the reservation in
`workflow_run.spentMicroUsd`, in the transaction that records the outcome.

## Consequences

- Nothing new executes agents: a workflow cannot reach a capability, a
  write mode or a profile that a person creating the same work item could
  not. The tests in `workflow-agent.integration.test.ts` hold the API to
  that.
- A workflow node's work is visible and steerable like any other work item:
  a person can answer its questions, review its proposals, cancel it, or
  start another run on it; the workflow follows the item.
- Cancelling a workflow run does not cancel the work items it created. They
  are ordinary work with a history of their own; whoever cancels the run
  decides about them.
- `resultFields` is fixed at creation and the browser shows it but does not
  edit it. The API refuses `review` and `done` while a required field is
  missing, for a person too; `failed` and `cancelled` stay open to anyone,
  because work must always be able to say it did not work out. A review
  asked for directly (`exo_attention_request`) is not refused, and the node
  waits for the person deciding about it.
- The `completion` field was added to the agent node with a default, so
  every graph stored before #162 still parses; it is not a `schemaVersion`
  step.
