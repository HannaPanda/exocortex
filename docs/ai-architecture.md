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

- `MockAiProvider` — deterministic, streams word by word, echoes the question and
  reports usage. It is the default (`AI_PROVIDER=mock`).
- `OpenRouterProvider` — request shaping, SSE parsing and usage mapping are
  implemented; the adapter refuses to run without `OPENROUTER_API_KEY` so it can
  never silently start making paid calls. `OPENROUTER_DEFAULT_MODEL` is the main
  driver (currently `z-ai/glm-5.2`, text-only, no vision).

## Embeddings

`EmbeddingProvider` (`packages/ai/src/embedding-provider.ts`) is a contract of
its own, not a degenerate `AiProvider`: an embedding model does not chat, has no
tools, no streaming and no finish reason. It turns a batch of texts into a batch
of vectors, in order, and refuses a response that is missing one rather than
misaligning page A with page B's vector.

- `OpenRouterEmbeddingProvider` — `POST {baseUrl}/embeddings`, OpenAI-shaped,
  the same key and account as everything else. `dimensions` is sent so a model
  with a longer natural output can shorten to the 1536 the column holds.
- `MockEmbeddingProvider` — hashes vocabulary into a normalised vector. Not
  semantics, but it makes the whole pipeline exercisable offline and in tests,
  the same reasoning as `MockImageGenerator`.

`createEmbeddingProvider` returns `null` without a key, and `null` means "the
feature is unavailable", not "something broke". What consumes it is
`HybridSearchAdapter` in `packages/database`, through the `EmbeddingClient`
port and the `createEmbeddingClient` bridge — see ADR-020 and
`docs/architecture.md`.

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
companions" below for how the companion _model_ is now chosen per run rather
than fixed to `OPENROUTER_VISION_MODEL`.

## Image generation (page covers)

Drawing a picture sits outside the `AiProvider` contract for the same reason
vision preprocessing does (ADR-012): the general chat path stays
provider-neutral and text-only, and a capability one provider and one model can
serve does not belong in the interface every provider must implement.

`packages/ai/src/image-generator.ts` defines `ImageGenerator` with two
implementations: `OpenRouterImageGenerator` (an ordinary chat completion asked
for the `image` modality, which answers with the picture inline as a data URI)
and `MockImageGenerator` (a solid-colour PNG built in memory, deterministic per
prompt, so a deployment without an account can still be developed and tested
against). `createImageGenerator` returns `null` unless both an API key and
`ai.imageModelSlug` are present — the same safety gate as
`createVisionPreprocessor`, so nothing paid can start by accident. `null` means
"the feature is off", never "something broke".

The prompt reaches the model as the user wrote it, followed by a fixed framing
hint (wide banner, no text, nothing important near the edges) because that is
what a cover is. Nothing about the page's content is sent: the user's words are
the whole prompt.

The flow: `POST /api/documents/:id/cover/generate` checks the edit permission
and both settings, then queues a `document-cover` job and answers `pending`.
`createDocumentCoverProcessor` draws the picture and installs it by posting it
to `POST /api/documents/:id/cover` with a service token minted for the
requesting user, so the generated file passes the ordinary permission and
magic-byte checks and gets the ordinary downscaling. The finished cover reaches
the browser as `document.updated`; `document.cover.generated` carries the
outcome, with a German reason when it failed. One attempt only — a retry would
be a second paid image.

## Conversations and messages

`AiConversation` / `AiConversationMessage` (Prisma) are the persistent side
panel chat history that replaces re-submitting the whole transcript on every
request. The model, title, reasoning level and vision companion override
live on the conversation; every turn — user, assistant, tool, and compaction
summaries — is its own `AiConversationMessage` row.

- **`supersededAt`.** Set by `/clear` and by auto-compaction. A superseded
  message stays in the table and in the UI's history (it is still "what
  actually happened"), but the worker never sends it to the provider again —
  only `supersededAt: null` rows enter the message list a run builds
  (`apps/worker/src/processors/ai-run.ts`).
- **Why the transcript lives in the database, not on `AiRun.messages`.** A run
  is one turn; a conversation is many. Keeping the transcript on the
  conversation means the worker always reads the current, possibly-compacted
  state instead of trusting a copy the API embedded at enqueue time —
  `ConversationsService.postMessage` (`apps/api/src/ai/conversations.service.ts`)
  stores only the just-submitted user message on the `AiRun` row, for
  traceability, and the worker rebuilds the real message list from
  `AiConversationMessage` every time.
- **Ownership.** A conversation is personal, not shared, even inside a shared
  workspace: every route on it, reads included, requires the caller to be its
  own creator (see the class comment on `ConversationsService`) — a
  deliberate widening of "ownership required for writes", documented there.
- **Slash commands** (`/clear`, `/new`, `/model`, `/think`, `/vision`,
  `/compact`, `/context`, `/rules`, `/tools`, `/help`) are parsed server-side
  (`apps/api/src/ai/chat-commands.ts`) so the side panel, MCP and any future
  client behave identically without reimplementing the command set.

### Finding a conversation again — the `/chats` area

