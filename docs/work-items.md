# Work items (delegated work)

Issue #138, ADR-066. A work item is a piece of work somebody handed over: a
person to an agent, an agent to a person, or either to its own kind. It
outlives the runs that attempt it.

## Where things are

| Piece         | Location                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------- |
| Tables        | `work_item`, `work_item_event`, `work_item_ref`, `ai_run.workItemId` (`schema.prisma`)    |
| Wire contract | `packages/contracts/src/work-items.ts`                                                    |
| REST          | `apps/api/src/work-items/` (controller, service, pure update planner, mapper, run prompt) |
| Tools         | `packages/mcp-tools/src/tools/work-items.ts`, domain `workItems`                          |
| Browser       | `apps/web/src/components/work-items/`, routes `/arbeitsbereich/:id/auftraege[/:itemId]`   |
| Words         | `packages/i18n/src/messages/de/workItems.json`, feature entry `auftraege`                 |

## Routes

| Route                                 | What                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/:id/work-items`  | list; `status`, `assignee` (`me`, `assistant`, `nobody`, id), `requester` (`me`, id), `parentId` (`root`, id), `open` (`true` default, `false`, `all`), `limit` |
| `POST /api/workspaces/:id/work-items` | create; the caller is the requester                                                                                                                             |
| `GET /api/work-items/:id`             | detail with refs, children, runs, budget and history                                                                                                            |
| `PATCH /api/work-items/:id`           | partial update; `null` clears, the ref lists replace                                                                                                            |
| `POST /api/work-items/:id/notes`      | a note in the history                                                                                                                                           |
| `POST /api/work-items/:id/runs`       | an attempt by the built-in AI in a conversation of its own                                                                                                      |
| `DELETE /api/work-items/:id`          | for good; requester or workspace admin                                                                                                                          |

## Rules worth knowing before changing anything

- **The status is never derived from a run.** Only the two moves in
  `startRun` (`queued` → `working`, unassigned → assistant) happen on their
  own. Do not add a hook in the worker that closes items when a run
  completes; that is exactly the coupling the unit exists to avoid.
- **The actor kind is provenance.** `workItemActorOf` reads it from the
  credential and the agent session header. Never branch a permission on it.
- **History rows are written in the transaction of the change**, by
  `writeEvents`. A new field means a line in `PLAIN_FIELDS` in
  `work-item-changes.ts` (or its own event kind if a reader acts on it), a
  column, a contract field, the mapper, and the `workItems.labels.event`
  wording if it gets its own kind.
- **The run prompt is German and names the tools.** It is what makes the
  keyword selection (ADR-060) offer the `workItems` domain; renaming the
  tools means changing `work-item-prompt.ts` and the domain keywords together.
- **The assignee's rights** are the set `ASSIGNEE_FIELDS` in the service. A
  field added there is one a GUEST who was assigned the item can change.

## Adding a capability

Same order as everywhere else (`docs/mcp.md`): contract, service method and
route, tool in `work-items.ts`, the browser, the feature entry's words, the
capability matrix (`node scripts/check-capability-parity.mjs --write`), and a
line in this document.
