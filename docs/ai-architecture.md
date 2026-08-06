# AI architecture

## Provider contract

`packages/ai/src/provider.ts` is the only interface application code sees:

```ts
interface AiProvider {
  readonly id: string;
  readonly capabilities: AiProviderCapabilities;
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
  stream(request: AiGenerateRequest): AsyncIterable<AiStreamEvent>;
}
```

Capabilities describe text generation, vision, tool calling, structured output,
streaming, the context window, usage reporting and cost reporting.

Usage reporting covers input tokens, output tokens, cached input tokens, provider,
model, provider cost (micro-USD) and duration.

Requests carry cancellation (`AbortSignal`), a timeout and a budget ceiling.
Stream events are typed: `start`, `delta`, `usage`, `done`, `error`.

## What runs in this version

* `MockAiProvider` — deterministic, streams word by word, echoes the question and
  reports usage. It is the default (`AI_PROVIDER=mock`).
* `OpenRouterProvider` — request shaping, SSE parsing and usage mapping are
  implemented; the adapter refuses to run without `OPENROUTER_API_KEY` so it can
  never silently start making paid calls. `OPENROUTER_DEFAULT_MODEL` is the main
  driver (currently `z-ai/glm-5.2`, text-only, no vision).

## Vision preprocessing

`z-ai/glm-5.2` cannot see images, so the worker turns them into text first
(`docs/adr/ADR-012-vision-preprocessing.md`, which supersedes ADR-009's "no
document content leaves the system" for images specifically):

1. When an `AiRun` has a `documentId` and `OPENROUTER_VISION_MODEL` is
   configured, the worker reads that document's materialized
   `proseMirrorJson` and collects every `image` node's `src`
   (`apps/worker/src/processors/ai-run.ts`, `collectImageSources`).
2. Each `src` (`/api/attachments/:id/download`) resolves to an `Attachment`
   row, scoped to the run's own workspace and document.
3. The bytes are fetched from object storage, base64-encoded (object storage
   is not reachable from the public internet on this deployment, so a plain
   image URL is not an option) and sent to `OPENROUTER_VISION_MODEL` via
   `packages/ai/src/vision-preprocessor.ts`, deliberately outside the
   `AiProvider` contract — see its doc comment for why.
4. The resulting descriptions are prepended as a single `system` message
   ahead of the messages the user typed, for that one call only. They are
   never persisted into `AiRun.messages`.

Bounds and known limitations: capped at `ai.visionMaxImagesPerRun` per run
(default 4, `MAX_IMAGES_PER_RUN` in code); no caching, so a multi-turn
conversation about the same page re-describes its images on every turn;
best-effort throughout — a document that fails to load, an unresolvable
attachment or one failed description is logged and skipped, never fails the
run. `ai.visionEnabled: false` turns this off entirely; see "Vision
companions" below for how the companion *model* is now chosen per run rather
than fixed to `OPENROUTER_VISION_MODEL`.

## Conversations and messages

`AiConversation` / `AiConversationMessage` (Prisma) are the persistent side
panel chat history that replaces re-submitting the whole transcript on every
request. The model, title, reasoning level and vision companion override
live on the conversation; every turn — user, assistant, tool, and compaction
summaries — is its own `AiConversationMessage` row.

* **`supersededAt`.** Set by `/clear` and by auto-compaction. A superseded
  message stays in the table and in the UI's history (it is still "what
  actually happened"), but the worker never sends it to the provider again —
  only `supersededAt: null` rows enter the message list a run builds
  (`apps/worker/src/processors/ai-run.ts`).
* **Why the transcript lives in the database, not on `AiRun.messages`.** A run
  is one turn; a conversation is many. Keeping the transcript on the
  conversation means the worker always reads the current, possibly-compacted
  state instead of trusting a copy the API embedded at enqueue time —
  `ConversationsService.postMessage` (`apps/api/src/ai/conversations.service.ts`)
  stores only the just-submitted user message on the `AiRun` row, for
  traceability, and the worker rebuilds the real message list from
  `AiConversationMessage` every time.
* **Ownership.** A conversation is personal, not shared, even inside a shared
  workspace: every route on it, reads included, requires the caller to be its
  own creator (see the class comment on `ConversationsService`) — a
  deliberate widening of "ownership required for writes", documented there.
* **Slash commands** (`/clear`, `/new`, `/model`, `/think`, `/vision`,
  `/compact`, `/rules`, `/tools`, `/help`) are parsed server-side
  (`apps/api/src/ai/chat-commands.ts`) so the side panel, MCP and any future
  client behave identically without reimplementing the command set.

## Page context

The chat knows which page it is standing on. `AiRun.documentId` used to reach
only the vision preprocessor, so a page's images were described to the model
while its title was not even mentioned; now the run's page is named in the
system prompt.

* **A pointer, not the content.** `buildSystemPrompt`
  (`apps/worker/src/system-prompt.ts`) appends a `## Geöffnete Seite` block
  with the title, breadcrumb, `documentId` and type (page or collection), and
  tells the model to fetch the body with `exo_page_read` when the question is
  about "this page". The page's text stays out of the prompt of every
  unrelated turn, and fetching it stays under the user's `ai.toolsEnabled`
  control. **Injecting the content directly is deliberately not implemented**
  — that would need its own setting and its own ADR (issue #1, points 2 and
  5).
* **Honest when it cannot follow the pointer.** Tool availability is resolved
  *before* the prompt is built, so a run without tools (setting off, model
  without tool support, or a legacy run with no `conversationId`) gets a block
  that tells the model to say it cannot read the page instead of inventing its
  content.
* **Scoped to the run's workspace.** The lookup is `findFirst` on
  `{ id, workspaceId }`: a stale or guessed `documentId` contributes nothing
  and is logged, rather than leaking a title from elsewhere.
* **The breadcrumb is bounded.** Ancestors are walked up at most
  `MAX_PATH_DEPTH` (8) levels; a deeper path is rendered with a leading `…`
  so an elided path is not mistaken for a root-level one.
* **Page switches are recorded in the transcript.** The panel keeps the active
  conversation per *workspace*, so walking to another page keeps typing into
  the same transcript. `ConversationsService.postMessage` compares the turn's
  page against `AiConversation.documentId` and, if the conversation already
  has messages, writes a `SYSTEM` message (`↳ Kontextwechsel: …`) immediately
  before the user message that caused it, then rebinds the conversation.
  Without it, everything above the switch would silently refer to a different
  page than everything below.
* **Absent and `null` mean different things.** An omitted `documentId` in
  `postConversationMessageRequestSchema` means "this client does not track
  pages" and inherits the conversation's binding (MCP, scripts); an explicit
  `null` means "the user is somewhere without a page" and clears it. Treating
  both alike would make leaving a page impossible.
* **The id is checked.** Because the title and path now reach the prompt, a
  `documentId` named by the caller is verified through
  `WorkspaceAccessService.findDocumentContext` and must belong to the
  conversation's workspace; otherwise the request fails with
  `document_access_denied`. A page the conversation was merely *bound to*
  earlier and that has since been deleted degrades to "no page" instead,
  so a dead binding cannot lock a user out of their own transcript.

## Tool calling

Conversation-backed runs (never the legacy `messages`-only path) can call the
same `exo_*` tool catalogue the external MCP server serves
(`@exocortex/mcp-tools`, see `docs/mcp.md`).

* **Authorization stays in `apps/api`.** The worker mints a short-lived
  `exos_`-prefixed service token for the run's own user
  (`packages/auth/src/service-token.ts`, D3) and calls the REST API through it
  (`apps/worker/src/tool-runner.ts`). There is no privileged path: a tool call
  can do exactly what that human could do through the API, nothing more.
* **The loop.** `createAiRunProcessor` streams a turn, and if the model
  requested tool calls, persists the assistant turn (with `toolCalls`,
  verbatim as the provider returned them) and runs each call **sequentially**
  — never in parallel, so two mutating calls to the same document cannot
  race — publishing `ai.run.tool_call` (`started` / `succeeded` / `failed`)
  around each one and persisting its result as a `TOOL` message before
  looping again. Only the final, tool-call-free turn's text becomes
  `run.resultText` and the `ai.run.completed` payload; it is also persisted
  as the conversation's closing `ASSISTANT` message, since otherwise the next
  user message would build its context from a transcript silently missing
  the assistant's own reply.
* **Caps.** `ai.maxToolIterations` (default 8) and `ai.budgetMicroUsdPerRun`
  (summed from every turn's reported usage) stop a runaway loop with
  `ai_tool_limit_exceeded` / `ai_budget_exceeded`. `ai.mutatingToolsEnabled`
  gates whether write tools are offered at all.
* **A truncated turn is never a finished turn.** The `done` event's
  `finishReason` reaches `TurnResult`, and `'length'` (the output cap ended the
  turn) is handled explicitly: a cut-off text answer is picked up with a
  continuation prompt and the pieces are joined into one result, a cut-off tool
  call is reported as `ai.run.tool_call` `failed` and retried with the
  instruction to write long content in several `append` calls. After
  `MAX_TRUNCATION_RETRIES` (3) the run fails with `ai_response_truncated`.
  Without this a run could announce a write, get cut off mid-arguments, write
  nothing and still be stored as `COMPLETED`.
* **A tool call that never arrived completely fails loudly.** A call without an
  id or a name cannot be executed and would produce an assistant message the
  adapter has to drop on the next request; it is published as
  `ai.run.tool_call` `failed`, and a turn left with no runnable call fails with
  `ai_tool_call_invalid`.
* **A tool error is never a thrown exception.** `ToolRunner.run` always
  returns `{ text, isError }` — an unknown tool, invalid JSON arguments, an
  `ExocortexApiError` or a zod validation failure all become a `tool` message
  the model can see and react to, instead of crashing the run.
* **Unavailable without a service token.** `SERVICE_TOKEN_SECRET` is optional
  (R2); when unset, tools are simply off and the worker logs one warning per
  process instead of per run.

## Reasoning levels

`AiReasoningLevel` (`NONE`/`MINIMAL`/`LOW`/`MEDIUM`/`HIGH`) is resolved and
clamped server-side against the selected `AiModel` row's `reasoningLevels`
(`AiModelResolverService.clampReasoningLevel`,
`apps/api/src/ai/ai-model-resolver.service.ts`) — a client can request a
level the model does not support (or does not have selectable at all, e.g.
Haiku 4.5's single-element `[NONE]`) and gets the closest supported level
back instead of an error. `/think` reports in German when this happened. The
clamped level becomes `OpenRouterProvider`'s `reasoning.effort` parameter
(omitted entirely for `NONE`).

## Auto-compaction

`compactIfNeeded` (`apps/worker/src/compaction.ts`) runs before every
provider call on a conversation-backed run:

1. Estimate the active transcript's tokens (`estimateConversationTokens`,
   `packages/ai/src/token-estimate.ts` — 3.6 characters/token, deliberately
   conservative so it triggers slightly early rather than late) plus the
   system prompt's tokens.
2. Compare against `ai.compactionThresholdPercent` of the model's context
   window, minus `ai.maxOutputTokens` reserved for the answer.
3. Past the threshold, everything except the most recent
   `ai.compactionKeepRecentMessages` is summarized by the provider (German,
   bullet points, max 400 words) into one new `isSummary: true` message, and
   the summarized originals are superseded (not deleted).

Fewer than two messages left to summarize means the recent tail alone already
exceeds the budget — compaction is skipped and the run proceeds; the
provider will complain if the context is actually too large, which is better
than silently discarding the user's latest question. A failed compaction (a
provider error) is caught, logged at `warn`, and never fails the run.
`ai.conversation.compacted` is published with the before/after token
estimate. `/compact` is advisory only — see "Known limitations".

## Vision companions

A companion model is chosen per run, not fixed at the deployment level
(`apps/worker/src/processors/ai-run.ts`, `resolveVisionCompanionSlug`):

1. The conversation's `visionCompanionSlug` override, if set (`'off'`
   disables the companion for that conversation entirely; `/vision` sets
   this).
