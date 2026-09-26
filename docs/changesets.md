# Proposed changes (changesets)

Issue #141, ADR-070. A changeset is what an agent hands in instead of
writing: page changes, each resolved against the page and shown as a diff,
that reach a page only when a person applies them. The proposal mode holds
the built-in AI, or an external agent's token, to proposing.

## Where things are

| Piece         | Location                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Tables        | `changeset`, `changeset_change`, `work_item.writeMode`, `ai_run.writeMode` (`schema.prisma`)                |
| Wire contract | `packages/contracts/src/changesets.ts`; modes and the decision in `ai-trust.ts`                             |
| REST          | `apps/api/src/changesets/` (controller, service, proposal, apply, review, mapper)                           |
| Previews      | `preview` on `DocumentEditService` and `DocumentContentService`, sharing everything a write does but commit |
| Route classes | `requestClassFor` in `packages/auth/src/api-token.ts`; enforced by `TokenScopeGuard`                        |
| Worker        | `apps/worker/src/processors/ai-run/write-mode.ts`, `decideMutation` in the tool runner                      |
| Tools         | `packages/mcp-tools/src/tools/changesets.ts`, domain `changesets`                                           |
| Browser       | `apps/web/src/components/changesets/`, routes `/arbeitsbereich/:id/vorschlaege[/:changesetId]`              |
| Words         | `packages/i18n/src/messages/de/changesets.json`, feature entry `aenderungsvorschlaege`                      |

## Routes

| Route                                          | Class   | What                                                                            |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `GET /api/workspaces/:id/changesets`           | read    | list; `state` (`open` default, `closed`, `all`), `workItemId`, `proposedBy=me`  |
| `POST /api/workspaces/:id/changesets`          | propose | a draft; `title`, `message`, `workItemId`, `revisesId`, optional first `change` |
| `GET /api/changesets/:id`                      | read    | every change with its diff, applicability and decision                          |
| `POST /api/changesets/:id/changes`             | propose | add a change to one's own draft                                                 |
| `DELETE /api/changesets/:id/changes/:changeId` | propose | take a change out of one's own draft                                            |
| `POST /api/changesets/:id/submit`              | propose | hand in; `review` (default true on a work item), `context`                      |
| `DELETE /api/changesets/:id`                   | propose | discard one's own draft                                                         |
| `POST /api/changesets/:id/apply`               | write   | `changeIds` (default all pending), `note`                                       |
| `POST /api/changesets/:id/reject`              | write   | the same, as a rejection                                                        |

A change is one of `block`, `section`, `patch` (the narrow write requests of
ADR-055 without their revision), `page` (`replace` or `append`) or `create`
(`parentId`, `title`, `markdown`), each with an optional `message` and the
`expectedYjsUpdatedAt` the proposer read.

## Rules worth knowing before changing anything

- **Nothing here writes a page.** Proposing previews through the write
  services; applying replays the stored request through `writeByKind` or
  `DocumentContentService.write` as the person applying, with the change's
  `expectedRevision`. A change to the write path is a change to both halves
  at once, which is the point of the shared `prepare`.
- **Stale is decided by the write's answer.** `STALE_CODES` in
  `changeset-apply.service.ts` lists the refusals that mean the change no
  longer fits; anything else leaves the change pending. A new refusal a
  narrow write can give belongs in one list or the other.
- **The set's own writes move its siblings.** After an apply, the pending
  changes of the same set on the same page expect the new revision. Nothing
  else ever moves `expectedRevision`.
- **The status is derived.** `changesetStatusOf` in the contract is the rule;
  the service stores its answer after every decision, in the transaction that
  closes the set.
- **Handing in raises one attention item, deciding the last change settles
  it** (`ChangesetReviewService`). A review sends the work back to `working`
  with the decision as its answer, which is what resumes a paused run
  (ADR-068). The German sentence it carries is `decisionNote`, because the run
  reads it.
- **The mode is enforced twice.** A tool that writes names its `writeClass`
  (`report` or `proposal`; absent is `content`), and the route it calls has to
  be of the same class in `requestClassFor`, or the loop offers a call the API
  refuses. A new report or proposal route is a line in `REPORT_ROUTES` or
  `PROPOSE_ROUTES` and a test in `api-token.test.ts`.
- **Only a person or a writing token loosens a work item's mode**
  (`assertWriteModeChange`, fed by the controller from the credential).
- **Deciding is not on the built-in AI's surface**, and the parity gate
  carries that reason. Do not add `ai` to the apply and reject tools.

## Adding a kind of change

A member of `proposeChangeSchema` and `ChangesetChangeKind` (contract and
Prisma enum), a branch in `ChangesetProposalService.prepare` that previews it
through the service that will write it, a branch in
`ChangesetApplyService.write` that replays it, its stale codes, the words in
`changesets.labels.kind`, and a line in `CHANGE_HELP` in the tool file.
