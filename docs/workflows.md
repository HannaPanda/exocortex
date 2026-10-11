# Agent workflows

Issues #160, #161, #162, #163, #164 and #165 under the epic #159,
[ADR-075](adr/ADR-075-a-workflow-run-reads-the-version-it-started-on.md),
[ADR-076](adr/ADR-076-a-workflow-run-moves-one-persisted-transition-at-a-time.md),
[ADR-077](adr/ADR-077-an-agent-node-waits-for-its-work-item-not-its-run.md),
[ADR-078](adr/ADR-078-an-approval-node-is-an-attention-item-only-a-person-answers.md),
[ADR-079](adr/ADR-079-a-test-run-is-a-real-run-under-a-write-mode-ceiling.md) and
[ADR-080](adr/ADR-080-an-agent-writes-a-workflow-draft-and-a-person-publishes-it.md).
A workflow is a versioned graph of typed nodes and edges: triggers start it,
agent nodes hand work to the built-in AI, control nodes branch, fan out, join,
ask a person and end it. This document covers what exists today: the graph
contract, its validation, drafts and versions, the runtime that executes
runs, agent nodes, approvals and control flow, the editor and run
debugger in the browser, and drafts written by agents.

## Where things are

| Piece          | Location                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Graph contract | `packages/contracts/src/workflow-graph.ts`: node and edge unions, handles, limits                    |
| Validation     | `packages/contracts/src/workflow-validation.ts`: `validateWorkflowGraph`, problem codes              |
| Progress       | `packages/contracts/src/workflow-progress.ts`: `workflowProgress` over node executions               |
| Wire contract  | `packages/contracts/src/workflows.ts`: requests, responses, run and execution statuses, wait reasons |
| Tables         | `workflow`, `workflow_version`, `workflow_run`, `workflow_node_execution` (`schema.prisma`)          |
| Immutability   | trigger `workflow_version_immutable` in migration `20261011020000_agent_workflows`                   |
| REST           | `apps/api/src/workflows/` (controller, definition service, run service, reference checks, mapper)    |
| Policies       | `canManageWorkflows` (ADMIN), `canActivateWorkflows` (OWNER) in `packages/auth/src/policies.ts`      |
| Tools          | `packages/mcp-tools/src/tools/workflows.ts`, domain `workflows`                                      |
| Words          | feature entries `agenten-workflows`, `workflow-laeufe`; error codes `workflow_*` in `errors`         |
| Runtime        | `apps/worker/src/workflows/`: `runtime.ts`, `handlers.ts`, `triggers.ts`, `sweep.ts`                 |
| Shared writes  | `packages/database/src/workflow-runs.ts`: start, cancel, lock, history events, trigger projection    |
| Runtime words  | `packages/contracts/src/workflow-runtime.ts`: limits, run error codes, event types, origin header    |
| Tables         | `workflow_trigger` (self-starting triggers), `workflow_run_event` (history), leases on attempts      |
| Agent node     | `apps/worker/src/workflows/agent-node.ts`, `agent-completion.ts`, `goal-template.ts`                 |
| Result         | `packages/contracts/src/workflow-result.ts`: `checkStructuredResult`, `workflowAgentResultSchema`    |
| Wake           | `apps/api/src/workflows/workflow-wake.service.ts`, `apps/api/src/work-items/work-item-workflow.ts`   |
| Approval node  | `apps/worker/src/workflows/approval-node.ts`; `attention_item.workflowExecutionId`                   |
| Envelope       | `packages/contracts/src/workflow-envelope.ts`: `workflowAgentNodeEffect`; `envelope` on the GET      |
| Editor         | `apps/web/src/components/workflows/`; routes under `/arbeitsbereich/:id/workflows`                   |
| Editing        | `workflow-draft.ts` (pure graph edits), `workflow-run-view.ts` (a run on its graph), both tested     |
| Agent drafts   | `apps/api/src/workflows/workflow-author-envelope.ts`; `draftAuthor*` columns on both tables          |

## Routes

