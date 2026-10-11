# ADR-079: a test run is a real run under a write-mode ceiling

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-070 (write modes), ADR-071 (agent profiles), ADR-075 to
  ADR-078 (workflow graphs, runtime, agent and approval nodes), issue #164
  under the epic #159

## Context

The editor of issue #164 has to let a person try a workflow before
switching it on. Two answers were plausible. A simulation in the browser
would be harmless and cheap, and it would also be a second interpreter of
the graph that agrees with the worker only until somebody changes one of
them; it could not show what an agent step really does, which is the part
worth trying. A real run is exactly what will happen later, including the
work items, the assistant's runs and their cost, and by default also the
pages an agent with the `direct` mode writes.

The same question came up for the editor's display of consequential
settings. A node says `writeMode: direct`, but whether it writes directly is
decided by the profile, the workspace's `ai.writeMode` and the work item,
each narrowing the others (ADR-070, ADR-071). A panel showing the node's
value alone would show a permission nobody has.

## Decision

1. **A test run is an ordinary run with `origin: test`.** It runs the
   published version on the real runtime and may start from any trigger of
   that version, a schedule or an event trigger included, with whatever
   `input` the person hands it. It needs `workflows.enabled` like any run,
   and an admin like a manual start; a run of the built-in AI cannot start
   one.
2. **A run carries a write-mode ceiling** (`workflow_run.writeMode`,
   `AiWriteMode`, nullable). Every agent node of the run asks for the
   stricter of its own mode and the ceiling, and the work item combines that
   with the published node's mode, the profile's and the workspace's as
   before, so the ceiling can only narrow. A test run's ceiling is `propose`
   unless the request names another; a manual run has none unless it names
   one. Loosening a test to `direct` is an explicit choice the editor shows
   with a warning.
3. **The draft is never run.** A test needs a published version; the editor
   says so and says when the draft is ahead of it. Publishing is not
   switching on (ADR-075), so trying a version does not make it start by
   itself.
4. **What a workflow will run under is answered by the API.**
   `GET /api/workflows/:id` carries an `envelope`: `workflows.enabled`, the
   workspace's `ai.writeMode`, and the limits a run started now would freeze.
   `workflowAgentNodeEffect` in `packages/contracts` combines a node with the
   envelope and the workspace's profiles into the effective profile, write
   mode and budget, the same combination the work item applies, and the
   editor shows that beside the configured value.

## Consequences

- Trying a workflow costs what running it costs. The editor says so in the
  test dialog, and the run's spend is shown against its budget.
- A proposing test leaves proposals behind for a person to apply or reject,
  which is the point: the test shows what the agent wanted to change.
- The ceiling is a column on the run, so a test's restriction survives
  every worker restart, and the debugger and `exo_workflow_run_get` report
  it.
- `workflowAgentNodeEffect` is a promise, not the decision. The run decides
  again when it starts, from the rows, which is what a later profile change
  would also change.
