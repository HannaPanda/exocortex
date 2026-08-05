# ADR-012: Vision preprocessing sends document images to an external provider

* Status: accepted
* Date: 2026-08-05

## Context

ADR-009 states that no document content is sent to an external provider, only
the messages a user typed. That held while `AI_PROVIDER=mock` was the only
provider actually running requests. Once OpenRouter is activated with a real
main driver, a text-only model cannot answer questions about a page that
contains images: it never sees them.

GLM 5.2, the configured main driver, is text-only (no vision input). A
separate, cheap vision-capable model (`OPENROUTER_VISION_MODEL`) can describe
an image in text, which the main driver can then reason about.

## Decision

When an `AiRun` references a document, the worker walks that document's
materialized ProseMirror JSON for `image` nodes, resolves each to its
`Attachment` row (scoped to the run's own workspace and document), fetches
the bytes from object storage and describes it through the vision model
(`packages/ai/src/vision-preprocessor.ts`). The resulting text is prepended
as a `system` message ahead of the messages the user actually typed.

This means **document images do leave the system**, sent to whichever
provider `OPENROUTER_VISION_MODEL` names, base64-encoded in the request body
(object storage is not reachable from the public internet on this
deployment, so a plain image URL is not an option; see `deploy/README.md`).

Consequences carried over from ADR-009 still apply everywhere else: the
messages a user typed are still the only thing that ever reaches the main
driver as-is, application code still never imports a vendor SDK directly,
and the vision preprocessor still refuses to run without both a model and an
API key configured (`createVisionPreprocessor` in `registry.ts`).

## Consequences

* `ADR-009`'s "no document content is sent to an external provider" is
  superseded for document images specifically. Everything else in ADR-009
  (provider-neutral contract, budgets, timeouts, cancellation) is unaffected.
* Capped at 4 images per `AiRun` (`MAX_IMAGES_PER_RUN` in
  `apps/worker/src/processors/ai-run.ts`) to bound cost and latency.
* No caching: a multi-turn conversation about the same page re-describes its
  images on every turn, since each `AiRun` is independent and the client
  resends the full visible history each time (`apps/web/src/components/ai/ai-panel.tsx`).
  A future iteration could cache a description per attachment.
* Best-effort: a document that fails to load, an attachment that cannot be
  resolved, or one failed description is logged and skipped. A run never
  fails because of an image; it proceeds with fewer descriptions or none.
* The image descriptions are never persisted into `AiRun.messages` — only
  what the user typed is stored, consistent with the schema comment.
* Turning this off entirely (falling back to ADR-009's original guarantee)
  is one env var: leave `OPENROUTER_VISION_MODEL` unset.
