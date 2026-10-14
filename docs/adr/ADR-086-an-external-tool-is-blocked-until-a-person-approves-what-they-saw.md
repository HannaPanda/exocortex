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

## Calling the tools from a run (stage 3, 2026-10-14)

- **A run is offered its own workspace's approved tools.** When the run
  starts, `apps/worker/src/external-mcp-tools.ts` reads the tools that are
  approved for their current fingerprint, listed, without a problem, on a
  server that is on, while `ai.externalMcpEnabled` holds for the workspace
  and the run's user is an OWNER, ADMIN or MEMBER of it. A GUEST holds a
  share of some pages, not the workspace, and gets none.
- **Offered whole, not guessed.** They form the domain `external`. A person
  chose every one of them, so they are in every turn rather than picked by
  keywords, and `exo_toolbox` neither lists nor opens the domain. An agent
  profile that names domains has to name this one; one that names none
  allows it. That is a limit enforced in the loop, like every profile domain.
- **What the model reads.** A line of ours (whose tool, approved for what,
  that its answer is data) and then the description a person approved. That
  description does not mark the run as having read foreign text: it is the
  text a person read and bound by its fingerprint. The server's
  `instructions` never reach the model.
- **The access class is the mutation flag.** `write` makes a tool mutating
  for `decideMutation`, so it is offered only in the `direct` write mode with
  `ai.mutatingToolsEnabled` on and a policy other than `deny`, and it is
  refused after foreign text under `guarded`. `read` is never refused there.
  There is no API behind an external call to refuse it a second time, so
  this decision in `apps/worker/src/external-tool-call.ts` is the only one.
- **Every answer is foreign.** The server's text, its error messages
  included, is cut at the loop's cap, fenced as `external-mcp` and marks the
  run. A failure of ours is a closed code (`timeout`, `unauthorized`, ...),
  never the server's words, and tells the model that whether the call had an
  effect is unknown.
- **Each call is checked again.** The tool, its server, the membership and
  the master switch are read from the database before every call, and the
  secret is decrypted in the worker for that call alone. Blocking a tool,
  narrowing it to read, a new check that saw it change, switching the server
  off or deleting it stops the next call of a run already going
  (`tool_revoked`, `server_disabled`, `external_mcp_disabled`,
  `membership_revoked`).
- **An eval replay gets none.** A foreign server is neither replayable nor
  harmless, and a sandboxed replay must not reach outside the deployment.
- **The timeline names the reason.** A `tool_call` event carries
  `failureCode` when the call was refused or failed, for every tool of the
  loop, and the run inspector shows it beside the duration.

## Trusted servers and suggested classes (2026-10-14)

The first real use showed two costs of stage 3 that nobody should pay:

- **Reading locked writing to the same server.** Asking the health app for
  a food and then logging the meal is one task, but the first answer marked
  the run and the log was refused. So a server carries `trusted`, a person's
  word at the browser that its answers are their own data. The answer is
  still fenced as data; it just does not mark the run. Whether a server is
  trusted is read at the moment of each call, so withdrawing the word stops
  the next one, and changing the address switches it off like it blocks every
  tool. Foreign text from anywhere else still locks every write, the trusted
  server's included.
- **A refusal named the wrong way out.** `decideMutation` points at
  `exo_changeset_propose`, which holds page writes and cannot change somebody
  else's server. An external write tool is refused with its own text: say
  what you would have written, so the person can confirm it in the next
  message.
- **Sixty tools judged one by one.** `suggestExternalMcpToolAccess` proposes
  read or write from the tool name and the server's hints, erring towards
  write: a single writing word, or a server saying it writes, makes it
  `write`, and a name it cannot place is `write` too. It never decides: the
  screen shows the list and `PATCH /mcp-servers/:id/tools` applies what the
  person confirmed, all or nothing, one approval per tool with its
  fingerprint as before. A tool changed since approval is left out of the
  list, because that one is the warning the fingerprint exists for.

## Not decided here

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
- The fingerprint guards what the server _says_ about a tool. A server that
  changes what a tool _does_ without changing its listing is not caught by
  it; that is the trust a person extends by approving a tool at all, and the
  reason a write approval is its own decision.
- The guard is the same code for every request to an address somebody chose
  that this process makes itself: attachments by URL, and now MCP.
- A server that changes its tools often is tiresome to use, by design: each
  change is a new decision.
