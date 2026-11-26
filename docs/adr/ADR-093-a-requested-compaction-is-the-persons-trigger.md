# ADR-093: A requested compaction is the person's trigger, not the plan's

- Status: accepted
- Date: 2026-11-26
- Relates to: ADR-032 (context-aware provider routing, when the automatic
  compaction runs), ADR-025 (the same capability for the browser, the built-in
  AI and MCP), ADR-090 and ADR-091 (who pays for a model call), issue #287

## Context

`/compact` has been in the chat's command list since the first chat panel, and
it never compacted anything. Its handler answered "the context is summarised
automatically once it reaches the limit, use /clear to empty it", because the
summariser is a provider call and the command was answered inside the API
request. A command that does nothing when somebody asks for it explicitly reads
as broken, and the person who reported it read it exactly that way.

The automatic compaction answers a different question. ADR-032 lets it run only
when a smaller prompt would put a provider back in reach: "is this
conversation long" is not the question, "can a shorter one still be served
where this one cannot" is. That question is right for a step nobody asked for,
and it says nothing about a person who wants to draw a line under a
conversation that has changed direction, or wants the next turns to be cheaper.

## Decision

**A request is its own trigger, and it is carried out however empty the window
is.** `/compact` in the chat, `POST /api/ai/conversations/:id/compact` and the
MCP tool `exo_chat_compact` end in one function
(`requestConversationCompaction`, `apps/api/src/ai/conversation-compaction.ts`).
It does not ask ADR-032's question. The answer names how full the context is
and whether the automatic compaction would have run anyway, so the person
learns the difference without being refused.

**It summarises the whole history, not the older part.** The automatic
compaction keeps a recent tail verbatim, because it acts without being asked
and must not touch the thread being worked on. Somebody who asks for the
conversation so far to be summarised has asked for exactly that, so a request
summarises every message still in the context into one summary message. Two
messages are the least worth summarising, as in the automatic case.

**The summary is written by the worker, on its own queue.** The API decides,
claims the conversation and queues `conversation-compaction`; it never calls a
provider for this. The job carries the model the next message would run on,
and the worker resolves the provider and the paying key the way a run does,
so a workspace's own key pays for its summaries and an unreadable one stops
the work (ADR-090, ADR-091). Not a run on the `ai` queue: nothing is answered,
no tool is offered, and a run row would put a turn into the transcript that
nobody asked a question for.

**The conversation is held while the summary is written.** The request is
`AiConversation.compactRequestedAt`. While it is younger than
`AI_CONVERSATION_COMPACTION_LEASE_MS` (two minutes, twice the summariser's own
timeout), a new message or command is refused with `ai_conversation_compacting`,
so a run never reads the messages the summary is about to retire and `/clear`
never retires them under it. The claim is one conditional update, so two
requests at once queue one job. Past the lease the request counts as
`abandoned` for every reader and the conversation is free, so a job that
vanished can never lock a chat for good. A request is refused while a run is
open (`ai_conversation_locked`), like a message.

**The outcome is read twice.** On the row, as `compactionError` beside
`compactRequestedAt` in every conversation read (`exo_chat_read` prints it),
and as an event for the open panel: `ai.conversation.compacted`, the same one
the automatic compaction sends, or `ai.conversation.compaction_failed` with
the code. Retrying is asking again; a summary of a few seconds has nothing
worth cancelling.

**MCP only among the agent surfaces.** The built-in AI acts from inside a run
of its own conversation, and that run holds the conversation against exactly
this request, so the tool could never succeed there. Inside a run, the
automatic compaction is the one that applies.

## Consequences

- `/compact` does what its description says, and the help text now says "the
  conversation so far" rather than "the context".
- The automatic compaction is unchanged, except that an empty summary is no
  longer accepted by either trigger: it would retire the messages and replace
  them with nothing, which is a `/clear` nobody asked for.
- The transcript's boundary line looks for the summary in the whole stretch
  still in the context, because the summary is written below the messages it
  keeps. The automatic compaction's boundary used to read "Kontext geleert".
- Neither trigger's summariser call is in the usage report yet; that was true
  of the automatic one before and is recorded as a known limitation in
  `docs/ai-architecture.md`.
