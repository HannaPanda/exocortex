# What waits on a person (attention items)

Issue #139, ADR-067. An attention item is one open need for somebody's
action: a decision, an approval, a result to review, a blocked work item, a
failed run, a question from an agent. The inbox is `/wartet` ("Wartet auf
dich"), one list across every workspace.

## Where things are

| Piece         | Location                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| Table         | `attention_item` (`schema.prisma`), partial unique index over open `dedupeKey` in the migration              |
| Wire contract | `packages/contracts/src/attention.ts`                                                                        |
| Raising       | `packages/database/src/attention.ts` (shared by API and worker: dedupe keys, `raiseAttentionItems`)          |
| State sync    | `apps/api/src/attention/attention-sync.ts`, `apps/api/src/work-items/work-item-attention.ts`                 |
| Checkpoints   | `attention-subject.ts` (approval binding), `work-item-resume.service.ts` and `work-item-resume-prompt.ts`    |
| REST          | `apps/api/src/attention/` (controller, service), questions in `work-item-questions.service.ts`               |
| Failed runs   | maintenance task `raise-run-failure-attention` (`apps/worker/src/processors/maintenance-tasks/attention.ts`) |
| Tools         | `packages/mcp-tools/src/tools/attention.ts`, domain `attention`                                              |
| Browser       | `apps/web/src/components/attention/`, route `/wartet`, top bar button, work item detail                      |
| Words         | `packages/i18n/src/messages/de/attention.json`, feature entry `wartet-auf-dich`                              |

## Routes

| Route                                | What                                                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/attention`                 | list across the caller's workspaces; `scope` (`for_me`, `raised_by_me`, `all`), `status` (`open`, `settled`, `all`), `workspaceId`, `workItemId`, `conversationId`, `kind`, `limit`; with `openCounts` per kind |
| `GET /api/attention/:id`             | one item with its resolution                                                                                                                                                                                    |
| `POST /api/workspaces/:id/attention` | ask: `decision`, `approval`, `review`, `budget`, `conflict`, `information`; `blocking`, `context`, `action`, `workState`, `subjectPages`; `key` makes it idempotent                                             |
| `POST /api/attention/:id/resolve`    | answer: `optionId` and/or `note`; a system option changes its work item                                                                                                                                         |
| `POST /api/attention/:id/withdraw`   | the asker takes a request back; system items cannot be withdrawn                                                                                                                                                |

## Lifecycle

| Trigger                                                   | Effect                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| work item enters `review`, `blocked`, `waiting_for_human` | one system item (`review`, `blocked`, `information`), unless a question is open |
| work item leaves that state                               | the item is `resolved` with the new status                                      |
| work item becomes `done`, `failed`                        | everything open on it is `resolved`                                             |
| work item becomes `cancelled` or is deleted               | everything open on it is `obsolete`                                             |
| latest run behind open work fails                         | one `run_failed` item within a minute (the sweep)                               |
| a new run starts                                          | open `run_failed` items are `resolved` with that run                            |
| blocking question asked on a work item                    | the work moves to `waiting_for_human`, the asking run ends after its turn       |
| last blocking question answered or withdrawn              | the work moves to `queued`                                                      |
| ... and the assistant holds the work and a run asked      | the answers are posted into that run's conversation, the work moves to working  |
| review asked for on a work item                           | the work moves to `review`; the review item carries the context and the run     |
| approval answered after a subject page moved              | the item is `obsolete` (`subject_changed`), and the run is told so              |

## Rules worth knowing before changing anything

- **Only needs for action.** Something that merely happened belongs to the
  history, the activity or the notifications. A new kind has to name the
  action somebody takes, or it does not belong here.
- **An item never reopens.** A state entered again raises a new item; the
  settled one stays as the record.
- **Everything happens in the transaction of the change.** Raise and settle
  from the functions that take `tx`; never from an event handler afterwards.
- **System options have effects, agent options do not.** The effect table is
  `SYSTEM_EFFECTS` in `attention.service.ts`; a new system option needs an
  entry there, a word in `attention.option`, and a line in `OPTION_HELP` in the
  tool file.
- **A checkpoint is this row, not another table** (issue #140, ADR-068).
  `blocking` is true only for a question on a work item; a conflict and a
  question about no work never block. The run that asked comes from the
  signed `runId` claim of the worker's service token via `WorkItemActor.runId`,
  never from a body. The resume runs after the answer is committed and records
  a failure (`resume_failed`, `resumeError`) instead of throwing; the answer is
  never lost to it. A new way to settle an item that a run could be waiting on
  has to call `WorkItemResumeService.afterAnswer` afterwards.
- **An approval's subject** is compared on every answer, content revision
  only. Adding a kind of subject (a changeset, #141) is a member of
  `attentionSubjectSchema`, a comparison in `attention-subject.ts`, and a line
  in the resume prompt saying what the run has to send back with its write.
- **Who sees it** is `scopeFilter`: addressed to the reader, or unaddressed in
  a workspace where they may manage work. A GUEST never sees unaddressed items.

## Adding a capability

Same order as everywhere else (`docs/mcp.md`): contract, service and route,
tool in `attention.ts`, the browser, the feature entry's words, the capability
matrix (`node scripts/check-capability-parity.mjs --write`), and a line here.
