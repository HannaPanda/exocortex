# ADR-066: delegated work is its own unit, and a run is one attempt at it

- Status: accepted
- Date: 2026-09-26
- Relates to: ADR-010 (the outbox), ADR-022 (agent sessions), ADR-025
  (capability parity), ADR-060 (tool domains), issue #138, issue #42

## Context

A request to an agent could only take the shape of a conversation and the
`AiRun` it started. That is enough for a chat and too little for anything
that is handed over:

- a run fails or is cut off by a deploy, and the request is gone with it
- nothing can wait: on a person's answer, on another piece of work, on access
- a second attempt a week later starts from nothing
- there is no place for "done means these three things", nor for what came out
- an external agent (Claude Code, Hermes) has no run at all, so its work had
  nowhere to be recorded except a page somebody would have to find

Issue #138 asks for a first-class unit of work, symmetric between people and
agents, with runs underneath it rather than instead of it.

## Decision

**A `WorkItem` is the ask; an `AiRun` is one attempt.** `work_item` holds the
title, the goal, acceptance criteria (`[{ text, met }]` as JSON, edited and
read as a whole), a status and the reason for it, a priority, a due date, a
budget in micro-USD, a parent, and a result in words. Pages it was given and
pages it produced are `work_item_ref` rows with a role, so a page deleted for
good leaves the item instead of leaving a dead id. `ai_run.workItemId` ties a
run back; deleting the item sets it null, so the run's cost stays in the usage
report.

**The status is a decision, never derived.** Eight values (`queued`, `working`,
`blocked`, `waiting_for_human`, `review`, `done`, `failed`, `cancelled`); the
last three set `closedAt`, leaving them clears it. No run completion, failure
or timeout moves an item. Starting a run moves `queued` to `working` and hands
an unassigned item to the assistant, because that is what the person pressing
the button just decided; beyond that, how a run ended is the run's business and
what it means for the work is somebody's call. A transition that brings no
reason drops the old one, so "waits on the review" does not stay attached to an
item that is now done.

**Both ends are symmetric, and the kind is provenance.** A requester and an
assignee are each `HUMAN`, `AGENT` or `ASSISTANT`. The first two name an
account; the built-in AI has none, so an item assigned to it carries no id (a
check constraint), and as requester or actor the id is the person it acted for.
Which kind a request was is read from how it arrived -- a service token is the
worker's tool loop, a named agent session (ADR-022) is an external agent,
anything else is a person -- never from the account, because Johanna's token
behind Claude Code is Johanna's account. It is shown, never used for a
permission. The browser offers every member as either, since only whoever
hands work out knows which of the two should pick it up.

**The history is written with the change.** Every mutation writes its
`work_item_event` rows in the same transaction: `created`, `status_changed`
(`from`, `to`, `reason`), `assigned` (a snapshot of the assignee with its name
at that moment), `result_recorded`, `updated` (the names of the fields),
`run_started` (the run id), `note`. Rows carry facts, never the goal or the
result, which can be long; a note is the one free text and is never edited.
This is the item's journal rather than `agent_write_journal`, which is about
pages and points at snapshots, and rather than `audit_log`, which is about
permissions.

**A run is an ordinary chat turn.** `POST /api/work-items/:id/runs` creates a
conversation of its own and posts a first message written from the item: goal,
criteria, context pages by id, the previous result, optional instructions, and
how to report back (`exo_work_item_update` with `result`, `resultDocumentIds`,
the criteria and `review`; `waiting_for_human` with a reason when stuck). The
transcript therefore says exactly what was asked. `workItemId` reaches the run
through an internal parameter of `postMessage`, never through a request body,
so a chat message cannot attach its run to somebody's work. The message
contains "Auftrag" and the tool names, which is what makes ADR-060's keyword
selection offer the `workItems` domain to that run.

**The budget is checked before, not during.** A run is refused with
`work_item_budget_exhausted` when the linked runs already cost at least the
budget (measured cost, estimated where none was reported); a run in progress is
not stopped by it. A closed item refuses a run with `work_item_closed`.

**Authority is the workspace's, plus the assignee's own progress.** Reading is
`canReadWorkspace`, writing `canManageWorkItems` (MEMBER). The assignee may,
whatever their role, change status, reason, criteria, result and result pages
and add notes, because being asked to do something has to include saying it is
done. Deleting for good is for the requester and a workspace ADMIN or OWNER;
it detaches the children, and it is irreversible on the MCP surface, because
the history goes with the item and cancelling is the reversible way to end one.
Routes use `requireRole`, so a page-confined credential is refused (ADR-044).

## Consequences

- Seven tools in a `workItems` domain on both agent surfaces; the list, the
  detail view and the create dialog in the browser under
  `/arbeitsbereich/:id/auftraege`. `work-item.changed` on the realtime socket
  carries only the id.
- Nothing notifies an assignee yet. A person assigned an item sees it under
  "Mir zugewiesen"; a notification kind for it is a separate decision
  (ADR-052), as is an automation trigger on it (ADR-024).
- Sub-agents, approval flows and dependencies between items ("blocked by #12")
  are not modelled. `parentId` and the `blocked` status with a reason are the
  hooks they will hang on; a dependency would be a second relation, not a
  change to this one.
- The run does not update the item by itself when it finishes. If it did not
  call the tool, the item stays `working` with a completed run beside it, which
  is visible and honest: the answer is in the linked conversation.