2. Otherwise the selected `AiModel`'s admin-configured `visionCompanion`
   (e.g. GLM 5.2 and DeepSeek default to `qwen/qwen3.7-flash`).
3. Otherwise the deployment's `OPENROUTER_VISION_MODEL` default.

**A model with `supportsVision: true` skips the companion call entirely** and
logs that it did — this is the registry's actual payoff: switching the
driver to a vision-capable model stops paying for a second call per image.
`ai.visionEnabled` gates the whole mechanism.

## PDF text

`Attachment.extractedText` / `textStatus` cache the text of a PDF
(D6), populated by the `attachment-text` queue
(`apps/worker/src/processors/attachment-text.ts`) and read — never
extracted — by `exo_attachment_read_text`.

Two engines implement the same `PdfTextExtractor` interface, and the processor
is handed an ordered *chain* of them rather than a single one:

| Engine | Where | Reads scans | Cost |
| ------ | ----- | ----------- | ---- |
| `docling` (`packages/ai/src/docling.ts`) | local `docling-serve` container | yes, via RapidOCR | nothing per document, ~1.5 s CPU per page |
| `openrouter` (`packages/ai/src/pdf-text.ts`) | hosted, `file-parser` plugin with the free `pdf-text` engine | no | billed per page: the whole document comes back as *output* tokens |