| Route                                | What                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /api/workspaces/:id/workflows`  | every workflow with its published version, switch and active runs               |
| `POST /api/workspaces/:id/workflows` | a draft; one manual trigger when no graph is sent; ADMIN; write class           |
| `GET /api/workflows/:id`             | the summary, the draft graph, its problems and the workspace's `envelope`       |
| `PATCH /api/workflows/:id`           | name, description, graph; `expectedRevision` refuses a lost edit; ADMIN         |
| `POST /api/workflows/:id/duplicate`  | copies the draft into a new, unpublished workflow; ADMIN; write class           |
| `POST /api/workflows/:id/validate`   | checks the sent graph, or the draft; stores nothing; a read-class request       |
| `POST /api/workflows/:id/publish`    | freezes revision `expectedRevision` as the next version; a person only          |
| `POST /api/workflows/:id/activation` | `{enabled}`; OWNER; a person only; only a published workflow can be switched on |
| `DELETE /api/workflows/:id`          | refused while a run is not terminal; finished runs go with it                   |
| `GET /api/workflows/:id/versions`    | the versions, newest first, without their graphs                                |
| `GET /api/workflow-versions/:id`     | one version with its graph and hash                                             |
| `GET /api/workflows/:id/runs`        | the latest 50 runs                                                              |
| `POST /api/workflows/:id/runs`       | starts a run by hand, or a test (`test`, `writeMode`); ADMIN; never the AI      |
| `GET /api/workflow-runs/:id`         | the run, its graph, every node attempt, the history and `workflowProgress`      |
| `POST /api/workflow-runs/:id/cancel` | cancels what is queued, running or waiting; ADMIN; never a run of the AI        |

## The graph

```json
{
  "schemaVersion": 1,
  "nodes": [
    { "id": "start", "type": "trigger.manual" },
    {
      "id": "review",
      "type": "agent",
      "goal": "Review my open technical ideas and score the best one",
      "agentProfileId": null,
      "writeMode": "propose",
      "outputFields": [{ "name": "score", "type": "number" }]
    },
    {
      "id": "good",
      "type": "condition",
      "source": { "nodeId": "review", "field": "score" },
      "operator": "gte",
      "value": 7
    },
    { "id": "ask", "type": "approval", "title": "Start it?", "question": "Shall I plan it?" },
    { "id": "done", "type": "end", "outcome": "succeeded" }
  ],
  "edges": [
    {
      "id": "e1",
      "kind": "flow",
      "source": { "nodeId": "start", "handle": "next" },
      "target": { "nodeId": "review" }
    },
    {
      "id": "e2",
      "kind": "flow",
      "source": { "nodeId": "review", "handle": "next" },
      "target": { "nodeId": "good" }
    },
    {
      "id": "e3",
      "kind": "flow",
      "source": { "nodeId": "good", "handle": "true" },
      "target": { "nodeId": "ask" }
    },
    {
      "id": "e4",
      "kind": "flow",
      "source": { "nodeId": "good", "handle": "false" },
      "target": { "nodeId": "done" }
    }
  ],
  "limits": {
    "maxNodeExecutions": 20,
    "maxParallelBranches": null,
    "maxLifetimeSeconds": null,
    "budgetMicroUsd": 500000
  }
}
```

| Type               | Configured with                                                                                      | Handles                |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------- |
| `trigger.manual`   | nothing                                                                                              | `next`                 |
| `trigger.schedule` | `schedule`: `ONCE`/`DAILY`/`WEEKLY`/`MONTHLY`/`CRON` with `timeZone`                                 | `next`                 |
| `trigger.event`    | `events` (automation triggers except `SCHEDULE`), `scopeDocumentId`                                  | `next`                 |
| `agent`            | `goal`, `documentIds`, `agentProfileId`, `writeMode`, `budgetMicroUsd`, `outputFields`, `completion` | `next`                 |
| `condition`        | `source {nodeId, field}` or `source {input}`, `operator`, `value`                                    | `true`, `false`        |
| `parallel`         | nothing                                                                                              | `branch` (2 or more)   |
| `join`             | `policy`: `all` or `any`                                                                             | `next`                 |
| `approval`         | `title`, `question`, `assigneeUserId`, `note` (`none`/`optional`/`required`)                         | `approved`, `rejected` |
| `end`              | `outcome`: `succeeded`/`failed`/`cancelled`, `summary`                                               | none                   |

`label` and `position` are on every node for the editor and mean nothing to
execution. A graph's `limits` can only narrow: the runtime will combine each
with the deployment's, the workspace's, the profile's and the work item's by
taking the stricter.

## Rules to know before changing anything

- **The schema is the boundary, validation is the meaning.** A field that is
  required to publish (an agent's goal, an approval's question) is optional in
  the schema and reported as `field_required`, so a half-written draft can be
  saved. A type, a handle or an enumeration is never optional.
- **A new node type is a contract change in four places**: the union and
  `WORKFLOW_NODE_HANDLES` in `workflow-graph.ts`, its checks in
  `workflow-validation.ts`, its references in `apps/api/src/workflows/workflow-references.ts`
  when it names something in the database, and the description in the tool
  help (`GRAPH_HELP`). A change to an existing type's stored shape is a
  `schemaVersion` step with a migration of the drafts.
- **A problem names its element.** New checks go through `problem()` with a
  code from `WORKFLOW_PROBLEM_CODES`; an agent repairing a graph reads the
  code, never the message.
- **A version is never edited.** The trigger refuses it; do not work around it
  with a delete and insert, because a run references the row.
- **Progress is derived, never stored.** `workflowProgress` reads the latest
  attempt per node. A runtime records `SKIPPED` for what it reports as dead
  rather than inventing a status of its own.
- **The draft revision moves with the graph only.** Renaming a workflow does
  not invalidate an editor's open graph.

## The runtime (issue #161, ADR-076)

A run moves one transition per job on the `workflow` queue, and every
transition is committed before the next is scheduled:

| Job           | What it does                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `advance`     | locks the run, records dead nodes as `skipped`, queues what the limits allow, finishes the run |
| `execute`     | claims one queued attempt with a lease, runs its handler, records the outcome if still leased  |
| `resume`      | the same for a waiting attempt, with what woke it (a timer, a work item, an attention item)    |
| `start-event` | starts a run once the minute's debounce after a page change has passed                         |

What runs where:

- **Handlers** (`handlers.ts`) execute `condition`, `parallel`, `join` and
  `end`; `agent` is `agent-node.ts` and `approval` is `approval-node.ts`
  (both below). A handler answers
  `succeeded` with handles and output, `waiting` with a `workflowWaitSchema`
  object, or `failed` with an error class; it never writes its own row, and
  it keys any side effect by `execution.idempotencyKey`.
- **Idempotent or not** is the handler's declaration. Only an idempotent
  handler is retried after `retryable` (10 s, 40 s, 160 s, three attempts)
  or queued again after its worker vanished; any other is failed as
  `workflow_node_interrupted`.
- **Limits** are frozen on the run when it starts, each the stricter of the
  graph's and the workspace's `workflows.*` setting: attempts
  (`workflow_node_limit`), attempts in flight (waiting ones count; the rest
  is held back), lifetime (`timed_out`, `workflow_lifetime_exceeded`) and
  budget (`workflow_budget_exhausted`). `workflows.enabled` defaults off and
  stops a run in flight at its next step (`cancelled`, `workflow_disabled`).
- **Starting by itself** reads `workflow_trigger`, which holds a row per
  schedule and event trigger exactly while the workflow is switched on; it is
  rebuilt by `syncWorkflowTriggers` when a workflow is published or switched.
  Event triggers hang off the outbox dispatcher; schedules off the sweep. A
  self-started run acts as `enabledById`, whoever switched it on.
- **Loop protection**: a node's write carries `x-exocortex-workflow`
  (`<workflowId>:<runId>:<executionId>:<depth>`, service tokens only), which
  the outbox row keeps. A workflow never starts from its own row, and the
  depth is shared with automations (`AUTOMATION_MAX_DEPTH`).
- **The sweep** (`sweep-workflow-runs`, every minute) recovers expired leases,
  re-queues steps due for two minutes, wakes due timers, advances stale runs
  and runs past their deadline, starts due schedules, and wakes agent and
  approval nodes whose object has moved without its wake arriving.
- **The history** (`workflow_run_event`) is facts: node queued, started,
  succeeded, failed, retry scheduled, waiting, resumed, skipped, cancelled,
  recovered, edge taken, limit reached, run started, finished, cancelled.

## Agent nodes (issue #162, ADR-077)

An agent node hands its goal to an ordinary work item and an ordinary run of
the built-in AI, and waits for the item.

1. **Reserve.** Under the run's lock the attempt reserves its budget: the
   stricter of `budgetMicroUsd` and what the run has left after its spend and
   the reservations of the other agent attempts in flight. Stored on the
   attempt's `input`, so a redelivery keeps it. Nothing left fails the node
   as `workflow_budget_exhausted`.
2. **Create and start.** `POST /api/workspaces/:id/work-items`, then
   `POST /api/work-items/:id/runs`, as `run.startedById`, with
   `x-exocortex-workflow`. The API verifies the origin against the rows
   (`verifiedWorkflowNode`), stores the attempt in
   `work_item.workflowExecutionId` (a second create answers with the same
   item), takes the node's `outputFields` as `resultFields` and the stricter
   write mode, and accepts `agentProfileId` only when the published version
   names exactly that profile. The goal's placeholders are filled first
   (`{{node.field}}` from an upstream agent's `fields`, `{{input.key}}` from
   the run's input; validation refuses one that names nothing). A run started
   by a page change puts that page first in the context. A 4xx is
   `workflow_agent_refused`; anything else is thrown and retried.
3. **Wait.** The attempt waits on `{kind: 'work_item'}`. The API's
   `afterTransition` hook queues a `resume` after every committed status
   change or deletion; the sweep queues one for any waiting agent node that
   `agentCompletion` says would move.
4. **Settle.** `agentCompletion` reads the item: `done` completes, `review`
   completes when `completion` is `review`, the required fields are there, no
   changeset of the item is open and the last run's profile does not want
   review before done; `failed`, `cancelled` and a deleted item fail; open
   work with no run pending or running, no children awaited, and its last run
   ended three minutes ago is `workflow_work_item_stalled`. The fields are
   checked against the node once more (`workflow_output_invalid`). The
   output is `workflowAgentResultSchema` (`outcome`, `fields`, `workItemId`,
   `aiRunId`, `resultDocumentIds`, `contextDocumentIds`, `summary`,
   `spentMicroUsd`); a condition reads `output.fields`. The item's subtree
   spend is added to `workflow_run.spentMicroUsd` in the same transaction.

Cancelling the run leaves the work items alone; they are ordinary work.

Adding a node type's execution means a handler in `DEFAULT_NODE_HANDLERS`
(or in `handlerFor` in `shared.ts` when it needs the database), a decision
whether it is idempotent, and, when it waits, a `resume`, the hook that
sends the `resume` job when its object has an answer, and a net in the sweep.

## Approvals and control flow (issue #163, ADR-078)

**Approval.** The node raises an ordinary attention item (kind `approval`,
options `approve`/`reject`, `system: true`, the node's note mode) with
`workflowExecutionId` set to the attempt; the column is unique, so a
redelivery finds the item instead of raising a second. It lands in "Wartet
auf dich" for `assigneeUserId` while that person is an active member, for
everybody who may manage work otherwise. The attempt waits on
`{kind: 'attention_item'}` and holds no worker.

- **Answering** is `POST /api/attention/:id/resolve` (`exo_attention_resolve`),
  and only a person may: a request that arrived as an agent or the built-in
  AI is refused with `attention_human_only`. An item cannot be withdrawn.
- **Waking**: `AttentionService.onWorkflowAnswer` tells `WorkflowWakeService`
  after the answer is committed, which queues the `resume`. The sweep looks
  at items settled in the last day whose attempt still waits.
- **Resuming** reads the item, never the wake: open waits on, `approve` takes
  `approved`, `reject` takes `rejected`, anything else fails as
  `workflow_approval_gone`. The output is `{fields: {approved, note},
attentionItemId, answeredById, answeredAt}`.
- **Ending** a run in any way (cancel, timeout, an end node, a failure)
  makes its open approvals obsolete with the reason `workflow_ended`.

**Condition.** Reads `output.fields[field]` of an upstream agent or approval
node (`workflowNodeOutputFields`), or `input[key]` of the run with
`source: {input: key}`. A missing value is absent; a comparison of the wrong
type is false. The output is `{result, value}`.

**Join.** `all` continues when every input fired and is dead when one cannot;
`any` continues on the first and never again. A failed node whose branch
leads into an `any` join that ran does not fail the run.

**End.** Reaching an end node ends the run at once with its outcome
(`succeeded`, `failed` as `workflow_end_outcome`, `cancelled`), its
`summary` on the run and `endNodeId` beside it, and cancels what is still in
flight. Two at once: failed before cancelled before succeeded.

## Statuses

A run is `queued`, `running`, `waiting` (a node waits for something durable,
no worker held), then one of the terminal `succeeded`, `failed`, `cancelled`,
`timed_out`. A node attempt additionally knows `skipped`. A failed attempt
carries an error class: `retryable` (the only one a runtime retries, bounded),
`terminal`, `timeout`, `cancelled`, `limit_exceeded`. What a waiting node
waits for is `waitingOn`: a work item, an attention item or a timer. A run
that ended at an end node carries its `summary` and `endNodeId`.

## The editor and the run debugger (issue #164, ADR-079)

`/arbeitsbereich/:id/workflows` lists the workflows; each opens in the
editor, whose tabs are the draft, its runs and its published versions; a run
opens in the debugger under `…/workflows/:id/laeufe/:runId`.

- **One model.** The editor holds the contract's `WorkflowGraph` and nothing
  else. Every gesture is a function in `workflow-draft.ts` (`addNode`,
  `connect`, `removeNodes`, `duplicateNode`, `replaceNode`, `moveNode`), and
  the canvas (`workflow-canvas.tsx`, React Flow) only reports gestures back.
  React Flow keeps what it measured and a drag in progress; the graph is
  merged in while rendering, never from an effect.
- **No pointer needed.** A palette button adds a node after the selected one
  and wires it into its next free handle; the panel offers each handle's
  target as a choice and a fan-out's branches as a list. The canvas is
  keyboard-operable through React Flow's own node focus, with its labels
  translated in `workflows.canvas.a11y`.
- **Validation as you type.** `validateWorkflowGraph` runs on every change
  and its problems sit on their node (a count and a border) or edge (dashed);
  a problem in the list selects and centres its element. The server's
  `reference_not_found` problems are added from the last save. A draft the
  schema refuses cannot be saved; one with problems can, and only cannot be
  published.
- **Effective values.** An agent node shows the write mode and budget that
  will hold (`workflowAgentNodeEffect`), the graph's limits show the
  workspace's value beside them, and switching on lists the published
  version's triggers, agents and limits before it is confirmed.
- **Saving and conflicts.** A save sends `expectedRevision`; a
  `workflow_revision_conflict` keeps the local draft and offers to load the
  newer one. `Strg + S` saves; leaving with unsaved changes asks first.
- **Test runs.** `POST /api/workflows/:id/runs` with `test: true` starts the
  published version from any trigger, with `origin: test` and a write-mode
  ceiling on the run (`workflow_run.writeMode`, `propose` unless the request
  names one). Each agent node asks for the stricter of its own mode and the
  ceiling (`agent-node.ts`), and the work item combines it with the profile
  and the workspace as always.
- **The debugger** is `workflowRunView` over the run's own rows: the latest
  attempt per node as its state (icon and word), edges whose source took
  their handle as the taken path, retries, waits with what they wait on,
  links to the work item and the AI run, the structured output, spend
  against budget and the history. An unfinished run is read every three
  seconds.

Adding a node type to the editor means a default in `newNode`, its form in
`workflow-node-forms.tsx` (or its own file), its summary line in
`workflow-summaries.ts`, an icon in `NODE_ICONS` and its words in the
`workflows` catalogue.

## Drafts written by agents (issue #165, ADR-080)

An agent may write a draft; only a person publishes it and switches it on.

- **Who may draft.** Create, update and duplicate are `write`-class routes
  (`requestClassFor`), so an agent with a writing token may draft; the role
  is still ADMIN. The tools are on both surfaces in the `workflows` domain.
- **Who may decide.** `publish` and `activation` answer `workflow_human_only`
  to an agent session and to a service token (`assertMay(..., 'person')`,
  using `workItemActorOf`). Publish needs `expectedRevision`, so a person
  publishes the revision they reviewed and nothing an agent wrote since.
- **Provenance.** `workflow.draftAuthorKind`, `draftAuthorId`,
  `draftAgentLabel`, `draftAiRunId` and `draftAuthoredAt` move with the
  graph (`authorColumns`), never with a rename. Publishing copies them onto
  `workflow_version`, where the immutability trigger covers them. The wire
  carries `draftAuthor` on the summary and on each version; the editor shows
  an agent's draft above everything (`workflow-agent-draft`) and the
  versions tab names who wrote each graph.
- **The built-in AI's envelope.** `authorEnvelopeProblems` compares each
  agent node's profile (the workspace default when it names none) with the
  run's own by `profileNoLooser`, the rule children are held to (ADR-072).
  A looser one refuses the write with `workflow_exceeds_author` and the
  problems as `profile_looser_than_author`. A proposing or read-only run
  never gets this far, because a draft is a write. Deleting is refused to a
  run.
- **Repairing.** `exo_workflow_validate` takes a graph and answers with codes
  and element ids. `EXAMPLE_WORKFLOW_GRAPH` in the tool file is the example
  every drafting tool's description carries, and `workflows.test.ts` proves it
  publishes as it is: keep it valid when the contract changes.

A minimal session for an agent, in order: `exo_workflow_create` with the
graph, `exo_workflow_validate` until `valid` is true, `exo_workflow_update`
with `expectedRevision`, then tell the person where to find it. A
`[edge_invalid_handle]` names the edge and the handles the source offers; a
`[field_required]` names the node; a `[reference_not_found]` a profile, page
or person outside the workspace.
