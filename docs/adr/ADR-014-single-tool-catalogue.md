# ADR-014: One tool catalogue serves both MCP and the built-in AI

* Status: accepted
* Date: 2026-08-05

## Context

Two things need to call into eXocortex on a model's behalf: the external stdio
MCP server that Hermes and Claude Code spawn, and the built-in AI's tool loop in
`apps/worker`. Written separately they would drift immediately. The predecessor
system demonstrated this precisely: the flauschibrain MCP server and the agent's
own note helpers diverged in argument names, in confirmation behaviour and in
what "save" meant, and the difference only ever surfaced as a failed call in
production.

There is a second question underneath: how does a tool reach the domain?
Importing `@exocortex/database` and `@exocortex/auth` into the tool layer would
be the shortest path, and the wrong one — it would put a second copy of the
authorization rules next to the one in `apps/api`, and any policy check the tool
layer forgot would be a silent bypass rather than a compile error.

## Decision

`packages/mcp-tools` is the one catalogue. It is a leaf package: it may import
`@exocortex/contracts` and nothing else.

A tool is a `ToolDefinition` (`packages/mcp-tools/src/tool.ts`) carrying a
namespaced `exo_` name, a German description, a zod `inputSchema`, and two flags
that make the catalogue self-describing:

* `surfaces: ('mcp' | 'ai')[]` — which of the two consumers offers this tool, so
  a tool can be exposed to external clients without being handed to the built-in
  model, or the reverse.
* `mutating: boolean` — whether it changes data. It drives the destination-keyed
  confirmation gate in `apps/mcp` and the `ai.mutatingToolsEnabled` setting in
  the worker. Every mutating tool also declares a `target()` function, so the
  gate is keyed on what is about to be written rather than on anything the
  caller supplies.

`execute` receives an injected `ExocortexApiClient` and **only** talks to the
REST API through it. `apps/mcp` builds that client from `EXOCORTEX_API_URL` plus
a long-lived `exo_` API token; the worker builds it from `API_URL` plus a
short-lived `exos_` HMAC service token that resolves to the run's own user.

## Consequences

* **Authorization stays in `apps/api`, in exactly one place.** Every tool call is
  an ordinary authenticated HTTP request and passes the same `assertPolicy()`
  checks a human's request does. A tool cannot bypass a policy, because it has no
  route to the database to bypass it with.
* **A tool needs a REST endpoint before it can exist.** This is a real
  constraint, and the intended one: it means the capability is available to the
  UI, to scripts and to the model on the same terms. Where an endpoint was
  missing, one was added (`POST /api/documents/:id/content`,
  `GET /api/attachments/:id/text`).
* **The catalogue is remote-capable for free.** Nothing in it assumes it runs on
  the same host as the database, so the MCP server can be pointed at a different
  deployment by changing one environment variable.
* **Parity is structural, not a convention.** Adding a definition to the
  catalogue adds it to both surfaces at once; there is no second list to
  remember. What is *not* structural is remembering to extend the catalogue when
  a feature lands, which is why rule 10 in `CLAUDE.md` states it as a
  non-negotiable and `docs/mcp.md` carries the recipe.
* **Cost: an HTTP hop per tool call, including from the worker**, which runs on
  the same host and could have used Prisma directly. Measured in the tens of
  milliseconds against model latency in the hundreds, so it does not matter — and
  it buys the single authorization pipeline above.
* **The API surface is the compatibility boundary.** A breaking change to an
  endpoint breaks the tool that calls it, so endpoints the catalogue depends on
  need the same care as public ones.
