# Agent profiles

Issue #143, ADR-071. An agent profile is a role the built-in AI works in on
delegated work: what it is told, which model it prefers, which tool domains it
may use, how it may write, whether it may close its work, what it may spend and
whether it stays in its workspace. A profile only narrows.

## Where things are

| Piece         | Location                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables        | `agent_profile`, `work_item.agentProfileId`, `ai_run.agentProfileId` and `agentProfileSnapshot`, `automation_rule.agentProfileId` (`schema.prisma`) |
| Wire contract | `packages/contracts/src/agent-profiles.ts` (also `TOOL_DOMAINS`, `stricterLimit`, `allowedToolDomains`)                                             |
| Resolution    | `resolveAgentProfile` and `agentProfileSnapshot` in `packages/database/src/agent-profiles.ts`, shared by the API and the worker                     |
| REST          | `apps/api/src/agent-profiles/`; the work item side in `apps/api/src/work-items/`                                                                    |
| Confinement   | the `workspaceId` claim in `packages/auth/src/service-token.ts`, `outsideConfinement` in `access.ts`, `confinedMembershipWhere` in the API          |
| Worker        | `apps/worker/src/processors/ai-run/agent-profile.ts`, `allowedDomains` in `tool-runner.ts`                                                          |
| Automation    | the `WORK_ITEM` action, `apps/worker/src/processors/automation/work-item.ts`                                                                        |
| Tools         | `packages/mcp-tools/src/tools/agent-profiles.ts`, domain `workItems`                                                                                |
| Browser       | `apps/web/src/components/agent-profiles/`, routes `/arbeitsbereich/:id/agentenprofile[/:profileId]`                                                 |
| Words         | `packages/i18n/src/messages/de/agentProfiles.json`, feature entry `agentenprofile`                                                                  |

## Routes

| Route                                     | Class | What                                                         |
| ----------------------------------------- | ----- | ------------------------------------------------------------ |
| `GET /api/workspaces/:id/agent-profiles`  | read  | every profile of the workspace, the default first            |
| `POST /api/workspaces/:id/agent-profiles` | admin | create; `writeMode` defaults to `propose`                    |
| `GET /api/agent-profiles/:id`             | read  | the profile and its history from the audit log               |
| `PATCH /api/agent-profiles/:id`           | admin | partial update; `null` clears, every change moves `revision` |
| `POST /api/agent-profiles/:id/duplicate`  | admin | a copy under a new name, never the default                   |
| `DELETE /api/agent-profiles/:id`          | admin | for good; work items that named it fall back to the default  |

Writing takes the ADMIN role and is refused for any request a run of the
built-in AI makes. A work item names its profile with `agentProfileId` on
create and update.

## How a run is held to a profile

Resolved when the run starts, never from the job payload:

1. The work item's own profile, else the workspace's default (`isDefault`),
   else none. A chat turn that is not an attempt at a work item has none.
2. Write mode: the strictest of `ai.writeMode`, the work item's and the
   profile's.
3. Budget per run, tool turns, run time: the smaller of the setting and the
   profile's. Budget per task: the smaller of the item's and the profile's,
   checked by the API before a run starts (`effectiveBudgetMicroUsd`).
4. Tool domains: the profile's list plus `core`, plus `workItems` and
   `attention` on a work item, plus `changesets` when proposing. A domain
   outside it is not offered, cannot be opened by `exo_toolbox`, and a call is
   refused in the tool runner.
5. The role and the text of its rule pages go in as a system message before
   the conversation, inside 16,000 characters.
6. Routing keys are laid over the configured ones (ADR-063), for the endpoint
   narrowing and for every request.
7. `confineToWorkspace` signs the work item's workspace into the run's service
   token; every other workspace answers as if the account were not a member.
8. The run row gets `agentProfileId` and the snapshot. `review_before_done`
   is read from that snapshot when the run tries to set its work to `done`.

The profile's model and reasoning level are applied when the run's
conversation is created (`startRun`), when the request names none. A model
that is no longer enabled is skipped.

## Rules worth knowing before changing anything

- **No field may widen.** A new limit is combined with `stricterLimit` (or the
  equivalent for its kind) in the worker and, where the API decides, in the
  API. A field that could only ever loosen something does not belong here.
- **Choosing a profile is loosening.** `assertMayChooseProfile` takes the same
  credentials as loosening a write mode. The one other way is an automation
  whose `WORK_ITEM` rule names exactly that profile and was written by the
  same owner (`ruleNamesProfile`).
- **The snapshot is the record.** Read what a run was held to from
  `ai_run.agentProfileSnapshot`, never from the profile as it is now.
- **Confinement is in the access service.** A new cross-workspace listing that
  reads `workspaceMember` directly has to spread `confinedMembershipWhere()`
  into its filter, or a confined run sees another workspace's names there.
- **Domains live in the contracts.** `TOOL_DOMAINS` moved from
  `packages/mcp-tools` to `packages/contracts` so the API can validate a
  profile; `mcp-tools` re-exports it. A new domain needs a label in
  `agentProfiles.labels.domains`.

## Adding a field

A column and its migration, the contract (profile, create, update, and the
snapshot if the worker or the API reads it later), the mapper, the
duplicate path, where it is applied (worker or API), the dialog and the
detail in the browser, the words in `agentProfiles.json`, the `FIELDS_HELP`
in the tool file, and a line in this document.