Until issue #69 the transcript was the one thing in eXocortex that could be
written and never retrieved: the panel's dropdown showed the twenty most recent
titles of one workspace, `GET /api/ai/conversations` answered with every row it
had, and nothing searched the messages. Archived conversations were reachable
only by a query parameter no client sent.

Chats now have their own top-level area, `/chats`, beside `/gedaechtnis` and
`/entitaeten` — deliberately _not_ a virtual workspace. Three reasons, and each
of them is a rule this repository would otherwise have to bend: a workspace is
shared where a conversation is personal, a workspace holds `Document`s with Yjs
state (ADR-004/005) where a conversation is an append-only list of rows, and
`Workspace.isMemory` (ADR-023) is meant to stay the single special case.

- **Listing.** `ConversationArchiveService.list`
  (`apps/api/src/ai/conversation-archive.service.ts`) pages by a cursor over
  `(lastMessageAt, id)` — the sort key, not an offset, so a conversation touched
  while the list is open cannot shift a page boundary and hide a row.
  `workspaceId` is optional: without it the list spans every workspace the
  caller is a member of. `documentId` narrows to the chats of one page, and
  `archived` is three-valued (`open`, `archived`, `all`). Each row carries
  `documentTitle` and a `preview` — the first user line, collapsed and cut — so
  the list needs no query per row.
- **Search.** `GET /api/ai/conversations/search` runs PostgreSQL full-text over
  the messages and answers per conversation with a `ts_headline` snippet and a
  match count. The index is a generated `tsvector` column on
  `ai_conversation_message` with a GIN index
  (`20260917100000_conversation_message_search`), not a projection table with an
  indexing job like `DocumentSearchIndex`: a message is already plain text when
  it is written, so there is nothing to materialize and nothing that can fall
  behind. Retired messages (`supersededAt`) stay searchable — they are exactly
  what somebody is looking for when a compaction replaced them. Semantic search
  is deliberately out of scope; full text answers "the chat about nginx".
- **Deleting for good.** `DELETE /api/ai/conversations/:id/permanent` removes
  the conversation and its messages. The `AiRun` rows are _pruned_, not deleted:
  `messages` and `resultText` are emptied and `payloadsPrunedAt` is stamped,
  exactly as the retention sweep already does, and the run is detached from the
  conversation. A run row is two things at once — a copy of the transcript and a
  line in the deployment's cost ledger — and deleting it would quietly reduce a
  figure an administrator is accountable for. Nothing of what was said survives
  either way.
- **Saving a chat as a page.** `POST /api/ai/conversations/:id/to-page`
  serializes the transcript (`apps/api/src/ai/transcript-markdown.ts`) and
  writes it through `DocumentsService` and `DocumentContentService`, so it
  passes the same permission checks, lands in the same outbox and reaches an
  open editor through the collaboration server (ADR-016). The parent is chosen
  by the caller, with candidates from the same `suggest-parent` endpoint
  `exo_page_suggest_parent` uses. The conversation itself stays a list of rows.
- **The panel.** The dropdown now offers the five most recent conversations and
  a link to `/chats`; `/chats?fortsetzen=<id>` and the "Im Panel fortsetzen"
  button do the reverse — write the panel's per-workspace `localStorage` key
  (`apps/web/src/components/ai/panel-state.ts`), open the context panel, and
  navigate to the page the conversation was standing on.
- **On the agent surfaces.** `exo_chat_list`, `exo_chat_search` and
  `exo_chat_read` (`packages/mcp-tools/src/tools/chats.ts`), all read-only. The
  catalogue's blanket exemption for `/api/ai/conversations*` was narrowed to the
  writing routes: an agent starting a conversation from inside one is a loop, an
  agent searching its own past is the opposite of one.

## Page context

The chat knows which page it is standing on. `AiRun.documentId` used to reach
only the vision preprocessor, so a page's images were described to the model
while its title was not even mentioned; now the run's page is named in the
system prompt.

- **A pointer, not the content.** `buildSystemPrompt`
  (`apps/worker/src/system-prompt.ts`) appends a `## Geöffnete Seite` block
  with the title, breadcrumb, `documentId` and type (page or collection), and
  tells the model to fetch the body with `exo_page_read` when the question is
  about "this page". The page's text stays out of the prompt of every
  unrelated turn, and fetching it stays under the user's `ai.toolsEnabled`
  control.
- **…unless `ai.pageContextEnabled` is on**, which puts the page's materialized
  Markdown into the block as `### Inhalt`. **Default off**, and the only switch
  here that sends document content the user did not ask for in that turn — see
  [ADR-015](adr/ADR-015-page-content-in-the-prompt.md) for why it exists anyway
  (a tool-less model has a pointer it cannot follow). Capped by
  `ai.pageContextMaxChars`, and a cut says so _in the prompt text_, worded
  differently depending on whether the run can fetch the rest: a model that
  cannot tell an excerpt from a whole page answers "the page does not mention
  X" about a page that does. Collections are excluded — their body is empty by
  construction and the view description is the richer answer.
- **Honest when it cannot follow the pointer.** Tool availability is resolved
  _before_ the prompt is built, so a run without tools (setting off, model
  without tool support, or a legacy run with no `conversationId`) gets a block
  that tells the model to say it cannot read the page instead of inventing its
  content.