**Docling is the default** (`ai.pdfExtractor`). The `pdf-text` parser itself is
free, but it runs inside a chat completion, so the transcribed document is
charged as output tokens — about 4 to 5 cents for a 33-page PDF at
`z-ai/glm-5.2` rates, growing with document length. The local engine costs
nothing per document *and* reads scans, so the hosted one is the fallback, not
the first choice. It stays selectable because a deployment without the
container needs some way to read a PDF at all.

`ai.pdfExtractorFallbackEnabled` (default on) appends the other engine behind
the chosen one, in either direction. That chain is the point of the design: a
`null` from an engine means "found nothing", which for a scan meeting the
OpenRouter engine is routine, so the next engine gets the same document before
the attachment is written off. Measured on the same three-page scan: 0
characters without OCR, 8 378 with it. A *thrown* error no longer ends the
chain either — a hosted call timing out is exactly when the local engine should
get its turn — but a run in which *every* engine threw rethrows, so BullMQ
retries instead of recording "no text layer".

Docling runs with a fixed option set (`do_ocr: true`, `force_ocr: false`,
markdown plus JSON output). Two reasons it is a constant and not a setting:
docling-serve caches one pipeline per distinct option set and building one costs
about 18 seconds, and forcing OCR measurably *loses* text on a document that
already has a text layer (7 549 vs 9 278 characters over three pages). Verified
against docling-serve 1.29.0 on 2026-08-06.

