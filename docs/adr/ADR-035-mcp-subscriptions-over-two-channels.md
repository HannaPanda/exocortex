# ADR-035: MCP subscriptions ride a channel per transport, and every message is authorized when it is written

Status: accepted
Date: 2026-09-18
Issue: #48 (part 3)
Supersedes nothing. Extends ADR-018 (two transports, one dispatcher) and is
bound by ADR-029 (withdrawing access reaches connections that are already
open).

## Context

`resources/list`, `resources/read` and `prompts/*` were built in the first two
parts of issue #48 and are in use. The third part is the one that changes the
shape of the server rather than its catalogue: `resources/subscribe` promises a
client that it will hear about an attached page without asking again, and
`notifications/resources/updated` is a message that travels from server to
client outside any response.

Nothing in this deployment sent such a message before. Both MCP transports were
request-and-answer all the way down: the stdio bin reads a line and writes a
line, and `POST /api/mcp` was answered with JSON and forgotten, which is what
let the endpoint claim that any API process could serve any request.

There is a second, less obvious problem. A notification is a message sent to
somebody who did not ask for it at that moment, so the question "may this
account see this?" has to be answered by the sender rather than by the request
that is not there. The Socket.IO gateway answers it by authorizing a room
subscription once and then trusting the room, which is why ADR-029 had to add a
revocation channel and a re-authorization sweep underneath it.

## Decision

**Each transport opens its own channel, and the dispatcher stays free of both.**
`packages/mcp-tools` gains a `ResourceSubscriptions` set and the mapping from an
application event to the resource URIs it touched. It holds no socket, no
timer and no Redis client. `capabilities.resources.subscribe` is derived from
whether a transport handed the dispatcher a set, so a client is never told it
may subscribe by a connection that could not deliver.

**The HTTP transport opens the SSE channel the specification already describes.**
`GET /api/mcp` with `Accept: text/event-stream` is no longer refused; it is the
standalone server-to-client stream of one MCP connection, keyed by
`Mcp-Session-Id` _and the account_, because the id comes out of a
client-supplied header and two accounts are free to send the same one. The
narrow research and memory surfaces serve no resources and go on refusing.

**The stdio transport consumes a change feed instead.** `GET /api/mcp/changes`
is server-sent events carrying resource URIs and nothing else; the subprocess
holds its own subscriptions and filters. It is a separate endpoint rather than
the session stream above because the bin is not an MCP client of this
deployment: it answered `resources/subscribe` itself, and a notification
addressed to a session the API knows nothing about would have to be invented
there. The feed is opened by the first subscription and not before, so a client
that only calls tools costs this deployment no standing connection.

**Every message is authorized at the moment it is written.** For each event,
the accounts with an interested stream are asked against the database whether
they may still read the workspace the event came from. There is no cached
membership to go stale, so — unlike the Socket.IO gateway — these streams need
no periodic re-authorization sweep to be correct. The sweep that does exist
covers the one thing the per-event check cannot see: an account that was
switched off keeps its memberships.

**A revocation closes the stream rather than trimming it.** MCP has no way to
say "you may no longer watch that page", so a connection that stayed open with
a quietly shortened list would be a client that believes it is still watching.
Closing is something every client already knows how to answer, and what it
subscribes to after reconnecting is authorized from scratch (ADR-029).

**A subscription is never refused for a page that does not exist.** Any
well-formed URI is accepted. Refusing an unknown id while accepting a readable
one would answer exactly the question `resources/read` refuses to answer, and
the cost of accepting is a subscription that never fires.

## Consequences

- **The HTTP endpoint is no longer entirely stateless.** One connection's
  subscriptions live in the memory of the process that answered its POSTs. With
  more than one API process a client could subscribe on one and hold its stream
  on another, and the symptom would be a quiet stream. This deployment runs one
  API unit; the day it does not, the set belongs in Redis, keyed the same way.
  The write journal (ADR-022) is unaffected, because it was never in memory.
- **A held connection is a resource an endpoint cannot shed under load**, so
  there is a per-account limit across both endpoints and a refusal when it is
  reached, rather than a ninth socket nobody counted.
- **Heartbeats are load-bearing.** nginx closes an idle upstream response after
  300 seconds and a client's own proxy will be less patient, so the server
  sends a comment line every 25 seconds and the stdio feed treats several
  missed ones as a dead connection. A stream held open by a proxy and carrying
  nothing is the failure this catches, and it is invisible otherwise.
- **The notification is a pointer, never content.** It names a URI; the client
  reads the resource if it cares. A message that carried the page would be a
  second copy able to disagree with the canonical state, and it would put text
  into a channel whose authorization is checked per workspace, not per page.
- **`listChanged` stays false.** The listing is "recently edited", which
  changes constantly; a client refetching it on every keystroke elsewhere would
  be worse than a listing that is a few minutes old.
