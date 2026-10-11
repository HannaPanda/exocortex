# ADR-075: a workflow is a versioned graph, and a run reads the version it started on

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-024 and ADR-038 (automations and their schedules), ADR-066
  (work items), ADR-067 and ADR-068 (attention and human checkpoints),
  ADR-070 (proposals), ADR-071 (a profile only ever narrows), ADR-072
  (subtasks), issue #160 under the epic #159, followed by #161 to #165

## Context

Automations (ADR-024) answer "when this changes, do that" in one step. The
agent work built since (work items, delegation, checkpoints, approvals,
profiles) can do much more than one step, but nothing strings the steps
together: review something, branch on the result, run two agents side by
side, wait for a person, continue days later. FlauschiPandaBot2 has a graph
editor for exactly that shape and an executor that recurses through the whole
graph in one process. That executor is the part this deployment cannot take:
agent work lives for minutes or days, a deployment restarts several times a
day, and a run that only exists in a process's stack is lost with it.

Issue #160 is the foundation: what a workflow is, how its versions and runs
are stored, and what a valid graph is. The runtime, agent nodes, control
flow, the editor and agent authoring follow in #161 to #165 and build on it.

## Decision

**A workflow is a graph of typed nodes and typed edges, as one closed
union.** `packages/contracts/src/workflow-graph.ts` names every node type
(three triggers, `agent`, `condition`, `parallel`, `join`, `approval`, `end`),
what each is configured with and which outgoing handles it offers; an edge is
`{source: {nodeId, handle}, target: {nodeId}}` with a `kind` so a later loop
or error edge is a new member rather than a flag. A type nothing will execute
cannot be stored, so the contract boundary refuses it even in a draft.

**Two layers of validity.** The schema is the shape: types, handles named as
strings, lengths, enumerations. `validateWorkflowGraph` is the meaning, and
it is pure: edges into nodes that exist and out of handles the node offers,
one input per node except a join, one edge per handle except a fan-out, no
edge into a trigger, no cycle (a loop will be its own node if it ever
exists), every node reachable from a trigger, a join that waits for all of
its inputs never fed by two branches of one condition or approval or by two
different triggers, and a condition that reads a declared field of an agent
node upstream with an operator and a value fitting the field's type. The API
adds the problems only the database can see (an agent profile, a page or a
person outside the workspace) in the same shape. Every problem carries a
stable `code` and the node, edge or path it is about, because the reader who
has to fix it is often a program. A draft may be saved incomplete; only a
draft without problems is published.

**One mutable draft, immutable versions.** `workflow.draftGraph` is what an
editor saves; `draftRevision` moves only when the graph changes, and a save
or a publish can name the revision it expects. Publishing freezes the draft
as the next `workflow_version` with the hash of its canonical JSON; a draft
equal to the newest version publishes nothing and answers with that version.
A trigger in the migration refuses any `UPDATE` of a version's content, so
"a run reads the graph it started on" does not depend on every future writer
remembering it. A run references its version, never the workflow's draft,
and the version cannot be deleted under a run.

**A run is persisted state, never a process.** `workflow_run` holds the
version, the trigger it started from, origin, input, correlation, spend and
counters; `workflow_node_execution` holds one row per node attempt with its
status, the handles it took, its input and output, what it waits for and why
it failed, keyed by `<runId>:<nodeId>:<attempt>`, which is unique and is what
a side effect will be keyed by so a redelivered job cannot repeat it.
`workflowProgress` derives from the version's graph and those rows alone
what may run now, what can never run (the untaken branch, a join whose input
died) and whether the run is over. Starting a run writes the run and its
trigger's execution in one transaction.

**Graphs JSON, lifecycle columns.** The graph of a version is one validated
JSON document, because it is immutable and only ever read whole. Everything a
query has to answer (which workflow, which version, status, origin, when,
who, enabled) is a column, and node attempts are rows, because they have a
lifecycle and constraints of their own.

**Who decides what.** Reading is membership. Writing a draft and publishing
are an admin's (`canManageWorkflows`), switching a workflow on or off is the
owner's (`canActivateWorkflows`), like an automation: an enabled workflow
starts agents and spends money by itself. Every workflow write except
validation is of the `admin` token class, and the API refuses all of them
for a run of the built-in AI. Publishing and switching on are deliberately
no tools: an agent may draft and validate (MCP only for now), a person
decides what becomes a version and what may run unattended (issue #165).

## Consequences

- A run can be continued by any worker after any restart, because nothing
  about it lives anywhere but in its rows. The runtime of #161 claims
  `runnable` nodes, writes their attempts, and asks `workflowProgress` again.
- Changing a workflow never changes a run in flight. The price is that a run
  started on a buggy version runs to its end on it; cancelling is the answer.
- The node types are fixed by the union before their runtimes exist. #162 and
  #163 may refine their configuration; a change to the stored shape is a
  `schemaVersion` step with a migration of drafts, never a silent reread.
- Deleting a workflow is refused while a run is not terminal; the finished
  runs go with it. The audit log keeps the history of the definition.
- Nothing executes yet. A published, enabled workflow is a stored decision
  that #161 will act on, and the README says so.
