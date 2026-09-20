# ADR-046: a checkpoint is a receipt, not an archive

- Status: accepted
- Date: 2026-09-20

## Context

Issue #92 asks for eXocortex to become a Hermes memory provider, and the part of
that which is not plumbing is `on_pre_compress`. Hermes compacts a long
conversation by summarising the old part of it and dropping the wording. With
`compression.checkpoint_required: true` it will only do so once a provider has
confirmed a durable write. That inverts the promise the memory surface has made
so far.

`POST /api/memory/capture` answers immediately and guarantees nothing
([ADR-019](ADR-019-agent-memory-in-its-own-workspace.md)): the transcript goes
into a job, a model distils it later, and if the worker is down the memory is
simply not written. That is right for a `SessionEnd` hook, whose caller has
already exited and for whom a missing note is a small loss. It is exactly wrong
here, because this caller is still running and is asking permission to forget.

Two things then had to be decided.

**What is durable?** The obvious answer is "the evidence", and the obvious
implementation is a table of conversations. ADR-019 says the raw transcript is
never stored, and the memory workspace is the one place whose promise is that it
may be tidied, thinned and thrown away. A transcript archive in there would be
both the largest thing in the database and the least protected.

**How does a second checkpoint of the same conversation not cost twice?** Hermes
does not send retries. It sends longer prefixes: it compacts at turn 40, and
again at turn 80 with the first forty turns still in the message list. A digest
over the whole payload recognises only an exact repeat, which is the one case
that does not occur.

## Decision

**The checkpoint is synchronous and it throws.** `POST /api/memory/checkpoint`
distils the evidence in the request, writes the note through the same
`MemoryService.remember` a hook would call, and answers afterwards. Everything
`capture` reports as a `reason` (memory switched off, no memory workspace, AI
switched off) is an `AppError` here. A soft refusal would reach Hermes as a
successful checkpoint and become permission to drop the conversation.

**What is stored is a receipt.** `MemoryCheckpoint` holds the session id, the
client, the project key, digests, two counts and the note that came out. No
message text, ever. The durable artefact of a checkpoint is the note, which is
an ordinary page like every other memory; the row exists so the next call can
tell what has already been seen.

**Deduplication is per message, not per payload.** Each message is hashed to
sixty-four bits, the union of the digests of this session's earlier checkpoints
is subtracted, and only what is left is handed to the model. A second checkpoint
of an overlapping conversation therefore costs exactly the new turns. When
nothing is left, the endpoint answers with the previous checkpoint and
`deduplicated: true`, which is a success: the caller may compact. The row's
`digest` over the new messages is unique per session, so two identical calls
racing each other resolve to one row rather than to two notes.

**"Nothing worth keeping" is a successful checkpoint.** The distiller may answer
`NICHTS`, exactly as it may for a capture. The receipt is then written with no
document, and compaction proceeds. The alternative -- refusing to let an agent
compact a stretch of conversation that a model judged to be worthless -- would
turn the safety mechanism into a way of pinning small talk in a context window
forever.

**The distillation happens in the API.** The prompt, the parser and the caps
moved to `packages/ai/src/memory-distill.ts` and are shared with the
`memory-capture` job, so the two kinds of note cannot drift apart in shape. This
is a provider call in the request path, which the API already does for
embeddings; it is not a CLI agent, and rule 6 is untouched. The timeout is 45
seconds rather than the job's 120, because nginx closes an idle proxied
connection at 60 and a timeout the reverse proxy wins is a failure the caller
never learns about.

**The provider talks HTTP, not MCP.** `integrations/hermes-memory-provider` is a
small Python package with no dependency beyond the standard library and Hermes
itself. The memory-provider lifecycle is not the MCP lifecycle: it has to
persist synchronously at a point where no tool loop is running, and routing that
through a tool catalogue would mean an agent could decline to call it.

## Consequences

- The endpoint is the second entry in `check-mcp-catalog.mjs`'s exemption list
  that is machinery rather than a capability, with the same argument as
  `capture`: it belongs to a client's compaction lifecycle, and the deliberate
  half of it is `remember`, which is a tool.
- A checkpoint costs a model call. `memory.captureMinChars` does not apply,
  because the caller does not get to decide that its lost turns were too short
  to matter; the model's `NICHTS` is the filter instead.
- Receipts are pruned by `pruneMemories` on `memory.retentionDays`, the same
  clock as the notes. A session whose notes have gone has nothing left to
  deduplicate against.
- A client that sends no `sessionId` is refused at the schema. Without one there
  is nothing to recognise a second checkpoint by, and the deduplication this
  endpoint promises would be a lie.
- The receipt points at its note with `onDelete: SetNull`. A memory note is an
  ordinary page and somebody may delete it; the record that a checkpoint
  happened survives that and simply stops pointing anywhere.
