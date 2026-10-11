# ADR-076: a workflow run moves one persisted transition at a time

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-010 (outbox), ADR-024 and ADR-038 (automations, their
  loop guard and schedules), ADR-075 (workflow graphs and versions), issue
  #161 under the epic #159, followed by #162 to #165

## Context

ADR-075 stored what a workflow is and what a run has done, and derived from
those rows alone what may run next. Nothing executed a run. The executor this
design replaces (FlauschiPandaBot2) recursed through the whole graph in one
process; a run that lives in a stack is lost with the process, and the agent
work a workflow will start (#162) takes minutes or days, across several
deployments a day.

The runtime has to survive a worker killed between any two steps, a queue
that delivers a job twice or not at all, two workers picking up the same
job, and a graph that would run for ever. It must not hold a worker while it
waits, and it must not let a workflow wake itself through its own writes.

## Decision

**A run is advanced one transition per job, and each transition is
committed before the next is scheduled.** The `workflow` queue carries four
kinds of job, none with state of its own: `advance` (what may run next),
`execute` (one node attempt), `resume` (a waiting attempt whose object
arrived) and `start-event` (a debounced start from a page change). Whatever
a job needs it reads from the run and its node executions.

**Every writer of a run holds the run's row lock.** `lockWorkflowRun` is an
UPDATE of `advancedAt`, so two advances, a claim and a completion of the
same run serialise in the database, and the history events they write
(`workflow_run_event`, numbered by `eventCount`) come out in the order things
happened.

**An attempt is claimed with a lease before its handler runs, and only the
lease holder records a result.** The claim is a conditional update from
`QUEUED` (or `WAITING`) to `RUNNING` with a fresh `leaseToken` and
`leaseExpiresAt`; a second delivery, or a second worker, finds nothing to
claim. The handler runs outside any transaction, and its outcome is written
only if the attempt is still `RUNNING` under the same token. A cancelled run,
a run past its deadline, or an attempt the sweep gave away therefore drops a
late result instead of recording it.

**A side effect is keyed by the attempt's idempotency key, and only an
idempotent handler is ever repeated.** `<runId>:<nodeId>:<attempt>` is the
same for every delivery of one attempt. A handler declares `idempotent`; an
expired lease is queued again only for such a handler and failed as
`workflow_node_interrupted` otherwise, and a `retryable` failure is retried
only for such a handler: as a new attempt, written in the same transaction as
the failure, after 10 s, 40 s, 160 s, at most three in total by default. A
handler that throws fails its node, never the job.

**Waiting is a row, not a worker.** A handler may answer `waiting` with what
it waits for (`workflowWaitSchema`: a work item, an attention item, a timer).
The attempt keeps that object, the run turns `waiting` while nothing else is
in flight, and `resume` continues it once the object has an answer; a timer
is woken by the sweep, the work item and attention hooks are #162 and #163.

**Limits are frozen when a run starts and stop it deterministically.** Each
of node attempts, attempts in flight (waiting ones included), lifetime and
budget is the stricter of the graph's limit and the workspace's setting
(`workflows.*`, ceilings in the ADR-023 sense), stored on the run. A step
that would exceed the attempt count fails the run with
`workflow_node_limit`; a spent budget fails it before the next step; a
passed deadline times it out and nothing executes after it; the parallel
limit holds runnable nodes back rather than failing. `workflows.enabled`,
off by default, is read on every step, so switching it off stops runs in
flight at their next one.

**The sweep is the net, not the engine.** `sweep-workflow-runs` runs every
minute: it starts due schedule triggers (moved on before starting, as in
ADR-038), recovers expired leases, re-queues attempts that have been due for
two minutes, wakes due timers and advances runs nobody advanced for two
minutes or whose deadline passed. Every duplicate it produces finds the work
done.

**Self-starting triggers are a projection, rebuilt with the workflow.**
`workflow_trigger` holds a row per schedule and event trigger of the
published version exactly while the workflow is switched on, rewritten in the
transaction that publishes or switches. An event trigger hangs off the
outbox dispatcher like an automation (ADR-024), debounced per workflow,
trigger and page for a minute; a self-started run acts as `enabledById`, the
person who switched the workflow on.

**A workflow's write carries its origin, and the loop guard counts both
kinds of standing instruction.** The worker stamps
`x-exocortex-workflow: <workflowId>:<runId>:<executionId>:<depth>` on what a
node writes; the API accepts it from a service token only and copies it onto
every outbox row of the request, with the depth in the same column as an
automation's. A workflow never starts from a row naming itself, and a chain
through automations and workflows stops at `AUTOMATION_MAX_DEPTH` either way.

**The history is facts.** Node queued, started, succeeded, failed, retry
scheduled, waiting, resumed, skipped, cancelled, recovered, edge taken, limit
reached, run started, finished, cancelled: each with ids, handles, attempt,
duration and error class, never content. It is enough to replay the path a
run took, which is what the debugger of #164 will do.

## Consequences

- A worker can be killed between any two steps and the run continues: the
  integration suite drops every queued job after every step and the sweep
  alone brings the run to its end.
- The runtime executes `condition`, `parallel`, `join` and `end` itself. An
  `agent` or `approval` node fails its attempt with
  `workflow_node_not_executable` until #162 and #163 give it a handler; a
  graph with one can be published and is honestly refused when it gets there.
- A run started by hand needs `workflows.enabled` but not the workflow's own
  switch, which is about starting by itself. Starting and cancelling are an
  admin's and never a run of the built-in AI's; MCP only, with the reason in
  `SURFACE_EXEMPT`.
- Spend is a column the runtime only reads so far; #162 adds what agent
  nodes spend, and the budget check is already where it will bite.
- The sweep's two-minute window is the price of recovery without a
  heartbeat: a lost job costs a run up to three minutes, a crashed worker up
  to its lease plus a minute.
