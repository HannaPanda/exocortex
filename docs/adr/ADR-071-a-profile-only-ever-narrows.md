# ADR-071: an agent profile only ever narrows, and a run keeps the one it started under

- Status: accepted
- Date: 2026-10-10
- Relates to: ADR-013 and ADR-023 (settings and their scopes), ADR-024 (automations),
  ADR-032 and ADR-063 (provider routing), ADR-044 (confined credentials), ADR-060
  (tool domains), ADR-066 (work items), ADR-068 (the run in the service token),
  ADR-070 (write modes), issue #143

## Context

Not every piece of delegated work needs the same assistant. A developer role
should propose and may spend a couple of dollars, a researcher should read
and fetch from the web and change nothing, an archivist should tidy pages
directly with a cheap model. Before this decision the only knobs were the
workspace's settings, which hold every run alike, and a work item's write mode
and budget, which have to be set again on every item. Issue #143 asks for
persistent roles that parameterise the one runner there is, without a second
agent framework and without a profile ever becoming a way to get more than the
person, the workspace or the token behind a run may have.

## Decision

**A profile is a row per workspace, and only an admin writes one.**
`agent_profile` holds the role in words and the pages whose text is added to it,
a preferred model and reasoning level, routing keys, the tool domains it may
use, a write mode, an approval policy, budgets per run and per task, a limit
on tool turns and on run time, and whether its runs stay in their workspace.
Writing one is `canManageAgentProfiles` (ADMIN), an `admin`-class request for
a token (`requestClassFor`), and refused outright for a run of the built-in AI:
a run that could edit the rules it runs under would not be held by them. Every
change is an audit log entry and moves `revision`.

**Every limit is combined by taking the stricter.** The write mode is the
strictest of the workspace's, the work item's and the profile's. The budget
per run, the tool turns and the run time are the smaller of the setting and
the profile's; the budget per task is the smaller of the item's and the
profile's (`stricterLimit`). There is no field on a profile that can widen
anything, which is what makes "a profile only narrows" true by construction
rather than by review.

**The tool domains become a limit where they were only an offer.** ADR-060
chose domains from the task's words and said loudly that this is not a
permission. A profile's list is: a domain outside it is never offered,
`exo_toolbox` cannot open it, and the tool runner refuses a call to one of its
tools before anything else is decided. `core` is always kept, and so are the
domains a run of its kind cannot do without: reporting and asking on a work
item, proposing in the proposal mode. The keyword selection itself stays what
it was.

**A run keeps the profile it started under.** The worker resolves the profile
when the run starts (the work item's own, else the workspace's default, else
none; one rule in `resolveAgentProfile`, shared with the API), applies it and
writes `ai_run.agentProfileId` with a snapshot of what it said. A profile
edited or deleted afterwards does not rewrite what a finished run was held to,
and the run detail names the profile and its revision.

**A confined run carries its workspace in its service token.** Like the run id
(ADR-068) and the write mode (ADR-070), the workspace is a signed claim.
`WorkspaceAccessService` answers every other workspace as if the account were
not a member of it, through the same functions that decide membership for
everybody, and the cross-workspace listings filter their memberships with
`confinedMembershipWhere`. No route has to know that profiles exist.

**A profile names a model, never a provider.** The model is a preference: when
it is no longer enabled the run uses the default. Routing stays configuration
(ADR-063); a profile's routing keys are laid over the configured object key
by key, like a model's override, both for narrowing the endpoints before a
plan and on every request.

**Choosing a work item's profile is loosening it.** One profile may allow what
another does not, so naming one takes the credential that may loosen a write
mode: a person, or a token that may write. A part of a larger item inherits
its parent's. An automation's `WORK_ITEM` action is accepted because it names
exactly the profile its owner chose when writing the rule, which already took
the OWNER role and an admin-class credential.

**Closing can be left to a person.** With `review_before_done` a run may set
its work to `review` and not to `done`. The API reads the policy from the
run's own snapshot through the signed run id, never from the request.

## Consequences

- A role is set once and named on a work item; nothing has to be repeated per
  item, and nothing a profile says can make a run more capable than before.
- A run in a confined profile cannot reach another workspace even where its
  person could, including through search and the workspace list.
- A profile with too few domains produces refused calls rather than surprising
  writes. The refusal names the allowed domains, so the model can say what it
  is missing instead of looping.
- Subtree confinement (ADR-044) is deliberately not offered: a page-scoped
  credential fails closed on the workspace-wide routes a run needs to report
  on its work. A profile's resource scope is its workspace.
- Context compiler defaults per profile are not built; `exo_context_compile`
  takes its parameters from the call as before.
