# ADR-029: Withdrawing access reaches the connections that are already open

- Status: accepted
- Date: 2026-09-16

## Context

Authorization in this system is decided per request. `SessionGuard` loads the
session, `WorkspaceAccessService` loads the membership, a policy answers, and the
answer is thrown away again. That is the right shape for HTTP: the next call asks
again, so removing somebody from a workspace takes effect on their next click.

Two channels do not work that way, because they cannot:

- the application realtime socket (`apps/api/src/realtime/realtime.gateway.ts`)
  authenticates once in `handleConnection` and authorizes a subscription once in
  `workspace.subscribe`, then leaves the socket in a Socket.IO room;
- the collaboration socket (`apps/collaboration/src/server.ts`) authenticates
  once in `onAuthenticate` and puts `read` or `write` on the connection.

Both live as long as the browser tab does, which is hours. So a member who was
removed from a workspace kept receiving its events, and an editing session that
was writable when it opened stayed writable after the role behind it was taken
away. `DocumentPersistence.store` cannot catch that either: by the time it runs
it knows a document and a state, not a person (issue #62).

A ticket or session TTL does not solve it. A minute-long collaboration ticket is
only checked when a socket opens, and the socket that matters is the one that is
already open.

## Decision

### A revocation is an event on its own Redis channel

`exocortex:revocations` carries `{ userId, workspaceId | null, reason }`
(`packages/contracts/src/revocations.ts`, `RedisRevocationBus` in
`packages/queue`). The API publishes after the membership or account change is
committed; every API and collaboration process subscribes and matches the message
against the connections it happens to hold.

Deliberately **not** the application event bus. That bus fans out into workspace
rooms, which is exactly where "this person just lost access" must not be
published, and its audience is browsers rather than processes.

Deliberately **not** the transactional outbox either, although ADR-010 is the
rule for domain events that need reliable follow-up. A revocation is not
follow-up work, it is the second half of an authorization decision, and the
outbox dispatch is a poll: seconds of write access after the right was withdrawn
is the thing this ADR exists to remove. Reliability is bought differently, below.

### `workspaceId: null` means the account

Removing a membership or changing a role affects one workspace. Disabling or
deleting an account affects every connection it holds, and the message says so
with a null workspace rather than one message per workspace the process would
have to enumerate.

### A revoked connection is replaced, never patched

The realtime socket leaves the workspace room and is told; the browser answers
with a fresh `workspace.subscribe`, which runs the membership check again. The
collaboration connection is marked `readOnly` and its socket is closed; the
client reconnects on its own and asks for a new ticket while doing so.

That is what makes a _widened_ permission safe: nothing is granted into an
existing connection. A promotion publishes a revocation like a demotion does, the
connection is rebuilt, and the new rights arrive through the same door as the
first ones. A server that quietly upgraded a live connection would be a second
authorization path with no handshake to audit.

The realtime socket survives a workspace-scoped revocation, because the other
workspaces on it have nothing to do with this change. An account-scoped one
disconnects it.

### Redis is the fast path, a sweep is the guarantee

Redis pub/sub is at-most-once, and a process that is restarting hears nothing.
So both consumers also re-authorize their open connections on a timer: every 60
seconds in the gateway, every 30 in the collaboration server. The sweep asks the
database what the channel would have told them — membership, role, and whether
the account is switched off — and reaches the same conclusion, just later.

The sweep is what the guarantee rests on; the channel is what makes it feel
immediate. Neither alone is enough: a timer-only design leaves a window that is
measured in tens of seconds, and a channel-only design fails silently.

### A disabled account is checked at the collaboration handshake

Switching an account off deletes its sessions and revokes its tokens, but a
collaboration ticket is already in the client's hand and stays valid for its TTL.
`onAuthenticate` therefore asks whether the account is disabled, which is one
query per connect and closes the only window in which a switched-off account
could still open something.

### Removing a member became possible in the same change

Until now the only way to narrow somebody's access was to change their role,
which means the case this ADR is about — "this person should not be in here any
more" — had no answer at all. `DELETE /api/workspaces/:id/members/:userId` is
that answer: it deletes the membership row, audits it as
`workspace.member_removed`, and publishes the revocation. It is not an agent
tool (`EXEMPT` in `scripts/check-mcp-catalog.mjs`), for the same reason changing
a role is not: access is handed out and taken away by people.

## Consequences

- A withdrawn permission is effective in well under a second when Redis is
  healthy, and within half a minute when it is not.
- A role change costs the affected person a reconnect. For the realtime socket
  that is one round trip; for the editor it is a reconnect that merges rather
  than reloads, so nothing typed is lost.
- The sweeps cost one query per connected user plus one per open collaboration
  connection, per interval. At this deployment's size that is noise; a much
  larger one would batch the membership lookups rather than lengthen the
  interval.
- A process that holds connections now needs Redis for correctness, not only for
  scale. `apps/collaboration` therefore takes `REDIS_URL`, which it already had
  for the queue registry.
- Revocation is not a kill switch for content: a removed member keeps the pages
  they wrote, authored by them. Taking access away and rewriting history stay
  separate acts.
