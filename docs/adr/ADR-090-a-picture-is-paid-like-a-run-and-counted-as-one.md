# ADR-090: A picture is paid for like a run and counted as one

- Status: accepted
- Date: 2026-11-26
- Amends: ADR-023 (a workspace key buys the runs and nothing else)
- Relates to: ADR-014 (one tool catalogue through the API), ADR-059 (a run
  says what went wrong), issue #10 (the usage report), issue #52 (workspace
  keys), issue #225 (a refused key), issue #252

## Context

ADR-023 drew the line for a workspace's own OpenRouter key at "what a run
spends": the model call and the vision companion inside it. Page covers stayed
on the deployment key, together with the memory jobs and the embeddings.

For covers that boundary turned out to cost money nobody had agreed to spend.
A cover is a picture somebody in one workspace asked for, on one page of that
workspace, and the image models are the most expensive single calls the
deployment makes. A workspace that brought its own key so it would carry its
own costs still drew every cover on the operator's account. And the picture
was nowhere in the usage report, because the report reads `ai_run` and a cover
left no row there: the money was spent and not shown.

Embeddings and the memory jobs are a different case and stay where ADR-023
put them: embeddings have to share one vector space (ADR-020), and the memory
jobs serve the agent memory, not a page somebody in a workspace is looking at.

## Decision

**A cover is paid for by the workspace it is drawn for.** The cover job asks
`aiKeyFor(workspaceId)` like a run does: the workspace's own OpenRouter key
when it has one, the deployment's only when it has none. A key the workspace
brought gets a generator of its own, never a cached one, because the cache is
keyed by model and not by secret. The overview pages' automatic covers go
through the same job and the same rule.

**A refused key ends the cover, and nothing steps in.** A 401 or 402 from the
image model fails the cover with `key_refused` (`invalid` or `credits`, and
whether it was the workspace's key), worded for the reader in the browser. No
second request is made with the deployment's key. This is the same rule
issue #225 set for runs, and the same reading of the status
(`keyRefusalReason`).

**Every picture asked of a model is an `ai_run` row of kind `IMAGE`.**
`AiRunKind` (`CHAT`, the default for every existing row, and `IMAGE`) is a
column on `ai_run`, not a second table, so the usage report, the admin
overview's day total and every later question over `ai_run` count covers
without a union. The row carries the workspace, the page, who asked, the
configured model, the provider, the tokens, the reported price (OpenRouter is
asked for it with `usage.include`) or else the registry's estimate, the
duration, `usedOwnKey`, and for a refused key the `keyRefused` diagnosis of
ADR-059. It is written once, when the call is over, successful or not: a
picture has no turns and no heartbeat, so a row that existed while it was
being drawn would only be a state for the reaper to misread. A cover that was
never asked of a model (no image model, image generation switched off) leaves
no row, because it cost nothing. Writing the row never fails the cover.

The usage report breaks its per-model table down by kind as well, so an image
model that also chats shows its pictures and its conversations apart.

## Consequences

- **A workspace with its own key no longer costs the deployment anything for
  covers.** What still does: memory capture and consolidation, overview
  compositions, embeddings, exactly as ADR-023 says.
- **Covers count in the success rate and the duration percentiles.** A failed
  picture is a failure of the AI the deployment offers, so it belongs there;
  an image call is slower than most turns, which the percentiles now show.
- **A deleted page does not lose the cost.** The row is written without its
  page when the page is gone by the time the picture is drawn.
- **Unchanged and still open:** a stored workspace key that cannot be
  decrypted falls back to the deployment key, as ADR-023 decided, for covers
  as for runs, and the row then says the deployment paid. Whether that should
  rather fail is a decision for whoever answers for the bill, not part of this
  record. (Decided since, in ADR-091: it fails. A cover ends with
  `key_unreadable`, nothing is asked of a model and no row is written.)
