# ADR-086: an external tool is blocked until a person approves what they saw

- Status: accepted
- Date: 2026-10-14
- Relates to: ADR-014 and ADR-018 (eXocortex as an MCP server), ADR-023 (credentials are not settings), ADR-025 (parity), ADR-030 (foreign content), ADR-033 (the address check), ADR-071 (profiles only narrow), issue #196

## Context

The built-in AI is taking over more of what Hermes did, and Hermes reached
other systems through their MCP servers: the health app, FlauschiMCP with mail
and monitoring. eXocortex has been an MCP _server_ since ADR-014. It could not
be a client: the worker's tool loop only knew the `exo_` catalogue, which
reaches this deployment's own REST API and nothing else.

A client for somebody else's server is a different kind of thing from every
tool the catalogue has. The server decides what its tools are called, what
their descriptions say, which arguments they take and what they do. It can
change all of that between two calls. Its descriptions and its `instructions`
are text a model reads, written by whoever runs the server. Its `readOnlyHint`
is a claim, not a fact. And the request goes to an address a person typed,
from a host whose own network holds Grafana, Infisical and the Docker bridges.

ADR-033 decided that web research would be two REST calls and "never an MCP
client in the worker". That was about research: a known pair of back ends did
not need a generic protocol. It is not a rule against MCP clients, and this
decision does not reopen it; web research stays as it is.

## Decision

- **The official SDK, behind our fetch.** `packages/ai/src/mcp-client.ts`
  uses `@modelcontextprotocol/sdk` for the protocol and adds what the SDK
  cannot know. Every request goes through `createGuardedFetch`
  (`packages/ai/src/guarded-fetch.ts`): `https` only, no credentials in the
  address, a literal address judged before connecting, `publicOnlyLookup` on
  the socket so the address judged is the one dialled (issue #178), no pooled
  sockets, nothing followed (the SDK re-asks only within the origin, and the
  next hop passes the guard again), and the body counted and cut while it
  streams. One connection per operation, one deadline for all of it, and
  every failure is one of a closed set of codes. The client offers no
  sampling, roots or elicitation, so a server can answer and never ask.
  `public-address.ts` moved from the API to `packages/ai` for this, because
  the worker will need the same guard.
- **A server is a row of its workspace, and a person configures it at the
  browser.** `ExternalMcpServer` holds the address, how the secret is sent
  (`none`, `bearer`, or a named header) and the secret encrypted like a
  workspace credential (AES-256-GCM, purpose `external-mcp:<workspace>:<key>`
  bound in). Only an OWNER sees or changes one. Adding, changing and deleting
  a server and approving a tool are refused to every token, a person's own
  admin token included, and to an agent session (`external_mcp_human_only`),
  the line ADR-080 draws for publishing a workflow. A connection check only
  reads, so an owner's token may ask for one; a run of the built-in AI may
  not. The routes are outside the tool catalogue, with the reason in
  `scripts/check-mcp-catalog.mjs`: a tool there would let an agent widen its
  own toolset.
- **A tool starts blocked, and an approval is bound to what was approved.**
  A check stores every listed tool as `ExternalMcpTool` with a fingerprint,
  sha256 over its name, title, description, schema and hints. A person sets
  it to `read` or `write`; the server's hints are shown beside that choice and
  never decide it. The approval records the fingerprint. A later check that
  sees a different fingerprint sends the tool back to `blocked` in the same
  write, and a check constraint refuses any approval whose fingerprint is not
  the tool's current one, so a server that rewrites a description after it
  was approved has offered a new tool. A tool no longer listed becomes
  unavailable and blocked. Changing the address blocks every tool, because
  another address may be another server; a new secret does not.
- **What cannot be offered is decided before anybody looks.** A tool whose
  name is not `[A-Za-z0-9_-]{1,64}`, whose function name would be longer than
  the providers allow, or whose schema is not an object or over 16 KB carries
  a `problem` and cannot be approved.
- **The model will see `mcp_<key>__<tool>`.** The key is two to twelve
  lowercase letters and digits, without an underscore, so the name splits
  back at the first `__`, and it is fixed once created. Nothing named this way
  can shadow an `exo_` tool.
- **The deployment switch defaults off.** `ai.externalMcpEnabled` stops every
  new server, every switch-on and every check; the configuration stays.
  `ai.externalMcpTimeoutSeconds` bounds one operation.
- **The secret is decrypted in the API for a check.** Unlike a workspace's
  provider key, which only the worker reads: a check is a person waiting for
  an answer. The plaintext lives for that request, and an error detail the
  server sent back is stored with the secret replaced (`redactSecret`).

## Not decided here

- **Calling the tools from a run.** Offering approved tools to the loop, the
  ADR-030 marking of their results as `external-mcp`, write tools under the
  write mode and the profile, and the run timeline are stage 3 of issue #196.
  Until then, an approval is stored and has no effect on any run.
- **Private and local targets, and stdio.** The guard refuses every private
  address today, including this host. A health app on `127.0.0.1` has to be
  reached through its public name. An allowlist only a global admin writes,
  and stdio servers as a process the worker starts, are later stages with
  their own decision.
- **OAuth.** A server that only accepts OAuth cannot be connected yet. The
  SDK has a client for it; storing refresh tokens per workspace is its own
  decision.

## Consequences

- An external server can do nothing in a run before a person has looked at
  each tool, and what they looked at is what stays approved.
- The guard is the same code for every request to an address somebody chose
  that this process makes itself: attachments by URL, and now MCP.
- A server that changes its tools often is tiresome to use, by design: each
  change is a new decision.
