# ADR-019: agent memory is a workspace of its own, written through the ordinary domain

* Status: accepted
* Date: 2026-08-12

## Context

Issue #34 asks for eXocortex to be a *memory* for external agents rather than a
place they write pages into: something that records by itself what happened in
a working session, and plays the relevant part back when the next session
starts. The alternative on the table was a dedicated memory service
(TencentDB-Agent-Memory), which would have meant another container, a vector
database beside the one Postgres already is, and a proxy in front of
`ANTHROPIC_BASE_URL` that breaks the subscription login.

Everything a memory needs was already here: a tool catalogue over three
surfaces, `exo_` tokens with scopes, OAuth for remote connectors, full-text
search with paths. What was missing is that nothing writes by itself, nothing is
played back by itself, and a chat client handed forty-six tools does not pick
the right one.

Three questions had to be answered before any of that could be built.

**Where do automatically written notes go?** The curated "Second Brain"
workspace is a human's, and its value is that everything in it is there because
somebody decided it should be. A session log written after every `exit` is not
that, and mixing the two spoils the curated one.

**How is an agent stopped from writing where it should not?** Token scopes
(`read`/`write`/`admin`) are deployment-wide. A `write` token that may append a
memory may, on that evidence alone, overwrite any page in any workspace its
owner can reach.

**What does the recall see?** Search is workspace-scoped by SQL
(`SearchService.search`). A memory that can only see its own notes is half
blind: the infrastructure notes, server setups and credentials an agent needs
live in the curated workspace.

## Decision

**Memory is one workspace, named by a setting, shared by every client.**
`memory.workspaceId` (ADR-013) says which one. All agents write into it, not one
area per client and not one per project: the point is a memory across sessions,
clients and models, and separate areas would be separate memories. Which client
wrote a note and which project it belongs to are properties of the note (a
project page, a client line), not of the workspace structure. Because nobody
reads this workspace as a document, it may be tidied, thinned and expired, which
the curated one may not.

**Authority comes from membership, not from the token.** The agent account is a
member with a writing role in the memory workspace and a reading role in the
curated one. `requireRole` then makes the boundary physical: an `exo_` token
with `write` in the hands of that account cannot change a page in the brain,
because the permission check fails before the scope ever matters. No subtree
permission model is needed, and none was added.

**Recall crosses workspaces and ranks the hits together.**
`GET /api/memory/recall` fans out over every workspace the caller may read,
merges the results into one ranking, and boosts hits from the memory workspace,
more so when they belong to the project the caller named. Two lists stapled
together would be the wrong answer to one question. `includeKnowledge=false`
narrows it to the agents' own notes for a caller that wants only those.

**The raw transcript is never stored.** `POST /api/memory/capture` puts the
conversation into a job and answers immediately; the worker asks a model for a
handful of German bullet points and writes only those, through
`POST /api/memory/remember` with a service token minted for the capturing user
(ADR-014). The transcript exists in the Redis job payload for as long as the job
runs, and nowhere else. The model is explicitly allowed to answer that a session
holds nothing worth keeping, and `memory.captureMinChars` throws away the
smallest sessions before a model is ever paid for one.

**A memory is an ordinary page.** `MemoryService` writes through
`DocumentsService` and `DocumentContentService`, not through Prisma: a note
lands in the outbox, is indexed for search, and reaches an editor that has the
page open (ADR-016), exactly as a hand-typed page does.

**Chat clients get their own tiny surface.** `ToolSurface` gains `memory`, and
`POST /api/mcp/memory` serves three tools: `recall`, `remember`, `fetch`. The
argument is the one that already justified `/api/mcp/research`: which catalogue
a client should see belongs to whoever configures it, and a chat model handed
dozens of tools reaches for the wrong one. `fetch` is the research surface's own
tool, shared rather than copied. These three carry no `exo_` prefix, unlike the
full catalogue, because that prefix guards against collisions between several
MCP servers a coding agent runs side by side, which is not this surface's
situation.

## Consequences

* A deployment without `memory.workspaceId` has no capture destination.
  `capture` refuses with a reason instead of guessing, and `recall` still works
  across the workspaces the caller can read.
* Claude Code gets capture and injection from two hooks in
  `tools/claude-code-hooks`, not from the catalogue: a hook is what fires at the
  start and the end of a session. Both fail silently by design.
* ChatGPT has no `SessionStart` equivalent. Automatic recall there is a line in
  the custom instructions ("call `recall` before answering when the question
  refers to earlier work"), which is why that text block belongs in
  `docs/mcp.md` rather than in somebody's head.
* Recall ranks on Postgres full text plus the boosts above. Semantic recall over
  the `pgvector` columns (issue #34, AP4) would replace the ranking inside
  `MemoryService` and change nothing about the shape decided here.
* The memory workspace grows without bound until something prunes it. Nothing
  does yet; the workspace was chosen so that pruning is allowed to exist.