### Metadata

`Attachment.textMetadata` caches what is known about the document, shaped by
`pdfMetadataSchema` in `@exocortex/contracts`. Three sources see disjoint parts
of it, which is why the processor merges *every* attempt rather than only the
winning one:

| | title, author, creator, producer, dates | pages | tables, pictures | confidence | OCR used |
| --- | --- | --- | --- | --- | --- |
| `pdf-info` (`packages/ai/src/pdf-info.ts`) | yes, from the PDF's own `/Info` dictionary | yes | no | no | no |
| `docling` | no | yes | yes | yes | yes |
| `openrouter` | yes, as transcribed by the plugin | yes | no | no | always false |

**`pdf-info` is not an engine.** It reads the `/Info` dictionary out of the
file with `pdf-lib`, locally and for free, before any engine runs, and it never
produces text — so it deliberately does not implement `PdfTextExtractor` and
does not count towards the processor's "is any engine configured" check.

It exists because the dictionary used to be reachable *only* through the paid
engine. Docling returns none of it: verified on 2026-08-06 against the live
container with a PDF carrying all five entries, where its `origin` is limited
to `{mimetype, binary_hash, filename}` and not one value appears anywhere in
the response. Making the free engine the default would therefore have silently
cost the title, the author and the dates. Reading the dictionary separately
decouples the two.

So a scan yields the union: title and creation date from the file, page and
table counts and the OCR flag from the Docling attempt that produced the text.
The engine whose text was kept wins every field it can answer; the local
dictionary and any earlier attempts fill the gaps (`mergePdfMetadata`).
Metadata is stored even when extraction fails outright, because "twelve pages,
no readable content" is a useful answer.

Two read routes:

* `GET /api/attachments/:id/text` returns the text and the metadata, and a read
  *is* the request to extract — a PDF that was never attempted, or whose last
  attempt failed, is (re-)enqueued.
* `GET /api/attachments/:id/text/info` returns everything except the text and
  never enqueues. This is what the editor's PDF block reads on render: pulling
  up to 400 000 characters to draw a one-line header would be wasteful, and an
  enqueue on render would mean a page full of failed PDFs re-runs extraction
  every time someone opens it.

`exo_attachment_read_text` covers both: it prepends a one-line German summary
of these fields to the text it returns, so a model knows it is looking at a
33-page scan before it starts quoting, and `includeText: false` routes it to
the side-effect-free variant.

The editor's `pdf` and `fileAttachment` blocks show the same facts as a line of
chips under the header, plus the extraction status and a "retry" action when it
failed. `packages/editor` knows no routes, so the host injects the reader via
`buildEditorExtensions({ mediaInfo })`; see
`apps/web/src/lib/api/attachment-info.ts`.

`textStatus` states: `NOT_APPLICABLE` (not a PDF), `PENDING` (queued, not yet
attempted), `READY` (`extractedText` populated, capped at 400 000
characters), `FAILED` (`textExtractionError` explains why: unconfigured,
oversized per `ai.pdfMaxBytes`, or no engine in the chain found text). The
OpenRouter engine is built once at boot from `OPENROUTER_DEFAULT_MODEL` (the
file-parser plugin works with any model, so no dedicated env var was needed);
Docling is built only when `DOCLING_BASE_URL` is set, which keeps its ~7.7 GB
container optional. `ai.pdfExtractionModelSlug` exists in the settings schema
for a future per-job model choice but is not wired in yet (see "Known
limitations").

## Known limitations

* **`/compact` is advisory only.** Running it from the API process would
  call a provider from inside `apps/api`, which the execution boundary above
  forbids. It reports that auto-compaction happens automatically instead;
  `/clear` covers the case where the user wants the context gone
  immediately.
* **Reasoning deltas are dropped.** `OpenRouterProvider.stream` deliberately
  discards `delta.reasoning` chunks rather than folding them into
  `resultText` — surfacing model "thinking" is a later feature.
* **`POST /api/documents/:id/content` can lose against a live Hocuspocus
  session.** A document being edited collaboratively has its canonical state
  in memory in `apps/collaboration`; a programmatic content write snapshots
  first (revertable) but can still be overwritten by the next debounced
  store. Documented, not fixed, tonight.
* **The page context has no UI and no selection.** Nothing in the panel shows
  which page the assistant is looking at, there is no way to remove or add one
  by hand, and a block selection in the editor still goes nowhere. A database
  page is announced as a collection but its schema, active view and rows are
  not described. Issue #1, points 3, 4 and 6.
* **`ai.pdfExtractionModelSlug` is not wired into the worker's PDF extractor
  yet.** The extractor is a single boot-time instance built from
  `OPENROUTER_DEFAULT_MODEL`; making the DB setting effective would mean
  rebuilding it per job the way `visionPreprocessorFor` already does.

## Execution boundary (hard rule)

CLI agents must never run inside a process that serves traffic:

* not in `apps/api`
* not in `apps/web`
* not in `apps/collaboration`

`packages/ai/src/agent-runners.ts` defines `AgentRunner` with an isolation
capability (`container` / `separate-process` / `none`), a sandbox working directory,
an allow-list of readable paths, a timeout and a budget.
`createUnimplementedRunner()` throws `AgentRunnerNotImplementedError` — it fails
loudly instead of pretending to work.

When Claude Code and Codex CLI are implemented, they run from `apps/worker` inside a
container.

## Run lifecycle

1. `POST /api/ai/runs` — the API checks workspace membership, validates the payload,
   creates an `AiRun` row in `PENDING` and enqueues an `ai` job. It never calls a
   provider itself.
2. The worker loads the run, refuses anything not in `PENDING` (idempotency), sets
   `RUNNING`, and iterates `provider.stream(...)`.
3. Each `delta` is published as `ai.run.progress` on the Redis event bus with a
   monotonic sequence number, so clients can detect gaps.
4. On completion the run is stored with `resultText` and `usage`, and
   `ai.run.completed` is published. On failure or cancellation the status and
   `errorCode` are stored and `ai.run.failed` is published.
5. The API's event-bus subscriber re-emits into the workspace room; the panel
   renders the deltas as they arrive.

`POST /api/ai/runs/:runId/cancel` marks a pending or running run cancelled; the
worker's `AbortSignal` stops the stream.

## Adding a provider

1. Implement `AiProvider` in `packages/ai/src/<name>-provider.ts`. Honour `signal`,
   `timeoutMs` and `budgetMicroUsd`, and map usage into `AiUsage`.
2. Add the id to `AiProviderId` and to the `AI_PROVIDER` enum in
   `packages/config/src/schemas.ts`.
3. Extend `createAiProvider` in `packages/ai/src/registry.ts`.
4. Add credentials to `.env.example` — never to the browser bundle.
5. Test against the same expectations as `mock-provider.test.ts`: event order,
   monotonic sequence numbers, streamed text equal to non-streamed text, usage
   fields and cancellation.

## Adding an agent runner

1. Implement `AgentRunner` in `packages/ai`, declaring truthful capabilities.
2. Run it from `apps/worker` only, inside a container or at minimum a separate
   process, with an explicit sandbox root.
3. Enforce the timeout and the budget, and stream `AgentRunEvent`s so progress
   reaches the UI through the existing realtime path.
4. Never grant network access unless the task requires it, and never mount paths
   outside the sandbox root.

## Cost and limits

`AI_DEFAULT_LIMITS`: 60 s timeout, 4096 output tokens, 50 000 micro-USD (5 cent) per
run. Every provider must refuse to exceed the budget it is given.

A run does not use that default: `createAiRunProcessor` passes
`min(ai.maxOutputTokens, ai_model.maxOutputTokens)` with every turn, so the
admin setting is the effective ceiling and a model that caps its own output
lower still gets a request it can answer. The default only applies to callers
that pass nothing (and the compaction summary and image descriptions pass their
own, smaller limits).

## Tests

`packages/ai/src/mock-provider.test.ts`: capabilities, event order, monotonic
sequence numbers, streamed text equals generated text, usage reporting,
cancellation mid-stream, question echo, registry default, and the
`[[call:<toolName>]]` marker (requests a tool call, then answers in plain
text once a `tool` message is present).

`packages/ai/src/token-estimate.test.ts`: zero for an empty string, monotonic
in length, per-message overhead counted once per message.

`packages/ai/src/vision-preprocessor.test.ts`: request shaping (base64 data URI
in an `image_url` content part), error handling, and the registry's
configured/unconfigured gate.

`apps/api/src/ai/chat-commands.test.ts`: known commands with and without an
argument, an unknown command and a path-like message both fall through to
prose, a message without a leading `/` is prose.

`apps/api/src/ai/conversations.service.test.ts` (real Postgres/Redis):
create/get/list scoped to the caller, ownership enforced on every route
(including reads), `postMessage` persisting the user message and enqueuing a
run, the `ai_conversation_locked` guard, and every slash command including
the `/think` clamp message. Two of these post an ordinary (non-command)
message, which really does enqueue an `ai` job the live worker on this shared
host will pick up and run for real (a cheap model, a short message) — the
assertions only check what `postMessage` returns synchronously or fields
unrelated to run status, specifically to stay correct despite that race.

`apps/worker/src/processors/processors.integration.test.ts` ("ai runs", real
Postgres/Redis): describes a document image and prepends it as context,
leaves messages untouched when a page has no images, completes the run even
when a referenced attachment cannot be resolved; a conversation-backed run
executes a tool call through a stub `ToolRunner`, persists the `ASSISTANT` +
`TOOL` messages and completes with the follow-up turn's text;
`ai.maxToolIterations: 0` fails with `ai_tool_limit_exceeded`; `compactIfNeeded`
summarizes older messages into one summary message and leaves the recent
tail active, and does nothing when already within budget; the
attachment-text processor marks a PNG `NOT_APPLICABLE` and fails clearly when
no extractor is configured.

The end-to-end path is covered by `e2e/tests/ai.spec.ts` → "streams a response from
the mock provider through the realtime channel".