- **Scoped to the run's workspace.** The lookup is `findFirst` on
  `{ id, workspaceId }`: a stale or guessed `documentId` contributes nothing
  and is logged, rather than leaking a title from elsewhere.
- **The breadcrumb is bounded.** Ancestors are walked up at most
  `MAX_PATH_DEPTH` (8) levels; a deeper path is rendered with a leading `…`
  so an elided path is not mistaken for a root-level one.
- **Page switches are recorded in the transcript.** The panel keeps the active
  conversation per _workspace_, so walking to another page keeps typing into
  the same transcript. `ConversationsService.postMessage` compares the turn's
  page against `AiConversation.documentId` and, if the conversation already
  has messages, writes a `SYSTEM` message (`↳ Kontextwechsel: …`) immediately
  before the user message that caused it, then rebinds the conversation.
  Without it, everything above the switch would silently refer to a different
  page than everything below.
- **Absent and `null` mean different things.** An omitted `documentId` in
  `postConversationMessageRequestSchema` means "this client does not track
  pages" and inherits the conversation's binding (MCP, scripts); an explicit
  `null` means "the user is somewhere without a page" and clears it. Treating
  both alike would make leaving a page impossible.
- **Visible and revocable.** A chip above the composer names the open page, and
  removing it is not cosmetic: it flips `AiConversation.pageContextEnabled`, and
  the run then carries no `documentId` at all. `/context` reports the same state
  and `/context on|off` sets it. The rule the panel promises is "what stands in
  the chip row goes out, what does not stand there does not" — which is why the
  switch marker below is suppressed along with everything else while the context
  is off: the marker names the page and is itself a disclosure.
- **Standing on a page and disclosing it are separate.** `documentId` keeps
  recording where the user is even while the context is off, so `/context on`
  has something to turn back on and the panel does not forget its place. Only
  `AiRun.documentId` is emptied.
- **A database page is described, not pointed at.** A collection is a shape, not
  a text: `exo_page_read` on one returns nothing useful. So `describeCollection`
  (`apps/worker/src/collection-context.ts`) renders its columns with their types
  and selectable options, the open view's filters and sorts in German with ids
  resolved to names, and the first 10 rows that view actually produces —
  through `queryDatabaseRows`, the same engine the table on screen uses, so the
  description and the screen cannot drift apart. Everything past those rows is
  `exo_database_query`'s job, and the block says so.
- **The open view travels with the run.** `AiRun.databaseViewId` exists because
  rows only mean something through a view's filters: describing the page without
  the view would describe a different table than the one on screen, and "how
  many are still open" would answer about the wrong set. The full-page database
  publishes its resolved view into `DocumentSessionProvider`
  (`onActiveViewResolved`), the panel sends it, and the API verifies it belongs
  to the disclosed page before storing it. An embedded database does not
  publish: it is a block inside a page, not the page.
- **A selection is handed over, not sent.** The editor's bubble menu has "An KI
  schicken": it puts the selected text and the block ids the range touches
  (`collectBlockIdsInRange`, `packages/editor/src/block-id.ts`) into a small
  React context (`apps/web/src/components/ai/ai-selection.tsx`), opens the
  panel, and shows a chip. Nothing leaves until the next message is submitted,
  and the chip is cleared afterwards so the passage is not silently attached to
  every following question. A selection taken from another page is dropped
  rather than carried along, because out of context it is an unlabelled quote.
- **The selection lands in the transcript, not in one run's prompt.** It becomes
  a `SYSTEM` message (`↳ Ausgewählter Abschnitt …`) right before the question it
  belongs to, so the user can see exactly what was sent, later turns can refer
  back to it, and `/clear` and auto-compaction treat it like any other message.
  It is capped at `MAX_SELECTION_CHARS` (4 000) and the cut is stated _in the
  text_, so the model can tell an excerpt from the whole thing. This is document
  content leaving the system — but content the user picked, saw in a chip and
  sent on purpose, which is why it goes even when the page context is off.
- **The id is checked.** Because the title and path now reach the prompt, a
  `documentId` named by the caller is verified through
  `WorkspaceAccessService.findDocumentContext` and must belong to the
  conversation's workspace; otherwise the request fails with
  `document_access_denied`. A page the conversation was merely _bound to_
  earlier and that has since been deleted degrades to "no page" instead,
  so a dead binding cannot lock a user out of their own transcript.

## Pinned sources (issue #75, ADR-043)

The open page answers "this page here" and nothing else: it is rebound the
moment a turn arrives from somewhere else, which is right for the question it
answers and useless for a question about three pages at once. Beside it a
conversation can therefore carry **pinned sources** of its own, and those stay
until they are taken away.

- **A row, not a copy.** `AiConversationSource` names a page, a database view
  or a saved query, and a `targetKey` (`page:<id>`, `view:<doc>:<view>`,
  `query:<id>`) is what the unique index deduplicates on -- a unique over the
  three nullable ids would never fire, because in PostgreSQL two NULLs are
  distinct. Every target cascades on delete: a reference to a deleted page is
  not a source.
