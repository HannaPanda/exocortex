# ADR-080: an agent writes a workflow draft, and a person publishes it

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-022 (agent sessions), ADR-030 (foreign text locks
  writing), ADR-066 (who a request was), ADR-070 (write modes), ADR-071
  (agent profiles), ADR-072 (a child no looser than its parent), ADR-075
  (workflow graphs), issue #165 under the epic #159

## Context

The point of issue #165 is a sentence like "review my open technical ideas
every Sunday and propose the five best next tasks", turned by an agent into
a graph a person then opens in the editor, reviews and switches on. Until
now a draft could only be written with an admin token or in the browser,
and the API refused every workflow write from a run of the built-in AI.

The danger in a workflow is not its draft. A draft starts nothing; a
published and switched-on version starts agents by itself, under profiles
and budgets, for days. So the question was where to put the boundary, and
two answers were wrong. Leaving drafting behind the admin request class
would keep Hermes with a writing token out of the very job the issue names.
Letting an admin token publish would make the review a formality: an agent
holding the owner's token could write a graph and switch it on in two
calls, and nobody would have looked.

The account does not answer it either. Johanna's token behind Claude Code
is her account, and so is the built-in AI acting for her (ADR-066). How a
request arrived does: a service token is a run of the built-in AI, a named
agent session is an external agent (ADR-022), anything else is a person.

## Decision

1. **Drafting is an ordinary write.** Creating, revising and duplicating a
   draft (`POST /api/workspaces/:id/workflows`, `PATCH /api/workflows/:id`,
   `POST /api/workflows/:id/duplicate`) are of the `write` request class;
   the role is still ADMIN (`canManageWorkflows`). Publishing, switching on,
   deleting and starting or cancelling a run stay in the `admin` class.
2. **Publishing and switching on are a person's.** The API refuses both
   with `workflow_human_only` whenever the request came through an agent
   session or a service token, whatever the token's scope. No tool exists
   for either.
3. **A person publishes the revision they reviewed.** `expectedRevision` on
   the publish request is required; an agent revising the draft while a
   person reads it makes the publish a `workflow_revision_conflict`, never
   a version of something unread.
4. **A draft says who wrote it.** The draft records the kind (`human`,
   `agent`, `assistant`), the account, the agent's own label and the AI run
   whenever its graph changes; renaming leaves it alone. Publishing copies
   that record onto the version, beside the person who published, and the
   immutability trigger covers it. The editor shows an agent-written draft
   above everything else until it is published.
5. **The built-in AI drafts within its own profile.** `exo_workflow_create`,
   `exo_workflow_update` and `exo_workflow_duplicate` are on both agent
   surfaces in the `workflows` domain, so a profile without that domain
   cannot use them and foreign text locks them like every mutating tool
   (ADR-030). A run may not write an agent node whose profile is looser than
   its own (`profileNoLooser`, the rule of ADR-072); a node without a profile
   counts as the workspace default. The write is refused with
   `workflow_exceeds_author` and the problems as `profile_looser_than_author`
   per node, so the run can repair it. A proposing or read-only run cannot
   draft at all, because drafting is a write. Deleting stays out of the
   built-in AI's reach.

## Consequences

- Hermes with a writing token can write, validate, repair and copy a draft;
  `exo_workflow_validate` answers with codes and element ids, and the tool
  descriptions carry a complete example graph that the tests validate.
- An agent session that does not announce itself counts as a person. That
  is the same trust ADR-066 already places in the header for provenance; it
  is the browser's cookie or an un-announced token, and the admin request
  class still applies to it.
- The profile rule binds the built-in AI only. An external agent has no
  profile, and what it drafts is held, like everything, by the person who
  reviews and publishes it, and at run time by ADR-071 again.
- The review is real only if somebody reads the draft. The editor makes the
  author visible and publishes exactly the revision on screen; it cannot
  make a person look.
