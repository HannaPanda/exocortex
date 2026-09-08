# ADR-022: an agent's writes are grouped by session, and taken back as one

- Status: accepted
- Date: 2026-09-08

## Context

Every page here already carries its own history: `DocumentSnapshot` holds a
restorable version before each write, and the Aktivität tab merges those with
the audit log into a readable trail. Both are **per page**.

The question people actually ask about an agent is not per page:

> What did this agent touch this afternoon, and take all of it back.

That question could not be asked. Answering it required already knowing which
pages were involved, which one only learns after noticing that something went
wrong — and by then the cheap way to find the rest is gone.

The consequence was not a missing feature, it was a missing decision: write
access to the curated brain stayed something one had to be brave about. Not
because an agent is likely to write nonsense, but because a mistake was
expensive to clean up. A reverse gear makes write access cheap, and cheap write
access is the precondition for agents actually using this system.

`correlationId` does not help. It covers exactly one request by design; a
working session is many.

## Decision

**A session id is announced once and carried on every call.** The MCP
`initialize` handshake announces it (`POST /api/agent-sessions`), and
`ExocortexApiClient` stamps it on every subsequent REST request as
`x-exocortex-agent-session`, alongside `x-exocortex-agent-client` for the
client's self-description. The stdio bin mints one id per process, because a
subprocess _is_ the session. The HTTP transport uses the client's
`Mcp-Session-Id`, issuing one when the client brought none; this still keys
nothing in memory, so two API processes go on serving the same client
interchangeably. The built-in AI's tool loop names one session per AI run.

The id is chosen by the client, so it is trusted only inside one account:
`AgentSession.externalId` is unique **per user**, and naming somebody else's
session id lands in a row of one's own.

**The journal is written from the outbox, not from the mutation sites.** Every
domain event already passes through `OutboxService.writeEvent` inside the very
transaction that changed the data (ADR-010). Hanging `AgentWriteJournal` off
that costs no second write path and cannot drift from what actually happened.
Writes that took a snapshot pass its id along; the three services that take one
do so explicitly.

**The journal points at snapshots; it never copies content.** The state before
a write already exists as a snapshot. Duplicating bytes would double the cost of
every write to buy nothing.

**A bulk revert is a series of ordinary snapshot restores.** `POST
/api/agent-sessions/:id/revert` walks the session's pages and calls the same
`DocumentSnapshotService.restore` a human uses, so the open editing session is
told (ADR-016), the change is materialized, and each restore is audited exactly
as a manual one is. It reverts to the state before the session's _first_
snapshotted write on each page: a session that rewrote a page four times is one
intervention.

**The revert is partial by nature and says so.** It is not a transaction and
cannot be one. It answers with two lists — reverted and skipped, each skip with
a reason — rather than failing as a whole. A page somebody else has written
since is skipped and named, never overwritten.

**Two signals decide "somebody else has been here since":** a journal row from
another session, and a `yjsUpdatedAt` that moved. The second one is needed
because a person typing in the editor never passes through the API at all. It
carries a two-minute grace window, because a write is handed to the
collaboration server afterwards (ADR-016) and comes back persisted under a
later timestamp; without the window no revert would ever proceed.

**Listing a session is a tool, reverting one is not.** `exo_agent_session_list`
and `exo_agent_session_get` are in the catalogue (CLAUDE.md rule 11). The revert
is deliberately exempt: an agent that can take back an afternoon in one call is
a new way to lose work, and whether a session was a mistake is not a judgement
the agent that made it is in a position to make. A person presses that button in
the admin area.

**The journal ages out on its own, shorter clock.**
`agents.journalRetentionDays` defaults to 90 days. What expires is the grouping,
not anything recoverable: the snapshots it points at age out on the snapshot
schedule, which is longer and belongs to the page, not to the agent.

## Consequences

- Giving an agent write access is a reversible decision. That is the whole point
  and the only reason this was built.
- Provenance never blocks work: an announcement that fails is swallowed, and a
  write with no session simply is not journalled. A feature whose job is quiet
  background correctness must not be able to take the deployment down.
- A revert inside the two-minute grace window can overwrite a human edit made in
  that window without naming it. This is the one accepted risk, and it is
  written down at the constant.
- Renames, moves and archivings are recorded but not revertable: they leave no
  snapshot to go back to. The answer names them rather than pretending.
- A client that does not echo `Mcp-Session-Id` loses the grouping and keeps
  everything else — each write becomes its own one-line session rather than
  none at all.