- **Named by default, embedded on purpose.** `REFERENCE` puts the title and the
  id into the prompt together with the tool that fetches it, which costs
  nothing and is enough for a tool-capable model. `EMBED` puts the text there
  on every turn, and that is a second decision made on the chip itself. The
  menu behind the plus always pins as a reference.
- **One shared budget, split evenly.** `ai.pinnedContextMaxChars` (24 000 by
  default) is divided by the number of embedded sources while the prompt is
  built, with a floor of 600 characters under one share. Spending it in order
  would let the first long page eat it and leave the rest as empty headings.
  `ai.maxPinnedSources` (8) caps the count, and zero switches pinning off for
  the workspace. Both are workspace-overridable and clamped by the deployment.
- **A cut is stated in the text.** Same rule as the open page's: a model that
  cannot tell an excerpt from a whole page answers "that is not in there" about
  something that is. The sentence differs by whether the run has tools, because
  without them the pointer to the rest is not actionable.
- **A database view is described, not read.** `describeCollection` renders it,
  the same function the open page's block uses -- which is why that function
  now lives in `@exocortex/database` rather than in the worker.
- **A saved query is run, bounded at 15 rows.** The answer moves between turns,
  which is the point of pinning a question rather than a page, and also why
  `REFERENCE` is the sensible mode for one.
- **One renderer, two callers.** `renderConversationSources`
  (`packages/database/src/conversation-source.ts`) produces the characters;
  `ConversationSourcesService` calls it to answer
  `GET /api/ai/conversations/:id/sources`, and `buildSystemPrompt` calls it to
  build the `## Angeheftete Quellen` block. The chip row promises a size, and a
  promise made by a second measurement would be about a different text.
- **The chip row is the whole promise.** Above the composer stand the handed-over
  selection, the open page and every pinned source, each with what it costs;
  the plus opens a command menu over pages, the open database's views and the
  workspace's saved searches, and the ⋯ menu on a chip switches its mode or
  unpins it. `/context` reports the same state in words.
- **On the agent surfaces.** `exo_chat_context` reads the list on both. The
  three writing routes stay exempt from the catalogue with a written reason:
  what a conversation carries is the person saying what leaves their workspace,
  so a run that could pin a page would be widening its own context from inside
  itself (the argument ADR-030 makes about `ai.untrustedContentPolicy`).

## Tool calling

Conversation-backed runs (never the legacy `messages`-only path) can call the
same `exo_*` tool catalogue the external MCP server serves
(`@exocortex/mcp-tools`, see `docs/mcp.md`).

- **Authorization stays in `apps/api`.** The worker mints a short-lived
  `exos_`-prefixed service token for the run's own user
  (`packages/auth/src/service-token.ts`, D3) and calls the REST API through it
  (`apps/worker/src/tool-runner.ts`). There is no privileged path: a tool call
  can do exactly what that human could do through the API, nothing more.
- **The loop.** `createAiRunProcessor` streams a turn, and if the model
  requested tool calls, persists the assistant turn (with `toolCalls`,
  verbatim as the provider returned them) and runs each call **sequentially**
  — never in parallel, so two mutating calls to the same document cannot
  race — publishing `ai.run.tool_call`
  (`started` / `succeeded` / `failed` / `refused`)
  around each one and persisting its result as a `TOOL` message before
  looping again. Only the final, tool-call-free turn's text becomes
  `run.resultText` and the `ai.run.completed` payload; it is also persisted
  as the conversation's closing `ASSISTANT` message, since otherwise the next
  user message would build its context from a transcript silently missing
  the assistant's own reply.
