# ADR-025: The browser, the built-in AI and MCP are three clients of one API

- Status: accepted
- Date: 2026-09-13

## Context

eXocortex can be used three ways: a person opens `apps/web`, the built-in AI
runs a tool loop in `apps/worker`, an external client (Hermes, Claude Code,
ChatGPT) speaks MCP over stdio or over `POST /api/mcp`. ADR-014 already settled
that the last two share one catalogue and reach the domain only through the
REST API, and `check-mcp-catalog.mjs` has been holding the line that every route
either has a tool or has a written reason not to.

What nothing was watching is which _surface_ that tool is offered on, and that
is where the drift actually happens. `packages/mcp-tools` marks each tool with
`surfaces`, and a tool that ships with `surfaces: ['mcp']` looks exactly like
one that ships with both. Nothing fails. The catalogue gate stays green, because
from where it stands the route has a tool. The built-in AI simply cannot do the
thing, and nobody finds out until somebody asks it to.

The audit that produced this ADR found four capabilities a person had and no
agent did: renaming a select option, removing one, moving a column, moving a
view. None of them was a decision. Three of them were sitting in the exemption
list under the reason "drag-and-drop in the browser", which describes a mouse
gesture and not a capability. Moving a column is a capability. How a person
happens to trigger it is not.

## Decision

### The three ways are clients, and the API is the product

There is no privileged path. The browser sends a cookie, the MCP server sends a
bearer token, the worker mints a short-lived service token for the human whose
run it is (`issueServiceToken`, purpose `ai-tools`) — and then all three send
HTTP to `apps/api`, where the authorization lives. A capability that exists only
behind one of those three is a bug unless somebody wrote down why.

This is the rule in one line: **if the product can do it, all three can do it.**

Parity is semantic, not literal. A drag is not a feature; `move` is. A tool need
not be named after the endpoint, and its input need not be shaped like the
request body. What has to agree is what can be reached and what may be done.

### Two exemption lists, both with reasons, both checked

The exceptions are real and most of them are good:

- **A credential is typed by a human.** API tokens, OAuth connections, a
  workspace's provider key. A client that could mint its own credential turns
  one leak into permanent access.
- **An agent does not widen its own permissions.** `/api/admin/settings` and
  `/api/workspaces/:id/settings` hold `ai.toolsEnabled`,
  `ai.mutatingToolsEnabled` and the per-run budget (ADR-023).
- **An agent does not grant a role**, create a workspace, or revert an
  afternoon of its own writes in one call (ADR-022).
- **The built-in AI does not observe or bill itself.** `exo_ai_run_get`,
  `exo_ai_run_cancel` and `exo_ai_usage` are `mcp`-only: a model reading its own
  cost ledger mid-run spends tokens reasoning about the tokens it is spending.
- **`exo_page_delete` stays where something asks twice.** It is the one write no
  snapshot undoes, and the built-in AI's loop has no confirmation gate — it has
  `ai.mutatingToolsEnabled`, one decision taken once for every write there is.

So: `EXEMPT` in `check-mcp-catalog.mjs` for a route no tool reaches, and
`SURFACE_EXEMPT` in `check-capability-parity.mjs` for a tool one kind of agent
does not get. Both go red on an entry that has stopped matching anything, which
matters more than it sounds: an exemption nobody can trigger any more is a hole
the next endpoint slips through silently.

### The API is the registry; the matrix is derived, never authored

The obvious shape for this is a capability registry: a table of ids, input
schemas, permissions and adapters, from which REST, tools and docs are all
generated. It is not what this decision does, and the reason is that the
registry would be a fourth definition of things that already have three, in a
codebase where the three are already tied together — zod contracts in
`packages/contracts`, one catalogue in `packages/mcp-tools`, one authorization
layer in `packages/auth`. The failure mode of a hand-kept registry is the exact
failure it exists to prevent: it falls behind, and now the drift has a
respectable-looking document confirming it is not there.

`docs/capability-matrix.md` is generated from the source instead — controllers,
`apiRequest` calls, `defineTool` literals — by
`node scripts/check-capability-parity.mjs --write`, and the gate fails when the
committed file no longer matches what it regenerates. It cannot be wrong for
longer than one build. It is a report, not an authority; nothing reads it at
runtime, and that is the point.

Both gates read the three sides through one module,
`scripts/lib/api-surface.mjs`, so they cannot come to disagree about what a
route is.

### Definition of done

A feature is not finished when its screen works. It is finished when:

- the capability is reachable from the browser, the built-in AI and MCP, or the
  gap has an entry in one of the two lists with the reason;
- reading is covered as well as writing — status, errors and results are
  machine-readable, not only rendered;
- an asynchronous feature offers the whole loop: start, status, diagnostics,
  result, retry, and cancel where the browser can cancel;
- all three go through the same policies in `packages/auth`;
- `docs/capability-matrix.md` is regenerated in the same commit series.

## Consequences

- Four tools closed the gaps the audit found: `exo_database_option_update`,
  `exo_database_option_delete`, `exo_database_property_reorder`,
  `exo_database_view_reorder`. The database capability is now whole for an
  agent: schema, columns, options, views, order, rows.
- A sixth hard gate, and the deploy is a little slower for it.
- Adding a tool to only one surface is now a decision somebody has to defend in
  a comment, which is the entire mechanism.
- The matrix is a file that changes in most feature commits. That is the
  intended noise: a diff that adds a controller and does not touch the matrix is
  visible in review.
- Writing the scanner turned up a quieter problem worth recording: the old
  regular expression for a path literal broke on
  `` `/api/workspaces/${workspaceId ?? ''}/settings` `` — the `''` inside the
  interpolation ended the match early — and produced a plausible-looking wrong
  route. `check-mcp-catalog.mjs` had been measuring against it. A gate reading
  source with a regular expression must be tested against the mangled shapes and
  not only the missing ones, which is what `scripts/gates.test.ts` now does.
- The parity rule is deliberately not enforced for the `research` and `memory`
  surfaces. Those are tiny catalogues shaped for one foreign client each — a
  deep-research connector wants exactly `search` and `fetch` and works badly
  when handed eighty tools — so a tool living only there is the point.
