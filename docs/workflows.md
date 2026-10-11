# Agent workflows

Issue #160 under the epic #159,
[ADR-075](adr/ADR-075-a-workflow-run-reads-the-version-it-started-on.md).
A workflow is a versioned graph of typed nodes and edges: triggers start it,
agent nodes hand work to the built-in AI, control nodes branch, fan out, join,
ask a person and end it. This document covers what exists today: the graph
contract, its validation, drafts and versions, and the persisted state of a
run. Executing runs (#161), agent and control nodes at runtime (#162, #163),
the editor (#164) and agent authoring (#165) are not built yet.

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
| Words          | feature entry `agenten-workflows`; error codes `workflow_*` in the `errors` namespace                |

## Routes

| Route                                | What                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /api/workspaces/:id/workflows`  | every workflow with its published version, switch and active runs               |
| `POST /api/workspaces/:id/workflows` | a draft; one manual trigger when no graph is sent; ADMIN                        |
| `GET /api/workflows/:id`             | the summary, the draft graph and its problems                                   |
| `PATCH /api/workflows/:id`           | name, description, graph; `expectedRevision` refuses a lost edit; ADMIN         |
| `POST /api/workflows/:id/validate`   | checks the sent graph, or the draft; stores nothing; a read-class request       |
| `POST /api/workflows/:id/publish`    | freezes the draft as the next version, or answers with the identical newest one |
| `POST /api/workflows/:id/activation` | `{enabled}`; OWNER; only a published workflow can be switched on                |
| `DELETE /api/workflows/:id`          | refused while a run is not terminal; finished runs go with it                   |
| `GET /api/workflows/:id/versions`    | the versions, newest first, without their graphs                                |
| `GET /api/workflow-versions/:id`     | one version with its graph and hash                                             |
| `GET /api/workflows/:id/runs`        | the latest 50 runs                                                              |
| `GET /api/workflow-runs/:id`         | the run, its version's graph, every node attempt and `workflowProgress`         |

There is no route that starts a run: `WorkflowRunsService.start` exists for the
runtime of #161, and a run nobody executes would sit queued for ever.

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

| Type               | Configured with                                                                        | Handles                |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------- |
| `trigger.manual`   | nothing                                                                                | `next`                 |
| `trigger.schedule` | `schedule`: `ONCE`/`DAILY`/`WEEKLY`/`MONTHLY`/`CRON` with `timeZone`                   | `next`                 |
| `trigger.event`    | `events` (automation triggers except `SCHEDULE`), `scopeDocumentId`                    | `next`                 |
| `agent`            | `goal`, `documentIds`, `agentProfileId`, `writeMode`, `budgetMicroUsd`, `outputFields` | `next`                 |
| `condition`        | `source {nodeId, field}`, `operator`, `value`                                          | `true`, `false`        |
| `parallel`         | nothing                                                                                | `branch` (2 or more)   |
| `join`             | `policy`: `all` or `any`                                                               | `next`                 |
| `approval`         | `title`, `question`, `assigneeUserId`                                                  | `approved`, `rejected` |
| `end`              | `outcome`: `succeeded`/`failed`/`cancelled`, `summary`                                 | none                   |

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

## Statuses

A run is `queued`, `running`, `waiting` (a node waits for something durable,
no worker held), then one of the terminal `succeeded`, `failed`, `cancelled`,
`timed_out`. A node attempt additionally knows `skipped`. A failed attempt
carries an error class: `retryable` (the only one a runtime retries, bounded),
`terminal`, `timeout`, `cancelled`, `limit_exceeded`. What a waiting node
waits for is `waitingOn`: a work item, an attention item or a timer.
