# ADR-015: The open page's text in the system prompt

* Status: accepted
* Date: 2026-08-06

## Context

[ADR-009](ADR-009-provider-neutral-ai.md) promised that no document content is
sent to an external provider; only what the user typed. That promise has been
narrowed twice already: [ADR-012](ADR-012-vision-preprocessing.md) lifted it for
images, and the tool catalogue lifted it in practice, because a model that calls
`exo_page_read` gets the page's text in the next request.

Issue #1 added a `## Geöffnete Seite` block to the system prompt: the open page's
title, breadcrumb, id and type. That is metadata, and it exists so a tool-capable
model can fetch the page *when the question is about it*, per question, under the
user's `ai.toolsEnabled` control.

That leaves a hole. A run without tools — the admin switch off, a model without
tool support, or a legacy run with no conversation — gets a pointer it cannot
follow. The honest block tells the model to say so, which is correct but not
useful. For those deployments the chat cannot answer "fasse das mal zusammen"
at all.

Putting the page's text into the prompt closes that hole, and it is a real
change in kind, not in degree: the page goes to the provider whether or not the
question has anything to do with it.

## Decision

The open page's derived text may be put into the system prompt, gated by a new
setting **`ai.pageContextEnabled`, default `false`**.

* Off (the default), the block stays a pointer. Nothing changes for anyone who
  does not choose otherwise.
* On, the block carries `### Inhalt` with the page's materialized
  `markdown` / `plainText` — the same derived text the ALWAYS rule pages use, so
  there is no second serialization path (ADR-007: Markdown is derived, never
  canonical).
* `ai.pageContextMaxChars` (default 12 000) caps it. **The cut is stated in the
  text**, and the wording differs by whether the run has tools, so the model
  never mistakes an excerpt for a whole page. Without that, "the page does not
  mention X" becomes a confident wrong answer about a page that does.
* Collections are excluded: a collection's own body is empty by construction
  (its rows are separate documents), and the view description built by
  `describeCollection` is the richer answer anyway.

Two things stay outside this decision, because the user asks for them per turn
and can see what they asked for:

* A **selection** handed over in the editor. It is content the user picked, saw
  named in a chip, and sent — no different from pasting it into the message.
* A **tool call**. The model fetches a page because the question needed it.

## Consequences

* Self-hosters running a local or tool-less model can finally ask about the page
  they are on. That is the point of the switch.
* Anyone who leaves it off is exactly where they were: title and path out,
  content only on request.
* The conversation-level `pageContextEnabled` still wins. The chip row and
  `/context off` suppress the whole block, text included — "what stands in the
  chip row goes out, what does not stand there does not" holds either way.
* Prompts must never be logged. `packages/logger/src/redaction.ts` now redacts
  `prompt`, `systemPrompt` and `messages` in addition to `markdown` /
  `plainText` / `content`. Nothing logs them today; the entries exist so that
  adding such a log later cannot quietly turn into a document leak into the log
  files.
* Token cost rises for every turn on a large page, and auto-compaction cannot
  help: the system prompt is rebuilt per run and is not part of the transcript
  it compacts. `ai.pageContextMaxChars` is the only brake, which is why it is a
  setting and not a constant.
* ADR-009's consequence list is amended rather than reversed: its promise now
  reads "no document content leaves unless the user asked for it in this turn or
  the admin switched `ai.pageContextEnabled` on".