- **Caps.** `ai.maxToolIterations` (default 8) and `ai.budgetMicroUsdPerRun`
  (summed from every turn's reported usage) stop a runaway loop with
  `ai_tool_limit_exceeded` / `ai_budget_exceeded`. `ai.mutatingToolsEnabled`
  gates whether write tools are offered at all, and
  `ai.untrustedContentPolicy` decides what a run may still change once it has
  read content from outside this deployment (see below).
- **A truncated turn is never a finished turn.** The `done` event's
  `finishReason` reaches `TurnResult`, and `'length'` (the output cap ended the
  turn) is handled explicitly: a cut-off text answer is picked up with a
  continuation prompt and the pieces are joined into one result, a cut-off tool
  call is reported as `ai.run.tool_call` `failed` and retried with the
  instruction to write long content in several `append` calls. After
  `MAX_TRUNCATION_RETRIES` (3) the run fails with `ai_response_truncated`.
  Without this a run could announce a write, get cut off mid-arguments, write
  nothing and still be stored as `COMPLETED`.
- **A tool call that never arrived completely fails loudly.** A call without an
  id or a name cannot be executed and would produce an assistant message the
  adapter has to drop on the next request; it is published as
  `ai.run.tool_call` `failed`, and a turn left with no runnable call fails with
  `ai_tool_call_invalid`.
- **A tool error is never a thrown exception.** `ToolRunner.run` always
  returns `{ text, isError }` — an unknown tool, invalid JSON arguments, an
  `ExocortexApiError` or a zod validation failure all become a `tool` message
  the model can see and react to, instead of crashing the run.
- **Unavailable without a service token.** `SERVICE_TOKEN_SECRET` is optional
  (R2); when unset, tools are simply off and the worker logs one warning per
  process instead of per run.

## Foreign content and the trust boundary (ADR-030)

The external MCP surface asks twice before an irreversible write, and both
clients behind it ask a human anyway. The built-in loop has neither: it executes
what the model asked for. That is defensible only while every sentence in the
context was written inside this deployment. An extracted PDF, a described image,
a fetched web page (issue #26) and later a mail body are not: somebody outside
gets to put text in front of a model that holds write tools.

Two mechanisms, both defined in `packages/contracts/src/ai-trust.ts` so they
cannot drift apart, and applied in `apps/worker/src/tool-runner.ts`, which is
the single funnel every tool call of the built-in loop passes through.

- **Foreign text is fenced.** `fenceUntrustedContent` wraps the result between
  `<<<FREMDINHALT …>>>` and `<<<ENDE FREMDINHALT>>>`, naming the origin and the
  source, and the system prompt carries `UNTRUSTED_CONTENT_SECTION` telling the
  model that everything between the markers is data. The document is truncated
  first and fenced afterwards, so the closing marker survives a result that ran
  into `MAX_RESULT_CHARS`. This is a hint, not a control: it is still a string
  the model reads.
- **A mutating call is refused.** `decideMutation` decides outside the model,
  from `ai.untrustedContentPolicy` and the origins the run has read so far.
  `guarded` (the default) allows writes until the run reads foreign text and
  refuses them afterwards; `deny` never offers a mutating tool in the first
  place, so the model does not spend a turn proposing one; `allow` is the
  declared exception for a workflow whose job is to read foreign documents and
  write about them. A workspace may be stricter than the deployment and never
  looser (`SETTING_VALUE_RANKS`, ADR-023).

What counts as foreign is declared per tool, as `untrustedOutput` on the
catalogue entry (`packages/mcp-tools/src/tool.ts`): today
`exo_attachment_read_text`, `exo_web_search` and `exo_web_fetch`. The search
result counts as much as the page does -- a title and a snippet are written by
whoever owns the page. The vision preprocessor is the one path that
bypasses the tool loop: it describes images out of an uploaded file before the
first turn, so `ai-run.ts` notes the origin on the runner directly and
`images.ts` fences the description.

A refusal is published as `ai.run.tool_call` with status `refused` — its own
status rather than `failed`, because the two mean opposite things to whoever is
watching — and the model is handed a German sentence saying why and asking it to
report what it would have written. `/tools` in the chat names the active policy
for the same reason: the question after a refused write is always "why".

## Reasoning levels

`AiReasoningLevel` (`NONE`/`MINIMAL`/`LOW`/`MEDIUM`/`HIGH`/`XHIGH`/`MAX`) is resolved and
clamped server-side against the selected `AiModel` row's `reasoningLevels`
(`AiModelResolverService.clampReasoningLevel`,
`apps/api/src/ai/ai-model-resolver.service.ts`) — a client can request a
level the model does not support (or does not have selectable at all, e.g.
Haiku 4.5's single-element `[NONE]`) and gets the closest supported level
back instead of an error. `/think` reports in German when this happened. The
clamped level becomes `OpenRouterProvider`'s `reasoning.effort` parameter
(omitted entirely for `NONE`). The clamping itself lives in
`clampReasoningLevel` (`packages/contracts/src/ai-models.ts`) because the
browser needs the same answer: the picker must not display a remembered `high`
on a model that cannot think.

Which levels a model offers is not guessed: `deriveReasoningLevels`
(`apps/api/src/admin/ai-models.service.ts`) believes
`reasoning.supported_efforts` out of the provider's model list whenever the
entry carries it, and only falls back to the older heuristic (`reasoning_effort`
in `supported_parameters`, plus `MINIMAL` for OpenAI) when it does not. That is
how `XHIGH` and `MAX` became reachable, and how the next level will: an effort
name with no enum value is dropped rather than approximated, and `NONE` is
always offered, because "do not think" is a choice no model can take away. A
registry row only learns about a new level once it is synced.

The chosen model and level are remembered per workspace in `localStorage`
(`useModelPreference`, `apps/web/src/components/ai/model-choice.ts`). A
conversation stores both on its own row, but only once it exists, and it only
exists after the first message — without the preference a choice made in an
empty panel died on the next reload, and every new conversation started over at
the deployment default and `NONE`. The row still wins for a conversation that
has started; the preference is what seeds the next one.

## Provider routing (ADR-032)

A model on OpenRouter is served by many providers at once, and they disagree
about it: GLM 5.3 comes with a 262k window from one and 1.05M from most others,
at prices between $0.88 and $2.10 per million input tokens. The registry keeps
one `AiModelEndpoint` row per provider per model, refreshed by
`sync-ai-model-routes` and by the admin sync, and the worker plans from it
before every turn:

1. `planRoute` (`packages/ai/src/route-planner.ts`) keeps the providers whose
   usable window takes the estimated prompt plus the reserved answer, whose own
   input and output caps allow it, and which support what the run needs (tools,
   effort levels). The usable share is `ai.compactionThresholdPercent`.
2. The keys go out as `provider.only` with `allow_fallbacks: true`. No `sort`
   and no fixed order: ranking inside the eligible set, and failover between
   them, stay OpenRouter's job.
3. Nothing eligible means the run compacts and re-plans -- but only when a
   smaller prompt would change the answer (`couldCompactionHelp`). A refusal
   caused by a missing capability is not a size problem.
4. Still nothing eligible fails the run locally with `ai_no_eligible_provider`,
   before paying for a request that would come back 404.

A model without a snapshot sends no provider preference at all, which is what
every request did before this existed.

## Auto-compaction

`compactIfNeeded` (`apps/worker/src/compaction.ts`) runs before every
provider call on a conversation-backed run. Its budget is the largest prompt any
eligible provider would take (ADR-032), not the model's own window:

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
is handed an ordered _chain_ of them rather than a single one:

| Engine                                       | Where                                                        | Reads scans       | Cost                                                              |
| -------------------------------------------- | ------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------- |
| `docling` (`packages/ai/src/docling.ts`)     | local `docling-serve` container                              | yes, via RapidOCR | nothing per document, ~1.5 s CPU per page                         |
| `openrouter` (`packages/ai/src/pdf-text.ts`) | hosted, `file-parser` plugin with the free `pdf-text` engine | no                | billed per page: the whole document comes back as _output_ tokens |

**Docling is the default** (`ai.pdfExtractor`). The `pdf-text` parser itself is
free, but it runs inside a chat completion, so the transcribed document is
charged as output tokens — about 4 to 5 cents for a 33-page PDF at
`z-ai/glm-5.2` rates, growing with document length. The local engine costs
nothing per document _and_ reads scans, so the hosted one is the fallback, not
the first choice. It stays selectable because a deployment without the
container needs some way to read a PDF at all.

`ai.pdfExtractorFallbackEnabled` (default on) appends the other engine behind
the chosen one, in either direction. That chain is the point of the design: a
`null` from an engine means "found nothing", which for a scan meeting the
OpenRouter engine is routine, so the next engine gets the same document before
the attachment is written off. Measured on the same three-page scan: 0
characters without OCR, 8 378 with it. A _thrown_ error no longer ends the
chain either — a hosted call timing out is exactly when the local engine should
get its turn — but a run in which _every_ engine threw rethrows, so BullMQ
retries instead of recording "no text layer".

Docling runs with a fixed option set (`do_ocr: true`, `force_ocr: false`,
markdown plus JSON output). Two reasons it is a constant and not a setting:
docling-serve caches one pipeline per distinct option set and building one costs
about 18 seconds, and forcing OCR measurably _loses_ text on a document that
already has a text layer (7 549 vs 9 278 characters over three pages). Verified
against docling-serve 1.29.0 on 2026-08-06.

### Metadata

`Attachment.textMetadata` caches what is known about the document, shaped by
`pdfMetadataSchema` in `@exocortex/contracts`. Three sources see disjoint parts
of it, which is why the processor merges _every_ attempt rather than only the
winning one:

|                                            | title, author, creator, producer, dates    | pages | tables, pictures | confidence | OCR used     |
| ------------------------------------------ | ------------------------------------------ | ----- | ---------------- | ---------- | ------------ |
| `pdf-info` (`packages/ai/src/pdf-info.ts`) | yes, from the PDF's own `/Info` dictionary | yes   | no               | no         | no           |
| `docling`                                  | no                                         | yes   | yes              | yes        | yes          |
| `openrouter`                               | yes, as transcribed by the plugin          | yes   | no               | no         | always false |

**`pdf-info` is not an engine.** It reads the `/Info` dictionary out of the
file with `pdf-lib`, locally and for free, before any engine runs, and it never
produces text — so it deliberately does not implement `PdfTextExtractor` and
does not count towards the processor's "is any engine configured" check.

It exists because the dictionary used to be reachable _only_ through the paid
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

- `GET /api/attachments/:id/text` returns the text and the metadata, and a read
  _is_ the request to extract — a PDF that was never attempted, or whose last
  attempt failed, is (re-)enqueued.
- `GET /api/attachments/:id/text/info` returns everything except the text and
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

## Web research (issue #26, ADR-033)

Two capabilities, two tools, two back ends, and the split between them is the
point: `exo_web_search` finds addresses, `exo_web_fetch` reads one of them. A
merged "research this" would fetch every hit it found; split, the model reads
eight snippets and pays for the two pages that look like answers.

| Half   | Back end                         | Client                       | Environment        |
| ------ | -------------------------------- | ---------------------------- | ------------------ |
| search | SearXNG (self-hosted metasearch) | `packages/ai/src/searxng.ts` | `SEARXNG_BASE_URL` |
| fetch  | Steel (headless Chrome, REST)    | `packages/ai/src/steel.ts`   | `STEEL_BASE_URL`   |

Both clients are optional in the same sense Docling is: unset base URL, no
client built, and the route answers `web_research_unavailable` instead of
failing somewhere deeper. `ai.webResearchEnabled` defaults to **off** on top of
that, because outgoing traffic to addresses a model picks is not something an
update may quietly start doing on somebody's server.

`apps/api/src/research/` is the only thing that talks to either back end. The
catalogue calls `POST /api/workspaces/:workspaceId/research/{search,fetch}` like
every other tool (ADR-014), so external MCP clients get web research at the same
moment the built-in AI does.

### The address check

`public-address.ts` refuses a scheme other than `http`/`https`, and any address
whose **resolved** IPs are not globally routable -- including a name that does
not resolve at all out here, because that is the ordinary shape of an internal
one. It runs before Steel sees the URL and again on the address Steel reports it
ended up at, since a redirect is the cheapest way past a check that only reads
what was typed.

This is not belt and braces. Steel runs in this host's Docker network, so a
fetch starts inside the perimeter: nginx and fail2ban never see it, and
`http://grafana:3000/` is answered. Two limits are known and written down rather
than implied: DNS rebinding is out of reach without an egress firewall around
the container, and our own back ends (SearXNG, Steel, both on loopback) are
deliberately not subject to the rule -- it guards a parameter a model supplied,
not the outgoing HTTP layer.

### Budgets and what comes back

`ai.webResearchMaxChars` caps one page and the answer says `truncated` rather
than pretending. `ai.webResearchMaxFetchesPerRun` is counted in
`tool-runner.ts`, because only the loop knows what a run is; at zero the fetch
tool leaves the catalogue instead of refusing every call, and the count is spent
on the attempt, so a broken address cannot be retried for ever.
`ai.webSearchMaxResults` caps a result list.

A search answer carries `unresponsiveEngines`. SearXNG scrapes the engines
itself, and from a datacentre address some of them answer with a CAPTCHA
(DuckDuckGo does from this host, measured 2026-09-18). Without that field a
throttled engine and a genuinely rare topic produce the same short list.

## Known limitations

- **`/compact` is advisory only.** Running it from the API process would
  call a provider from inside `apps/api`, which the execution boundary above
  forbids. It reports that auto-compaction happens automatically instead;
  `/clear` covers the case where the user wants the context gone
  immediately.
- **Reasoning deltas are dropped.** `OpenRouterProvider.stream` deliberately
  discards `delta.reasoning` chunks rather than folding them into
  `resultText` — surfacing model "thinking" is a later feature.
- **`POST /api/documents/:id/content` can lose against a live Hocuspocus
  session.** A document being edited collaboratively has its canonical state
  in memory in `apps/collaboration`; a programmatic content write snapshots
  first (revertable) but can still be overwritten by the next debounced
  store. Documented, not fixed, tonight.
- **`ai.pdfExtractionModelSlug` is not wired into the worker's PDF extractor
  yet.** The extractor is a single boot-time instance built from
  `OPENROUTER_DEFAULT_MODEL`; making the DB setting effective would mean
  rebuilding it per job the way `visionPreprocessorFor` already does.

## Execution boundary (hard rule)

CLI agents must never run inside a process that serves traffic:

- not in `apps/api`
- not in `apps/web`
- not in `apps/collaboration`

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
2. The worker loads the run. A `PENDING` row proceeds; anything else does not
   necessarily mean "already answered" any more (ADR-017): a `RUNNING` row
   with a fresh heartbeat is left alone (another worker is still on it), a
   `RUNNING` row with a stale one is closed out as `FAILED` /
   `ai_run_abandoned` rather than resumed, and everything else (`COMPLETED`,
   `FAILED`, `CANCELLED`, `TIMED_OUT`) is the original idempotency skip. A
   run that proceeds is set `RUNNING`, gets its first heartbeat, and the
   worker iterates `provider.stream(...)`.
3. Each `delta` is published as `ai.run.progress` on the Redis event bus with a
   monotonic sequence number, so clients can detect gaps. The web panel does
   exactly that: a hole in the sequence flips a sticky flag, and the answer is
   reloaded from `GET /api/ai/runs/:runId` instead of being shown incomplete
   (issue #6). That is why the heartbeat also writes `resultText` as the run
   goes: the row always carries the answer as far as it has streamed, so there
   is something authoritative to fall back on.
4. A phase that produces no text of its own is announced as `ai.run.phase`
   (`reasoning`, `compacting`, `generating`). Reasoning fragments are dropped
   by the provider adapter before they become deltas, and compaction only used
   to report itself once it was over, so both looked exactly like a stalled
   run. The payload carries the phase and nothing else: the model's
   working-out and the compaction summary never travel on the event bus.
   Repeats of the same phase are throttled to `AI_RUN_PHASE_MIN_INTERVAL_MS`.
5. On completion the run is stored with `resultText` and `usage`, and
   `ai.run.completed` is published. On failure, timeout or cancellation the
   status (`FAILED`, `TIMED_OUT` or `CANCELLED`) and `errorCode` are stored
   and `ai.run.failed` is published. Every one of these terminal writes is a
   status-filtered `updateMany`, so a race with the maintenance reaper or a
   cancellation can never resurrect an already-ended row.
6. The API's event-bus subscriber re-emits into the workspace room; the panel
   renders the deltas as they arrive.

The panel never relies on that channel alone. For as long as it believes a run
is in flight it polls `GET /api/ai/runs/:runId` every
`AI_RUN_POLL_INTERVAL_MS`, refetches on window focus and on realtime
reconnect, and applies whatever terminal status it finds exactly as the
matching socket event would have (`reconcileAiRun` in
`packages/contracts/src/ai-runtime.ts`). A dropped `ai.run.completed` used to
leave the panel waiting forever, because nothing ever asked.

`POST /api/ai/runs/:runId/cancel` marks a pending or running run cancelled;
the worker notices through its own heartbeat write (a status-filtered
`updateMany` that returns `count === 0` once the row has left `RUNNING`) and
aborts the run's `AbortController`, at most one heartbeat interval later. See
"Time budget of a run" below and ADR-017.

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

`AI_DEFAULT_LIMITS` (`packages/ai/src/provider.ts`) still declares a 60 s
`timeoutMs` field, but nothing reads it: the mock provider takes its own
default, and the OpenRouter adapter never applies it (it only ever forwards
`signal`). Dead, and stated as such here instead of leaving it to be
rediscovered — see "Time budget of a run" below for what actually governs a
run's timing. `maxOutputTokens` and `budgetMicroUsd` on the same object are
not dead: the OpenRouter adapter and the mock provider both read
`maxOutputTokens` as their fallback when a request omits it.

`createAiRunProcessor` passes `min(ai.maxOutputTokens, ai_model.maxOutputTokens)`
with every turn, so the admin setting is the effective ceiling and a model
that caps its own output lower still gets a request it can answer. The
compaction summary and image descriptions pass their own, smaller limits.

`ai.budgetMicroUsdPerRun` is checked after every turn and before every tool
call; a run that would exceed it stops with `ai_budget_exceeded` rather than
placing one more paid call.

## Time budget of a run (ADR-017)

Two settings, one derivation (`deriveAiRunTimeouts`,
`packages/contracts/src/ai-runtime.ts`):

| Setting        | Default    | Governs                                              |
| -------------- | ---------- | ---------------------------------------------------- |
| `ai.timeoutMs` | 180 000 ms | One model answer (one turn).                         |
| `ai.maxRunMs`  | 900 000 ms | The whole run: every turn and every tool round-trip. |

`ai.maxRunMs` can never end up shorter than `ai.timeoutMs` — a run with tools
enabled could otherwise never finish even its first answer — so an admin
setting it lower gets the turn timeout instead.

Everything else a run's clock needs is a fixed constant next to those two,
not admin-configurable because it is infrastructure rather than a product
preference: the heartbeat interval and staleness window a run's liveness is
judged by, the `ai` queue's lock duration and stalled interval (long enough to
never mistake a legitimately slow run for a dead one), the tool-call ceiling,
and the maintenance reaper's grace period on top of the run budget.

Three independent mechanisms end a run that overruns its budget, so "stuck on
`RUNNING` forever" is not reachable from any of them:

1. **The worker's own two `AbortController`s.** A per-turn timer aborts a
   single slow answer; a per-run timer aborts the whole thing once
   `ai.maxRunMs` elapses. Either produces `TIMED_OUT` with `errorCode:
'ai_timeout'`.
2. **The heartbeat as the cancellation channel.** The run writes a
   `heartbeatAt` timestamp every few seconds through a status-filtered
   `updateMany` (`status: 'RUNNING'`); `count === 0` means the row left
   `RUNNING` from outside (`POST /cancel`, or the reaper below), and the run
   aborts itself with `errorCode: 'ai_cancelled'` — no second signalling path.
3. **`reap-stale-ai-runs`**, a repeatable maintenance job
   (`apps/worker/src/processors/maintenance.ts`), for the case the two above
   cannot reach at all: a process that was killed hard enough to never run
   its own cleanup. It closes out a `RUNNING` run whose heartbeat or budget
   has expired (`ai_run_abandoned` or `ai_timeout`) and a `PENDING` run old
   enough that it was evidently never picked up (`ai_run_lost`) — the latter
   is what keeps `ai_conversation_locked` from becoming permanent.

The `ai` queue's `attempts: 1` (`QUEUE_JOB_OPTIONS`,
`packages/queue/src/registry.ts`) is part of the same decision:
`createAiRunProcessor` never throws on a provider or timeout failure, so a
BullMQ retry would only ever fire for an infrastructure error, and retrying an
agentic run pays for the prompt again and can duplicate a write made through
`exo_page_write`, which is not idempotent.

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

`apps/api/src/ai/transcript-markdown.test.ts` (no infrastructure): the
provenance block, an absent fact left out rather than written empty, a retired
message marked rather than dropped, a tool result fenced longer than its own
backticks, and the list cursor's round trip.

`apps/api/src/ai/conversations.service.test.ts` (real Postgres/Redis):
create/get scoped to the caller, ownership enforced on every route
(including reads), `postMessage` persisting the user message and enqueuing a
run, the `ai_conversation_locked` guard, and every slash command including
the `/think` clamp message. For the `/chats` half (`ConversationArchiveService`):
listing across workspaces and narrowed to one, the three archive states, a
cursor walk over rows sharing a `lastMessageAt`, the preview, a search that
matches a word from the transcript rather than the title, a retired message
still findable, a query with no searchable token answering nothing, a permanent
delete that keeps the run's metrics, and saving a chat as a page. Two of these post an ordinary (non-command)
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
