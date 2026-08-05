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
  implemented, but the adapter refuses to run without `OPENROUTER_API_KEY` so it can
  never silently start making paid calls. **No document content is sent to any
  external provider at this stage**: only the messages the user typed are part of a
  run, and the default provider is local.

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

`AI_DEFAULT_LIMITS`: 60 s timeout, 2048 output tokens, 50 000 micro-USD (5 cent) per
run. Every provider must refuse to exceed the budget it is given.

## Tests

`packages/ai/src/mock-provider.test.ts` (8 tests): capabilities, event order,
monotonic sequence numbers, streamed text equals generated text, usage reporting,
cancellation mid-stream, question echo, registry default.

The end-to-end path is covered by `e2e/tests/ai.spec.ts` → "streams a response from
the mock provider through the realtime channel".
