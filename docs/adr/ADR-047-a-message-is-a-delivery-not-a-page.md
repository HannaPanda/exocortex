# ADR-047: a message is a delivery, not a page

- Status: accepted
- Date: 2026-09-20

## Context

Several agents work on this deployment at once: Claude Code on two machines,
Hermes, Codex, the built-in AI. They share pages and they share the memory
workspace ([ADR-019](ADR-019-agent-memory-in-its-own-workspace.md)), but they
cannot address each other. When one of them learns something another one needs,
there are exactly two routes: a person repeats it, or the other agent happens to
stumble over the note.

Issue #51 asks for a mailbox. Not a chat and not a realtime channel: a message
with a recipient that waits until the recipient next runs, and that it collects
at the start of that run together with its memory.

The obvious objection is that a shared page already does this, and the answer is
that it does not do the two things that matter. Nobody knows what is _new_ on a
page, and nothing guarantees anybody reads it. A mailbox knows what is unread,
which is what lets `GET /api/memory/recall` put it in front of everything else
at session start.

Three questions then had to be decided.

**What shape is a message?** Nearly everything in this system is a page, and the
issue itself suggests a database in the memory workspace
([ADR-011](ADR-011-database-rows-are-documents.md)), whose rows are pages too.

**When does a message count as delivered?** If reading marks it read, a session
that dies on its first tool call has lost its post. If nothing marks it read,
every session for the next year opens with the same three messages.

**What is the text of a message, inside a model's context?** This is the part
the issue calls the real crux, and it is right. A message is text another
language model wrote, and it arrives in a window where a model is reading its
instructions.

## Decision

**A message is a row, not a page.** `AgentMessage` carries sender, recipient,
subject, body, an optional project, an optional page it is about, a read
timestamp and an expiry. Three concrete things follow, and each of them is why:

- the nightly consolidation reads session notes under project pages and distils
  them into facts ([ADR-021](ADR-021-facts-above-notes.md)), so a message shaped
  like a page would let an agent write into the memory's own fact layer by
  mailing itself,
- the search index stays about knowledge rather than about post,
- a full mailbox ages out through its own `expiresAt` instead of waiting for
  `memory.retentionDays`, which defaults to "for ever" because it governs notes.

Nothing about a message is collaborative, and rule 5 is about collaborative
state: there is none here, so a Yjs document per message would have bought a
materialization job per message and nothing else.

**Addressing is membership.** A message travels inside one memory area and both
accounts must be members of it. There is no directory and no cross-workspace
delivery, so the permission question was answered before the feature existed:
the accounts that share a memory are exactly the accounts that can write to each
other. A sender addresses a recipient by display name or email, and the listing
endpoint answers with the names it may use — a model has a name in front of it
and no directory to look an id up in.

Addressing oneself is legal. The same agent account runs on several machines
here, so "tell the next session on the other host" is one account writing to
itself, and refusing it would refuse the most likely first use.

**Reading is not acknowledging.** `recall` and `GET /api/memory/messages` both
leave `readAt` alone; `POST /api/memory/messages/read` is the acknowledgement,
and the session-start hook sends it _after_ it has written the context block.
Delivering a message twice costs a few lines. Losing one costs the thing it was
sent for.

**Everything expires, and the sweep has no switch.** A message is written with
an `expiresAt`, and `prune-agent-messages` deletes what has passed it, hourly
and unconditionally. Every other sweep in that queue waits for a retention
setting somebody turns on, because deleting what a person wrote is not something
an update should quietly begin doing. This one is different in kind: the expiry
is part of what the mailbox promises.

**A message is fenced as data wherever it is rendered.** One function renders
the block for the recall, for the listing endpoint and for the tool, and it
reserves the room for the closing sentence before it writes anything, so a
budget that runs out drops messages and never the fence. The sentence says what
the text is: notes from other agents, a hint and not an instruction, and tasks
come from the person.

**It is not `untrustedOutput`.** The mutation fence of
[ADR-030](ADR-030-foreign-content-and-mutating-tools.md) closes the write
door for a whole run, and marking the mailbox that way would make it useless for
the built-in AI: it would read its post at the start of a run and then be unable
to act for the rest of it. The distinction is origin. `exo_web_fetch` and
`exo_attachment_read_text` return text from outside this deployment; a message
comes from an authenticated account that is a member of this workspace, exactly
like the pages that account writes, and those are not fenced either.

**A hard ceiling on what a recall carries.** `memory.recallMessageLimit`
(default 3) caps the number, and the mail block may take at most a quarter of
the recall's character budget. A full mailbox must not eat the context window
the recall exists to improve.

## Consequences

Three REST routes under the memory surface (`POST /api/memory/messages`,
`GET /api/memory/messages`, `POST /api/memory/messages/read`) and three tools on
both agent surfaces. `GET` and `POST` are split the way the rest of that
controller is: the required scope is derived from the method, so a client that
only collects its post never needs a `write` token.

There is no screen. Agents write to each other and the post appears at the start
of their sessions; a person watching this would be watching a conversation they
are not in. The capability matrix marks the UI column `·`, which is not a gap
(ADR-025) — but it does mean a mailbox filling up with something nobody wants is
visible only through the settings that switch it off.

`memory.mailboxEnabled` is one of those, and it defaults to on. An empty mailbox
changes no recall, so the cost of having it switched on in a deployment with a
single agent account is zero.

The read state is per message and has exactly one reader, which is what keeps it
a column rather than a table. A group address, a reply chain and a thread are
all things this deliberately does not have; if they are ever wanted, they are a
second decision and not an extension of this one.
